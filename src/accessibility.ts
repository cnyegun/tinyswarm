import { AxeBuilder } from "@axe-core/playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";
import type {
  CheckResult,
  Decision,
  IterationPaths,
  SwarmProfile,
} from "./core.js";
import { EnergyMeter } from "./energy.js";
import { parseFinding, type ParsedFinding, type ScoredFinding } from "./aggregate.js";

type Facts = {
  title: string;
  url: string;
  lang: string;
  headings: { level: number; text: string }[];
  links: { text: string; href: string }[];
  buttons: { text: string }[];
  images: { alt: string; src: string }[];
  landmarks: { tag: string; role: string; label: string }[];
  textSnippets: string[];
};

type AxeCheckInput = {
  id?: string;
  impact?: string | null;
  message?: string;
};

type AxeNodeInput = {
  target?: unknown;
  impact?: string | null;
  html?: string;
  failureSummary?: string;
  any?: AxeCheckInput[];
  all?: AxeCheckInput[];
  none?: AxeCheckInput[];
};

type AxeViolationInput = {
  id?: string;
  impact?: string | null;
  help?: string;
  helpUrl?: string;
  description?: string;
  tags?: unknown;
  nodes?: AxeNodeInput[];
};

const AXE_NODE_SAMPLE_LIMIT = 5;
const AXE_ADDITIONAL_TARGET_LIMIT = 25;
const AXE_TARGET_LIMIT = 240;
const AXE_HTML_LIMIT = 500;
const AXE_FAILURE_SUMMARY_LIMIT = 1200;
const AXE_CHECK_MESSAGE_LIMIT = 300;
const AXE_NODE_CHECK_LIMIT = 8;

const reviewers = [
  { id: "semantic", name: "screen-reader/semantic structure reviewer" },
  { id: "keyboard", name: "keyboard and motor access reviewer" },
  { id: "cognitive", name: "cognitive load and task clarity reviewer" },
  { id: "visual", name: "low-vision, contrast, zoom, mobile reviewer" },
];

const roleCriteria: Record<string, string> = {
  semantic:
    "WCAG 1.1.1, 1.3.1, 1.3.2, 2.4.2, 2.4.4, 2.4.6, 3.1.1, 4.1.2; landmarks; one meaningful h1; heading hierarchy; names/descriptions; alt text; native HTML before ARIA.",
  keyboard:
    "WCAG 2.1.1, 2.1.2, 2.4.1, 2.4.3, 2.4.7, 2.4.11, 2.5.3, 2.5.8; reachability, activation, traps, focus order, visible unobscured focus, target size, and pointer-only behavior.",
  cognitive:
    "WCAG 2.4.4, 2.4.6, 3.2.x, 3.3.x where applicable; clear CTA purpose, labels/instructions, predictable navigation, understandable details, and no destructive rewriting.",
  visual:
    "WCAG 1.4.1, 1.4.3, 1.4.4, 1.4.10, 1.4.11, 1.4.12, 2.4.7, 2.4.13; contrast, text spacing, zoom/reflow, mobile layout, non-text contrast, focus appearance, and visual identity.",
};

const TARGETED_EVIDENCE =
  "Inspect only the files and snippets needed for this phase. Use targeted reads/searches; do not load raw HTML, full axe nodes, or long artifacts wholesale. Open full sidecars only after a compact finding/violation id or target needs missing detail.";

const COMPACT_OUTPUT =
  "Keep outputs compact and deduplicated. Reference finding ids, axe ids, and short element labels; keep evidence snippets brief and do not paste raw HTML, full axe nodes, or long repeated file excerpts.";

// Static cacheable system prompt — sent once per LLM session as the system message.
const FIX_SYSTEM_PROMPT = `\
You are a targeted HTML accessibility fixer. \
Apply the minimum necessary changes to fix the listed findings without touching unrelated code.

## Output format

Respond with exactly one JSON object — no markdown fences, no text outside the JSON.

{
  "patches": [
    {
      "findingId": "string  — the finding ID from the input (e.g. \\"semantic-1\\")",
      "search":    "string  — verbatim substring of the HTML that appears EXACTLY ONCE",
      "replace":   "string  — the replacement text",
      "rationale": "string  — one sentence: what changed and why"
    }
  ],
  "summary":  "string  — 2–3 sentences summarising everything that was fixed",
  "unfixed":  ["string — \\"findingId: reason\\" for findings that could not be safely fixed"]
}

The \`unfixed\` field is optional; omit it if all findings were fixed.

## How SEARCH/REPLACE works

\`search\` must be a **verbatim substring** of the current HTML (exact characters, including whitespace).
It must appear **exactly once** in the file — zero matches or two-plus matches both reject the whole patch set.
If the snippet is not unique, extend it by 1–3 surrounding context lines until it is.

Textual illustration only — NOT the output format:

<<<<<<< SEARCH
<img src="hero.jpg">
=======
<img src="hero.jpg" alt="Team members collaborating around a whiteboard">
>>>>>>> REPLACE

Equivalent JSON patch you MUST produce:

{
  "findingId": "semantic-1",
  "search":    "<img src=\\"hero.jpg\\">",
  "replace":   "<img src=\\"hero.jpg\\" alt=\\"Team members collaborating around a whiteboard\\">",
  "rationale": "Image lacked alt text; added descriptive equivalent per WCAG 1.1.1."
}

## Hard constraints

- Do NOT touch any HTML outside the specific elements named in the listed findings. \
Touching unrelated code = patch REJECTED.
- Preserve all href values, image src attributes, visible text, brand elements, and document \
structure unless a finding explicitly requires changing them.
- Color/contrast fixes must repair the full computed color pair (foreground + background \
together); do not change a single utility token in isolation.
- Maximum 8 patches per response.
- If you cannot construct a unique, unambiguous \`search\` string for a finding, add it to \
\`unfixed\` with a reason. Do not guess.`;

// ---------------------------------------------------------------------------
// Fixer prompt helpers
// ---------------------------------------------------------------------------

function loadAndParseFindings(iterDir: string): ParsedFinding[] {
  const all: ParsedFinding[] = [];
  for (const reviewer of reviewers) {
    const file = join(iterDir, "findings", `${reviewer.id}.json`);
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { findings?: unknown };
      if (!Array.isArray(data.findings)) continue;
      for (const raw of data.findings) {
        if (typeof raw === "string" && raw.trim()) all.push(parseFinding(raw, reviewer.id));
      }
    } catch { /* ignore */ }
  }
  return all;
}

function htmlSearchTerms(location: string): string[] {
  const terms: string[] = [];
  const loc = location.trim();
  const idM = loc.match(/#([a-zA-Z0-9_-]+)/);
  if (idM) terms.push(`id="${idM[1]}"`, `id='${idM[1]}'`);
  const clsM = loc.match(/\.([a-zA-Z0-9_-]+)/);
  if (clsM) terms.push(clsM[1]);
  const tagM = loc.match(/^(img|button|nav|main|header|footer|h[1-6]|input|select|textarea|form|a)\b/i);
  if (tagM) terms.push(`<${tagM[1].toLowerCase()}`);
  for (const m of loc.matchAll(/['"]([^'"]{4,40})['"]/g)) terms.push(m[1]);
  return [...new Set(terms)].filter(Boolean);
}

function extractHtmlSnippetForFinding(lines: string[], finding: ParsedFinding, ctx = 20): string | null {
  const candidates = [
    ...(finding.location ? htmlSearchTerms(finding.location) : []),
    ...(finding.evidence ? [finding.evidence.slice(0, 60)] : []),
  ];
  for (const term of candidates) {
    const lo = term.toLowerCase();
    const idx = lines.findIndex((l) => l.toLowerCase().includes(lo));
    if (idx === -1) continue;
    const start = Math.max(0, idx - Math.floor(ctx / 3));
    return lines.slice(start, Math.min(lines.length, start + ctx)).join("\n");
  }
  return null;
}

function buildSnippetsForFindings(runDir: string, findings: ParsedFinding[]): Record<string, string> {
  const htmlPath = existsSync(join(runDir, "transformed.html"))
    ? join(runDir, "transformed.html")
    : join(runDir, "original.html");
  let htmlLines: string[] = [];
  try { if (existsSync(htmlPath)) htmlLines = readFileSync(htmlPath, "utf8").split("\n"); } catch { /* ignore */ }

  const snippets: Record<string, string> = {};
  for (const f of findings) {
    if (!f.id) continue;
    const s = extractHtmlSnippetForFinding(htmlLines, f);
    if (s) snippets[f.id] = s;
  }
  return snippets;
}

function readAggregateSummary(iterDir: string): string {
  const aggPath = join(iterDir, "aggregate-feedback.json");
  if (!existsSync(aggPath)) return "";
  try {
    const agg = JSON.parse(readFileSync(aggPath, "utf8")) as { summary?: unknown };
    return typeof agg.summary === "string" ? agg.summary : "";
  } catch { return ""; }
}

function loadFixContext(iterCtx: IterationPaths): {
  findings: ParsedFinding[];
  snippets: Record<string, string>;
  aggregateSummary: string;
  total: number;
} {
  const SW: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const findings = loadAndParseFindings(iterCtx.iterDir)
    .sort((a, b) => (SW[b.severity ?? "low"] ?? 0) - (SW[a.severity ?? "low"] ?? 0));
  return {
    findings,
    snippets: buildSnippetsForFindings(iterCtx.runDir, findings.slice(0, 5)),
    aggregateSummary: readAggregateSummary(iterCtx.iterDir),
    total: findings.length,
  };
}

/**
 * Build the per-call user prompt for the fixer LLM.
 * Accepts a pre-loaded chunk of findings (≤5) and their HTML snippets.
 * T2.3 calls this in a loop over chunks; the `fixPrompt` method calls it once
 * with the top-priority slice until the chunked loop is wired.
 */
export function buildFixUserPrompt(
  findings: ParsedFinding[],
  htmlSnippets: Record<string, string>,
  opts: {
    iteration: number;
    totalFindings: number;
    aggregateSummary?: string;
    /** First N chars of the full HTML file — included when structural findings have no element snippet. */
    htmlHead?: string;
  },
): string {
  const { iteration, totalFindings, aggregateSummary, htmlHead } = opts;

  const hdr =
    `## Iteration ${iteration} — fix ${findings.length} finding${findings.length === 1 ? "" : "s"}` +
    (totalFindings > findings.length
      ? ` (${totalFindings} total; highest-priority ${findings.length} in this call)`
      : "");

  const summaryBlk = aggregateSummary ? `\n## Aggregate summary\n\n${aggregateSummary}` : "";

  const findingsBlk = findings.length === 0
    ? "(no structured findings available)"
    : findings.map((f) => {
        const id = f.id ?? "?";
        const lines = [
          `### Finding ${id}  [${f.severity ?? "?"} · ${f.category ?? "?"}]`,
          `Location: ${f.location ?? "(unknown)"}`,
          `Issue: ${f.issue ?? f.raw}`,
          `Suggested fix: ${f.suggestedFix ?? "(see solver-task.md)"}`,
        ];
        const snippet = htmlSnippets[id];
        if (snippet) lines.push(`\nRelevant HTML:\n\`\`\`html\n${snippet}\n\`\`\``);
        return lines.join("\n");
      }).join("\n\n");

  // Include a structural head excerpt when any finding has no element snippet.
  // Structural findings (missing <main>, missing skip-link) need to see the
  // document structure to anchor a valid search string in the full HTML file.
  const missingSnippets = findings.filter((f) => f.id && !htmlSnippets[f.id]);
  const structuralBlk =
    htmlHead && missingSnippets.length > 0
      ? `\n## Document structure (for findings without element excerpts)\n\n` +
        `The following findings have no element-level excerpt. Use the HTML below to\n` +
        `construct a \`search\` string that appears **exactly once** in the full file.\n\n` +
        `\`\`\`html\n${htmlHead}\n\`\`\``
      : "";

  return [
    hdr,
    summaryBlk,
    "",
    "## Findings",
    "",
    findingsBlk,
    structuralBlk,
    "",
    "## Instructions",
    "",
    "Produce a JSON response. Each patch's `search` value must appear **exactly once** in the **full HTML file** being patched (not only in the excerpts shown above).",
    "If a finding's location cannot be uniquely matched, add it to `unfixed` with a reason.",
    "Maximum 8 patches total.",
  ].join("\n");
}

// ---------------------------------------------------------------------------

function fileList(paths: string[]) {
  return paths.map((path) => `- ${path}`).join("\n");
}

function previousIterationDir(runDir: string, iteration: number) {
  return join(runDir, "iterations", String(iteration - 1).padStart(3, "0"));
}

/** Extract finding IDs from the previous iteration's aggregate-feedback.json priorities. */
function loadPriorFindingIds(runDir: string, iteration: number): string[] {
  if (iteration <= 1) return [];
  const aggPath = join(previousIterationDir(runDir, iteration), "aggregate-feedback.json");
  if (!existsSync(aggPath)) return [];
  try {
    const agg = JSON.parse(readFileSync(aggPath, "utf8")) as { priorities?: unknown[] };
    if (!Array.isArray(agg.priorities)) return [];
    const ids: string[] = [];
    for (const p of agg.priorities) {
      if (typeof p !== "string") continue;
      const m = p.match(/(?:^|\s)id=([^\s|]+)/);
      if (m) ids.push(m[1]);
    }
    return ids;
  } catch { return []; }
}

export const accessibilityProfile: SwarmProfile = {
  id: "accessibility",
  artifact: "transformed.html",
  reviewers,
  scan,
  check,
  manualBaseline: () => EnergyMeter.accessibilityAuditBaseline(4.5),
  briefPrompt: ({ runDir }) => ({
    system:
      `You are the swarm orchestrator for an accessibility remediation run. ` +
      `Return your entire response as a single JSON object: {"markdown": "<your full markdown content>"}. ` +
      `Place all markdown in the markdown field with \\n for line breaks. ` +
      `Use WCAG 2.2, WAI Easy Checks, WAI-ARIA Authoring Practices, WebAIM-style pragmatic testing, ` +
      `Inclusive Design Principles, and accessibility usability guidance as references. ` +
      `Treat axe as useful evidence, not a complete evaluation. ` +
      `Be evidence-based. If something is uncertain, mark it as uncertain. No markdown fences outside the JSON field.`,
    user:
      `Write a practical, preservation-focused accessibility brief for specialist reviewers and the fixer.\n\n` +
      `Run directory: ${runDir}\n` +
      `Available files:\n` +
      fileList([
        `${join(runDir, "original.html")} (targeted inspection only)`,
        join(runDir, "facts.json"),
        join(runDir, "axe.json"),
        `${join(runDir, "axe-full.json")} (targeted debugging only after compact axe id/target lacks detail)`,
      ]) +
      `\n\n${TARGETED_EVIDENCE} Prefer facts.json and compact axe evidence before targeted original.html inspection.\n\n` +
      `Write brief.md with these sections:\n` +
      `- Page purpose and user tasks: infer the actual purpose from facts.json and targeted original snippets without inventing a new campaign, event, product, or organization.\n` +
      `- Preservation inventory: list concrete brand/signature elements, section order, copy themes, CTAs, links, image/logo assets, schedule details, judging criteria, sponsor/partner information, and any unique visual tone that must survive remediation.\n` +
      `- Allowed removals: only identify content that may be removed if evidence supports it, such as a Lovable badge, duplicated decorative clutter, inaccessible duplicate controls with an accessible equivalent, or empty generated wrappers. Do not authorize removal of substantive content.\n` +
      `- Initial accessibility evidence: summarize axe violations by id and affected area, plus likely semantic, keyboard, cognitive, and visual risks that need human review.\n` +
      `- Reviewer focus: assign category-specific criteria. Screen-reader/semantic reviewers should check names, roles, landmarks, heading hierarchy, text alternatives, language, reading order, and link purpose. Keyboard reviewers should check focus order, activation, traps, visible focus, target size, skip/bypass needs, and pointer-only behavior. Cognitive reviewers should check task clarity, CTA meaning, form/instruction clarity, content simplification risks, and whether original information remains understandable. Visual reviewers should check contrast, reflow, zoom, spacing, responsive behavior, non-text contrast, focus appearance, and mobile overflow.\n` +
      `- Acceptance bar: passing automated checks is required but not sufficient. Acceptable remediation must improve accessibility while preserving the original page identity and materially all user-relevant content.\n\n` +
      `${COMPACT_OUTPUT}`,
  }),
  findingsPrompt: ({ runDir, iterDir, iteration }, reviewer) => ({
    system:
      `You are an expert web accessibility reviewer. Role: ${reviewer.id} — ${reviewer.name}.\n` +
      `You have NO filesystem access. Respond ONLY with a JSON object — no markdown, no explanation.\n\n` +
      `## Output format\n` +
      `{"role":"${reviewer.id}","findings":["id=${reviewer.id}-1 | category=semantic|keyboard|cognitive|visual|preservation|automated | severity=high|medium|low | confidence=high|medium|low | location=<element/section> | evidence=<observable fact> | issue=<user impact> | suggestedFix=<faithful remediation>"],"risk":"high"}\n` +
      `Empty findings → {"role":"${reviewer.id}","findings":[],"risk":"low"}\n\n` +
      `## Your specialist focus\n${roleCriteria[reviewer.id] || reviewer.name}\n\n` +
      `## Severity model\n` +
      `- high: blocks key tasks, drops important original content, creates an inaccessible control/path, causes a serious WCAG failure, or substantially flattens brand/content into a generic page.\n` +
      `- medium: likely impairs comprehension, navigation, reading order, link purpose, focus visibility, contrast, zoom/reflow, or content preservation but has a workaround.\n` +
      `- low: minor polish, ambiguous improvement, or advisory issue with limited user impact.\n\n` +
      `## Confidence calibration\n` +
      `- high: you can cite the exact element text/href/id from facts.json AND the WCAG criterion is directly violated.\n` +
      `- medium: evidence is computed (style, layout, ARIA) OR the impact requires user context to fully assess.\n` +
      `- low: heuristic-based judgment, no specific element citation, or advisory polish.\n` +
      `Pick conservatively. low > hallucinated high.\n\n` +
      `## Hard constraints\n` +
      `Ground every finding in observable evidence. Cite concrete element text, heading text, link text/href, image src/alt, section names, axe violation ids/nodes, or before/after differences.\n` +
      `Do not hallucinate failures. If you cannot locate the affected content, do not report it as a finding.\n` +
      `Do not edit transformed.html. JSON only.`,
    user:
      `## Iteration ${iteration} — ${reviewer.name} findings\n\n` +
      `Run directory: ${runDir}\n\n` +
      (iteration === 1
        ? `## Available evidence\n` +
          fileList([
            join(runDir, "brief.md"),
            join(runDir, "facts.json"),
            join(runDir, "axe.json"),
            `${join(runDir, "transformed.html")} (if present)`,
            `${join(iterDir, "checks.json")} (if present)`,
          ]) +
          `\nUse ${join(runDir, "original.html")} or ${join(runDir, "axe-full.json")} only for targeted verification when compact evidence is insufficient for a named id/target.`
        : `## Available evidence\n` +
          fileList([
            `${join(previousIterationDir(runDir, iteration), "previousFindings.compact.json")} (prior iteration findings — id, category, severity, snippet)`,
            `${join(previousIterationDir(runDir, iteration), "checks.json")} (prior compact axe checks)`,
            join(runDir, "brief.md"),
            join(runDir, "facts.json"),
            join(runDir, "axe.json"),
          ]) +
          `\nUse ${join(runDir, "transformed.html")} only for targeted element verification after citing a specific prior finding id or element.\n` +
          `Use ${join(previousIterationDir(runDir, iteration), "checks-full.json")} only for targeted debugging after citing a compact check id/target.\n\n` +
          `## Delta focus\n` +
          `Focus your review on the delta from the prior iteration. Identify:\n` +
          `(a) Prior findings that are now fixed — cite their id from previousFindings.compact.json.\n` +
          `(b) Prior findings that are still present — cite id and note why the fix was incomplete.\n` +
          `(c) New findings introduced this iteration that are NOT in previousFindings.compact.json.\n` +
          `Do not re-report findings already listed in previousFindings.compact.json unless their status has changed (regression or fix).`) +
      `\n\n${TARGETED_EVIDENCE}\n\n${COMPACT_OUTPUT}`,
  }),
  fixPrompt: (ctx, chunk) => {
    let findings: ParsedFinding[];
    let snippets: Record<string, string>;
    let aggregateSummary: string;
    let total: number;

    if (chunk && chunk.length > 0) {
      findings = chunk;
      snippets = buildSnippetsForFindings(ctx.runDir, chunk);
      aggregateSummary = readAggregateSummary(ctx.iterDir);
      total = chunk.length;
    } else {
      ({ findings, snippets, aggregateSummary, total } = loadFixContext(ctx));
      findings = findings.slice(0, 5);
    }

    // For structural findings that produced no element snippet, pass the first
    // 6000 chars of the HTML so the LLM can anchor valid search strings.
    const hasMissingSnippets = findings.some((f) => f.id && !snippets[f.id]);
    let htmlHead: string | undefined;
    if (hasMissingSnippets) {
      const htmlPath = existsSync(join(ctx.runDir, "transformed.html"))
        ? join(ctx.runDir, "transformed.html")
        : join(ctx.runDir, "original.html");
      try {
        htmlHead = readFileSync(htmlPath, "utf8").slice(0, 6000);
      } catch { /* leave undefined */ }
    }

    return {
      system: FIX_SYSTEM_PROMPT,
      user: buildFixUserPrompt(findings, snippets, {
        iteration: ctx.iteration,
        totalFindings: total,
        aggregateSummary,
        htmlHead,
      }),
    };
  },
  votePrompt: ({ runDir, iterDir, iteration }, reviewer) => {
    const priorIds = loadPriorFindingIds(runDir, iteration);
    const hasChecklist = priorIds.length > 0;
    const checklistSchema = hasChecklist
      ? `{"vote":"accept","score":85,"reason":"...","regressionChecklist":[{"id":"semantic-1","status":"fixed"},{"id":"keyboard-2","status":"still_present"}]}`
      : `{"vote":"accept","score":85,"reason":"..."}`;
    return {
      system:
        `You are an expert web accessibility reviewer. Role: ${reviewer.id} — ${reviewer.name}.\n` +
        `You have NO filesystem access. Respond ONLY with a JSON object — no markdown, no explanation.\n\n` +
        `## Output format\n${checklistSchema}\n` +
        (hasChecklist
          ? `regressionChecklist status values: "fixed" = issue resolved, "still_present" = issue persists, "unchanged" = no change observed.\n\n`
          : `\n`) +
        `## Vote criteria\n` +
        `Accept only when: checks.json passes (axe, one h1, main, no mobile overflow); your role's important findings were fixed or credibly reduced; no high-impact accessibility regression introduced; original brand identity, section order, substantive copy, CTAs, links, images/logos, schedule details, judging criteria, and partner information are acceptably preserved; the page remains task-specific.\n\n` +
        `Vote revise when: a fix is close but still has concrete remediable issues — weak focus styling, ambiguous CTA/link text, missing alt nuance, moderate contrast/reflow risk, or partial content preservation.\n\n` +
        `Vote block when: serious accessibility failure, checks fail, important content dropped, links/images lost, brand identity flattened, CTA meaning ambiguous, schedule/judging/partner information disappeared, solver removed content merely to pass axe, or the page only passes automated checks while failing human accessibility/preservation review.\n\n` +
        `## Score scale\n90-100: accept with minor residual risk | 70-89: revise | below 70: block.\n` +
        `The reason must be short but specific, citing evidence such as check failure, missing content, element text, or remaining issue.\n\n` +
        `## Hard constraints\nNo markdown, no explanation, no file writes. JSON only.`,
      user:
        `## Iteration ${iteration} — ${reviewer.name} vote\n\n` +
        `Run directory: ${runDir}\n\n` +
        (hasChecklist
          ? `## Prior finding IDs to cross-check (T3.2)\nFor each ID below, include a regressionChecklist entry with status "fixed", "still_present", or "unchanged".\n` +
            priorIds.map((id) => `- ${id}`).join("\n") +
            `\n\n`
          : ``) +
        `## Available evidence\n` +
        fileList([
          join(runDir, "transformed.html"),
          join(iterDir, "checks.json"),
          `${join(iterDir, "checks-full.json")} (targeted debugging only after citing a compact violation id/target)`,
          join(iterDir, "aggregate-feedback.json"),
          join(iterDir, "solver-task.md"),
          join(iterDir, "solver-result.json"),
        ]) +
        `\n\n${TARGETED_EVIDENCE}\n\n` +
        `Compare transformed.html against the original evidence, brief, findings, solver task, solver result, and automated checks. Vote on both accessibility improvement and preservation quality.`,
    };
  },
  reportPrompt: ({ runDir }, decision?: Decision) => ({
    system:
      `You are an accessibility audit orchestrator writing a final remediation report. ` +
      `Return your entire response as a single JSON object: {"markdown": "<your full markdown report>"}. ` +
      `Place all markdown in the markdown field with \\n for line breaks. ` +
      `The report should be useful for auditing, not just a success message. ` +
      `Do not overstate compliance — passing axe is required evidence, not a full WCAG conformance claim. ` +
      `No markdown fences outside the JSON field.`,
    user:
      `Write the final accessibility remediation report for this run.\n\n` +
      `Run directory: ${runDir}\n` +
      `Final decision: ${JSON.stringify(decision ?? null)}\n\n` +
      `## Available artifacts\n` +
      fileList([
        `${join(runDir, "iterations")}/*/solver-result.json`,
        `${join(runDir, "iterations")}/*/checks.json`,
        `${join(runDir, "iterations")}/*/votes/*.json`,
        `${join(runDir, "iterations")}/*/decision.json`,
        `${join(runDir, "transformed.html")} (targeted inspection only)`,
      ]) +
      `\nPrefer compact artifacts and the latest iteration by default; inspect transformed.html or older iterations only as needed.\n\n` +
      `## report.md must include\n` +
      `- Final outcome and whether automated checks passed\n` +
      `- Accessibility improvements by category: semantic/screen reader, keyboard/motor, cognitive/task clarity, visual/low vision/responsive\n` +
      `- Preservation assessment: original content, CTAs, links, images/logos, schedule details, judging criteria, partners, and brand feel preserved; any justified removals\n` +
      `- Residual risks and limitations: issues not covered by axe, manual checks not performed, dynamic states not observed, uncertain semantic judgments\n` +
      `- Reviewer vote summary and any stop_with_risks rationale\n` +
      `- Link/reference to transformed.html and key artifacts\n\n` +
      `report.html should be simple standalone HTML linking to transformed.html and artifacts.`,
  }),
};

async function scan(url: string, { runDir }: { runDir: string }) {
  mkdirSync(join(runDir, "screenshots"), { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => undefined);
    const facts = await extractFacts(page);
    const axe = await new AxeBuilder({ page }).analyze();
    await page.screenshot({
      path: join(runDir, "screenshots", "original.png"),
      fullPage: true,
    });
    writeFileSync(
      join(runDir, "original.html"),
      absolutizeHtmlResources(await page.content(), page.url()),
    );
    writeFileSync(join(runDir, "facts.json"), JSON.stringify(facts, null, 2));
    const { passes: _passes, inapplicable: _inapplicable, ...axeActionable } =
      axe;
    writeFileSync(
      join(runDir, "axe.json"),
      JSON.stringify(compactAxeResult(axeActionable), null, 2),
    );
    writeFileSync(
      join(runDir, "axe-full.json"),
      JSON.stringify(axeActionable, null, 2),
    );
  } finally {
    await browser.close();
  }
}

async function extractFacts(page: Page): Promise<Facts> {
  return page.evaluate(() => {
    const clean = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();
    const visible = (e: Element) => {
      const h = e as HTMLElement;
      const r = h.getBoundingClientRect();
      const s = getComputedStyle(h);
      return (
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        r.width > 0 &&
        r.height > 0
      );
    };
    const els = (sel: string, n: number) =>
      Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, n);
    const text = (e: Element) =>
      clean((e as HTMLElement).innerText || e.textContent);
    return {
      title: clean(document.title),
      url: location.href,
      lang: document.documentElement.lang || "",
      headings: els("h1,h2,h3,h4,h5,h6", 60).map((e) => ({
        level: Number(e.tagName[1]),
        text: text(e),
      })),
      links: els("a[href]", 100).map((e) => ({
        text:
          text(e) ||
          clean(e.getAttribute("aria-label")) ||
          clean(e.getAttribute("title")),
        href: (e as HTMLAnchorElement).href,
      })),
      buttons: els(
        "button,[role=button],input[type=button],input[type=submit]",
        60,
      ).map((e) => ({
        text:
          text(e) ||
          clean(e.getAttribute("aria-label")) ||
          clean((e as HTMLInputElement).value),
      })),
      images: els("img", 80).map((e) => ({
        alt: clean((e as HTMLImageElement).alt),
        src: (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src,
      })),
      landmarks: els("header,nav,main,aside,footer,[role]", 60).map((e) => ({
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute("role") || "",
        label: clean(e.getAttribute("aria-label")) || text(e).slice(0, 120),
      })),
      textSnippets: Array.from(
        new Set(
          (document.body?.innerText || "")
            .split("\n")
            .map(clean)
            .filter((t) => t.length > 30),
        ),
      ).slice(0, 100),
    };
  });
}

async function check(
  { runDir }: { runDir: string },
  iteration: number,
): Promise<CheckResult> {
  const failures: string[] = [];
  const htmlPath = join(runDir, "transformed.html");
  if (!existsSync(htmlPath)) failures.push("transformed.html missing");
  else normalizeHtmlFile(htmlPath, originalUrl(runDir));
  const preview = await serve(runDir, 0);
  const browser = await chromium.launch();
  let dom = { title: "", h1: 0, main: false };
  let axeViolations: unknown[] = [];
  let fullAxeViolations: unknown[] = [];
  let mobileOverflow = false;
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`http://localhost:${preview.port}/`, {
      waitUntil: "networkidle",
    });
    dom = await page.evaluate(() => ({
      title: document.title.trim(),
      h1: document.querySelectorAll("h1").length,
      main: !!document.querySelector("main"),
    }));
    if (!dom.title) failures.push("missing title");
    if (dom.h1 !== 1) failures.push(`expected one h1, found ${dom.h1}`);
    if (!dom.main) failures.push("missing main");
    const axe = await new AxeBuilder({ page }).analyze();
    fullAxeViolations = axe.violations;
    axeViolations = compactAxeViolations(axe.violations);
    for (const v of axe.violations) failures.push(`axe ${v.id}: ${v.help}`);
    await page.screenshot({
      path: join(
        runDir,
        "screenshots",
        `transformed-${String(iteration).padStart(3, "0")}.png`,
      ),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://localhost:${preview.port}/`, {
      waitUntil: "networkidle",
    });
    mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (mobileOverflow) failures.push("mobile horizontal overflow");
  } finally {
    await browser.close();
    preview.server.close();
  }
  const result = {
    passed: failures.length === 0,
    failures,
    title: dom.title,
    h1: dom.h1,
    main: dom.main,
    mobileOverflow,
    axeViolations,
  };
  writeFullChecks(runDir, iteration, { ...result, axeViolations: fullAxeViolations });
  return result;
}

function compactAxeViolations(violations: AxeViolationInput[]) {
  return violations.map((violation) => {
    const nodes = violation.nodes || [];
    const sampledNodes = nodes.slice(0, AXE_NODE_SAMPLE_LIMIT);
    const sampledTargets = new Set(
      sampledNodes.map((node) => JSON.stringify(compactTarget(node.target))),
    );
    const additionalTargets: unknown[][] = [];
    for (const node of nodes.slice(AXE_NODE_SAMPLE_LIMIT)) {
      const target = compactTarget(node.target);
      if (!target.length) continue;
      const key = JSON.stringify(target);
      if (sampledTargets.has(key)) continue;
      sampledTargets.add(key);
      additionalTargets.push(target);
      if (additionalTargets.length >= AXE_ADDITIONAL_TARGET_LIMIT) break;
    }

    return withoutUndefined({
      id: violation.id,
      impact: violation.impact || undefined,
      help: violation.help,
      helpUrl: violation.helpUrl,
      description: violation.description,
      tags: compactStringArray(violation.tags),
      nodeCount: nodes.length,
      nodes: sampledNodes.map(compactAxeNode),
      additionalTargets: additionalTargets.length ? additionalTargets : undefined,
      omittedNodes: Math.max(0, nodes.length - sampledNodes.length),
    });
  });
}

function compactAxeResult<T extends {
  violations?: AxeViolationInput[];
  incomplete?: AxeViolationInput[];
}>(axe: T) {
  return {
    ...axe,
    violations: compactAxeViolations(axe.violations || []),
    incomplete: compactAxeViolations(axe.incomplete || []),
  };
}

function compactAxeNode(node: AxeNodeInput) {
  const checks = compactAxeNodeChecks(node);
  return withoutUndefined({
    target: compactTarget(node.target),
    impact: node.impact || undefined,
    html: compactString(node.html, AXE_HTML_LIMIT),
    failureSummary: compactString(
      node.failureSummary,
      AXE_FAILURE_SUMMARY_LIMIT,
    ),
    checks: checks.length ? checks : undefined,
  });
}

function compactAxeNodeChecks(node: AxeNodeInput) {
  return [
    ...compactCheckGroup("any", node.any),
    ...compactCheckGroup("all", node.all),
    ...compactCheckGroup("none", node.none),
  ].slice(0, AXE_NODE_CHECK_LIMIT);
}

function compactCheckGroup(type: string, checks?: AxeCheckInput[]) {
  return (checks || []).map((check) =>
    withoutUndefined({
      type,
      id: check.id,
      impact: check.impact || undefined,
      message: compactString(check.message, AXE_CHECK_MESSAGE_LIMIT),
    }),
  );
}

function compactTarget(target: unknown): unknown[] {
  if (Array.isArray(target)) return target.map(compactTargetItem).filter(Boolean);
  const item = compactTargetItem(target);
  return item === undefined ? [] : [item];
}

function compactTargetItem(item: unknown): unknown | undefined {
  if (typeof item === "string") return compactString(item, AXE_TARGET_LIMIT);
  if (!Array.isArray(item)) return undefined;
  const nested = item.map(compactTargetItem).filter(Boolean);
  return nested.length ? nested : undefined;
}

function compactStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length ? strings : undefined;
}

function compactString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function writeFullChecks(runDir: string, iteration: number, result: CheckResult) {
  const iterDir = join(runDir, "iterations", String(iteration).padStart(3, "0"));
  mkdirSync(iterDir, { recursive: true });
  writeFileSync(join(iterDir, "checks-full.json"), JSON.stringify(result, null, 2));
}

function normalizeHtmlFile(file: string, baseUrl: string) {
  if (!baseUrl) return;
  const html = readFileSync(file, "utf8");
  const normalized = absolutizeHtmlResources(html, baseUrl);
  if (normalized !== html) writeFileSync(file, normalized);
}

function originalUrl(runDir: string) {
  try {
    const facts = JSON.parse(
      readFileSync(join(runDir, "facts.json"), "utf8"),
    ) as { url?: unknown };
    return typeof facts.url === "string" ? facts.url : "";
  } catch {
    return "";
  }
}

function absolutizeHtmlResources(html: string, baseUrl: string) {
  return html
    .replace(
      /(\s(?:href|src)=)(["'])([^"']*)\2/gi,
      (_match, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${absolutizeUrl(value, baseUrl)}${quote}`,
    )
    .replace(
      /(\ssrcset=)(["'])([^"']*)\2/gi,
      (_match, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${absolutizeSrcset(value, baseUrl)}${quote}`,
    )
    .replace(
      /url\((["']?)(\/(?!\/)[^"')]+)\1\)/gi,
      (_match, quote: string, value: string) =>
        `url(${quote}${absolutizeUrl(value, baseUrl)}${quote})`,
    );
}

function absolutizeSrcset(value: string, baseUrl: string) {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      const [url, ...descriptor] = trimmed.split(/\s+/);
      return [absolutizeUrl(url, baseUrl), ...descriptor].join(" ");
    })
    .join(", ");
}

function absolutizeUrl(value: string, baseUrl: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

async function serve(runDir: string, preferredPort: number) {
  const root = resolve(runDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(
      new URL(req.url || "/", "http://local").pathname,
    );
    const file =
      path === "/"
        ? join(runDir, "transformed.html")
        : resolve(root, `.${path}`);
    if (
      !(file === root || file.startsWith(`${root}/`)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.setHeader("Content-Type", contentType(file));
    res.end(readFileSync(file));
  });
  const port = await listen(server, preferredPort);
  return { server, port };
}

function contentType(file: string) {
  return (
    (
      {
        ".avif": "image/avif",
        ".css": "text/css; charset=utf-8",
        ".eot": "application/vnd.ms-fontobject",
        ".gif": "image/gif",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".otf": "font/otf",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ttf": "font/ttf",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      } as Record<string, string>
    )[extname(file).toLowerCase()] || "application/octet-stream"
  );
}

function listen(server: Server, port: number) {
  return new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen((server.address() as { port: number }).port);
    });
  });
}
