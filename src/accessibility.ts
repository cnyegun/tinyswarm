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
  SwarmProfile,
} from "./core.js";

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

// These caps define the contract for agent-facing axe evidence. The full axe
// output is still written to sidecar files, so these limits only protect prompt
// context from repeated node payloads and giant selectors.
const AXE_NODE_SAMPLE_LIMIT = 5;
const AXE_ADDITIONAL_TARGET_LIMIT = 25;
const AXE_TARGET_LIMIT = 240;
const AXE_HTML_LIMIT = 500;
const AXE_FAILURE_SUMMARY_LIMIT = 1200;
const AXE_CHECK_MESSAGE_LIMIT = 300;
const AXE_NODE_CHECK_LIMIT = 8;

const COLLAPSE_WHITESPACE = /\s+/g;
// Snapshot HTML is static, so these patterns only rewrite plain href/src/srcset
// attributes and root-relative CSS url(...) references. Anything more dynamic is
// left unchanged instead of pretending to be a full HTML/CSS parser.
const HTML_URL_ATTRIBUTE = /(\s(?:href|src)=)(["'])([^"']*)\2/gi;
const HTML_SRCSET_ATTRIBUTE = /(\ssrcset=)(["'])([^"']*)\2/gi;
const ROOT_RELATIVE_CSS_URL = /url\((["']?)(\/(?!\/)[^"')]+)\1\)/gi;

const reviewers = [
  { id: "accessibility", name: "accessibility reviewer" },
  { id: "preservation", name: "preservation and task clarity reviewer" },
];

const roleCriteria: Record<string, string> = {
  accessibility:
    "High-impact WCAG coverage only: names/roles/landmarks, heading order, keyboard reachability, visible focus, link/button names, alt text, contrast, zoom/reflow, and mobile overflow.",
  preservation:
    "Preservation and task clarity: keep purpose, substantive copy, CTAs, links, important media/logos, key details, partners/sponsors, and recognizable brand vibe. Layout changes are allowed.",
};

const TARGETED_EVIDENCE =
  "Inspect only the files and snippets needed for this phase. Use targeted reads/searches; do not load raw HTML, full axe nodes, or long artifacts wholesale. Open full sidecars only after a compact finding/violation id or target needs missing detail.";

// Every agent writes a follow-up artifact that later prompts may reference.
// Keeping this shared instruction explicit prevents evidence from being copied
// from file to file until the context window fills with duplicates.
const COMPACT_OUTPUT =
  "Keep outputs compact and deduplicated. Reference finding ids, axe ids, and short element labels; keep evidence snippets brief and do not paste raw HTML, full axe nodes, or long repeated file excerpts.";

function fileList(paths: string[]) {
  return paths.map((path) => `- ${path}`).join("\n");
}

// Later fixer iterations repair the previous iteration's checks/votes.
function previousIterationDir(runDir: string, iteration: number) {
  return join(runDir, "iterations", String(iteration - 1).padStart(3, "0"));
}

export const accessibilityProfile: SwarmProfile = {
  id: "accessibility",
  artifact: "transformed.html",
  reviewers,
  scan,
  check,
  // The brief is the only phase that turns raw scan output into a shared mental
  // model. It should summarize source purpose/preservation once so reviewers do
  // not each rediscover the same facts from raw HTML.
  briefPrompt: ({
    runDir,
  }) => `You are the swarm orchestrator for an accessibility remediation run. Use the available source page evidence to write a short, informative brief for a powerful accessibility rewrite. The fixer may redesign layout and structure when that produces better accessibility.

Run directory: ${runDir}
Available files:
${fileList([
  `${join(runDir, "original.html")} (targeted inspection only)`,
  join(runDir, "facts.json"),
  join(runDir, "axe.json"),
  `${join(runDir, "axe-full.json")} (targeted debugging only after compact axe id/target lacks detail)`,
])}

${TARGETED_EVIDENCE} Prefer facts.json and compact axe evidence before targeted original.html inspection.

Output: ${join(runDir, "brief.md")}

Use WCAG 2.2, WAI Easy Checks, WAI-ARIA Authoring Practices, WebAIM-style pragmatic testing, Inclusive Design Principles, and accessibility usability guidance as references. Treat axe as useful evidence, not a complete evaluation.

Keep brief.md concise: target 500-800 words, no duplicated bullets, no repeated evidence across sections, no raw HTML, and no long axe-node excerpts. Prefer specific facts over broad WCAG boilerplate. If an issue belongs in multiple categories, mention it once under the most relevant category and cross-reference it by short label only if needed.

Write brief.md with these sections:
- Page purpose and vibe: 4-8 bullets covering the actual purpose, distinctive brand/visual tone, key CTAs, links, images/logos, schedule/details, judging criteria, partners/sponsors, and anything substantive that must not be lost. Do not require the original layout or section order unless it is essential to the task.
- Allowed removals: only evidence-supported non-substantive content such as a Lovable badge, decorative duplicates, empty wrappers, or duplicate inaccessible controls with an accessible equivalent.
- Top accessibility evidence: at most 8 bullets. Group related axe violations and human-review risks by affected area; cite compact ids/targets only.
- Reviewer focus: one short line per reviewer role, only naming what that role should uniquely verify. Avoid repeating the same task under multiple roles.
- Acceptance bar: 2-4 bullets covering automated checks, human accessibility, responsive/keyboard usability, retained content, and recognizable vibe.

${COMPACT_OUTPUT}

Be evidence-based. If something is uncertain, mark it as uncertain rather than turning it into a requirement. Write only files inside the run directory.`,
  // The fixer is the only role allowed to use original.html as a full starting
  // point. Reviewer/orchestrator phases should cite snippets, while the fixer may
  // need the whole page once to produce a faithful standalone HTML output.
  fixPrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the fixer for iteration ${iteration}. Your output must be an excellent accessibility rewrite of the original page, not a generic replacement landing page. Great accessibility changes may substantially improve or surprise the original design.

Do not use todo, task-list, planning, or subagent tools. Do not pause to make a plan artifact. Write the required output files directly. On iteration 1, if transformed.html does not exist, your first file action must be copying original.html to transformed.html; then edit transformed.html in place.

Run directory: ${runDir}
${
  iteration === 1
    ? `Available files:
${fileList([
  `${join(runDir, "original.html")} (implementation base only if no faithful transformed.html exists; otherwise targeted inspection)`,
  join(runDir, "facts.json"),
  join(runDir, "axe.json"),
  `${join(runDir, "axe-full.json")} (targeted debugging only after compact axe id/target lacks detail)`,
  join(runDir, "brief.md"),
])}
First pass: fix the compact axe violations and baseline requirements from brief.md while keeping the site recognizable. Inspect only the source snippets needed to understand and repair the page. The fixer is the only role allowed to load/copy original.html wholesale, and only once as the implementation base when no transformed.html exists. If transformed.html does not exist, do not build it from scratch: run cp from original.html to transformed.html as your first file action, then edit transformed.html in place to save tokens and preserve source-specific content. Never copy raw HTML into notes or summaries.`
    : `Use unchanged source evidence already in this fixer session; do not re-load unchanged source artifacts wholesale.
Available current files:
${fileList([
  `${join(previousIterationDir(runDir, iteration), "checks.json")} (fix these first if checks failed)`,
  `${join(previousIterationDir(runDir, iteration), "decision.json")} (why the last iteration continued)`,
  `${join(previousIterationDir(runDir, iteration), "votes")}/*.json (only if checks passed but reviewers requested changes)`,
  `${join(previousIterationDir(runDir, iteration), "solver-result.json")} (latest solver notes)`,
  `${join(runDir, "transformed.html")} (targeted inspection only)`,
])}`
}
${TARGETED_EVIDENCE}
Outputs:
- ${join(runDir, "transformed.html")}
- ${join(iterDir, "solver-result.json")}

Hard constraints:
- Produce valid standalone HTML in transformed.html.
- Keep the original page purpose, core content, CTAs, link destinations, important images/logos, key details, partner/sponsor information, and recognizable brand vibe.
- You may substantially change layout, DOM structure, spacing, grouping, visual hierarchy, component design, and responsive behavior when it improves accessibility.
- Do not create a generic hero/features/testimonials/contact page. Do not replace specific event, organization, product, or service content with vague marketing filler. Do not invent new dates, sponsors, judging criteria, links, products, or claims.
- Do not remove substantive content solely to make checks pass. You may simplify, reorganize, restyle, or replace inaccessible patterns with accessible equivalents when the user can still accomplish the same tasks.
- Passing axe is required but not sufficient. Prefer bold, high-quality human accessibility improvements over timid layout preservation.
- Color fixes must repair the whole computed color system, not a single class. If restoring or changing backgrounds, also verify and fix body/html background, text-foreground, text-foreground slash-opacity variants, text-muted-foreground, accent text, bg-background slash-opacity variants, default anchors, and CTA/button foreground/background colors.

Implementation authority:
- You own the implementation strategy. Treat brief.md, axe/check failures, prior votes, and prior decisions as goals, evidence, constraints, policy, and acceptance criteria; do not treat any tactical suggestion as mandatory if it conflicts with accessibility, content, vibe, or the automated checks.
- You may make whatever local HTML, CSS, JS, ARIA, landmark, responsive layout, component, copy-structure, embed/widget, or asset-reference changes are needed to produce a more accessible page.
- If prior guidance is too narrow, contradictory, or suggests a tactic that would create a new violation, choose the better implementation and explain the deviation in solver-result.json.
- Fix root causes, not symptoms. Do not hide overflow, clip content, add inaccessible scroll wrappers, remove focusability, or drop content merely to silence a checker.

Required accessibility baseline:
- Meaningful title, page language when known, exactly one h1, main landmark, sensible landmarks/sections, logical heading hierarchy, and DOM order matching visual/reading order.
- Accessible names for links, buttons, controls, and images. Link and CTA text must remain specific enough to convey purpose in context. Alt text must be equivalent in context; decorative images need empty alt, not fabricated descriptions.
- Keyboard operability for every interactive element, no keyboard traps, logical focus order, visible focus indicator with sufficient contrast, and no pointer-only behavior.
- Sufficient color contrast for text and meaningful graphics, no reliance on color alone, responsive layout without mobile horizontal overflow, and reflow/zoom-friendly spacing.
- Use native HTML before ARIA. If ARIA is needed, follow WAI-ARIA Authoring Practices for roles, states, properties, names, keyboard behavior, and landmarks.

Implementation guidance:
- Start from the best prior transformed.html when it kept the original content and vibe. If transformed.html does not exist, copy original.html to transformed.html with cp, then edit transformed.html in place. If a prior transformed.html became generic or lost content, restore from original.html with targeted copies or by replacing transformed.html from original.html once, then improve it.
- Make the clearest effective accessibility change, even if it restructures the page. Prefer understandable, robust, accessible UI over preserving fragile original layout details. Keep original assets and hrefs unless broken, inaccessible, or replaced with an equivalent accessible fallback.
- When adding CSS overrides for Tailwind-like classes that contain slash opacity, escape the slash in selectors and cover every used variant in transformed.html; examples include text-foreground/60 and bg-background/85.
- If an issue is uncertain and changing it risks content loss or false claims, preserve the original and record the residual risk.
- Ensure transformed.html can be served directly from the run directory without external build steps.

solver-result.json must be valid JSON. Keep at least this compatible shape and add simple fields if helpful:
{ "changed": true, "summary": "string", "accessibilityFixes": ["string"], "preservationNotes": ["string"], "removedContent": ["string"], "residualRisks": ["string"] }`,
  // Votes run after automated checks. They should use checks.json as the compact
  // source of truth, and only open checks-full.json if a specific compact node is
  // too ambiguous to judge.
  votePrompt: (
    { runDir, iterDir },
    reviewer,
  ) => `You are the ${reviewer.name}. Re-review transformed.html and vote on whether this candidate should be accepted.

Run directory: ${runDir}
Use brief.md and compact current artifacts; do not re-load unchanged source artifacts wholesale.
Your review focus: ${roleCriteria[reviewer.id] || "use the role described above."}
Available current files:
${fileList([
  join(runDir, "brief.md"),
  join(runDir, "transformed.html"),
  join(iterDir, "checks.json"),
  `${join(iterDir, "checks-full.json")} (targeted debugging only after citing a compact violation id/target)`,
  join(iterDir, "solver-result.json"),
])}
${TARGETED_EVIDENCE}
Output: ${join(iterDir, "votes", `${reviewer.id}.json`)}

Compare transformed.html against the original evidence, brief, solver result, and automated checks. Vote on accessibility improvement, task success, content retention, and recognizable brand vibe. Do not penalize layout changes by themselves.

Accept only when:
- checks.json passes, including axe, one h1, main, and no mobile horizontal overflow;
- your role's important concerns are fixed or credibly reduced;
- no high-impact accessibility regression was introduced;
- substantive copy, CTAs, links, important images/logos, key details, and partner information are retained or accessibly replaced;
- layout changes, restyling, regrouping, and simplified structure improve accessibility while keeping the site purpose and vibe recognizable;
- the page remains task-specific and does not read like a generic replacement.

Vote revise when a fix is close but still has concrete remediable issues, such as weak focus styling, ambiguous CTA/link text, missing alt nuance, moderate contrast/reflow risk, lost important content, or loss of recognizable vibe. Do not vote revise solely because the layout changed.

Vote block when there is a serious accessibility failure, checks fail, important content was dropped, links/images were lost, brand vibe disappeared, CTA meaning became ambiguous, key information disappeared, solver removed content merely to pass axe, or the page only passes automated checks while failing human accessibility/task review.

Score 0-100. Suggested scale: 90-100 accept with minor residual risk; 70-89 revise; below 70 block for serious issue or destructive simplification. The reason must be short but specific, citing evidence such as check failure, missing content, element text, or remaining issue.

Write exactly this tiny JSON shape:
{ "vote": "accept" | "revise" | "block", "score": number, "reason": "short reason" }`,
  // The decision phase is deliberately conservative: automated pass is required,
  // but preservation regressions or human-review blocks still force another loop.
  decisionPrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the swarm orchestrator. Decide whether iteration ${iteration} is done. Do not accept merely because automated checks pass.

Run directory: ${runDir}
Use the brief and current compact artifacts; do not re-load unchanged source artifacts wholesale.
Available current files:
${fileList([
  join(runDir, "brief.md"),
  join(iterDir, "checks.json"),
  join(iterDir, "solver-result.json"),
  `${join(iterDir, "votes")}/*.json`,
])}
Output: ${join(iterDir, "decision.json")}

Write exactly this JSON shape:
{ "outcome": "accept" | "continue" | "stop_with_risks", "reason": "string", "checksPass": boolean, "accepts": number, "blocks": number }

Decision rules:
- checksPass must reflect checks.json, not reviewer optimism.
- Use accept only when checks pass, there are no block votes, reviewers mostly accept, accessibility is materially improved, core content/tasks remain intact, and the brand vibe is recognizable.
- Use continue when checks fail, important findings remain fixable, reviewers request revise, or the candidate passes axe but still drops important content, loses links/images, loses brand vibe, has ambiguous CTAs, breaks task flow, or looks like a generic page.
- Treat failed axe color-contrast as fixable after a color/theme change unless the failure has already persisted through a targeted color-repair iteration or the run has exhausted its iteration budget.
- Use stop_with_risks only when further iterations are unlikely to improve within this run, and explain the residual risks clearly.
- If the transformed page appears worse than original, destructive, generic, or content-poor, prefer continue unless retry limits or repeated failures make stop_with_risks more honest. Do not continue solely because layout changed.

The reason should mention the decisive evidence: automated pass/fail, accept/block counts, major unresolved accessibility items, and preservation status.`,
};

async function scan(url: string, { runDir }: { runDir: string }) {
  mkdirSync(join(runDir, "screenshots"), { recursive: true });
  const browser = await chromium.launch();
  try {
    // Scan captures a stable snapshot of the original page before any agent can
    // edit it. Later phases compare against these files to catch destructive
    // rewrites that pass axe but lose real page content.
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
    // Axe `passes` and `inapplicable` are huge and not actionable for the agents.
    // Keep only actionable rule groups in both compact and full sidecars.
    const { passes: _passes, inapplicable: _inapplicable, ...axeActionable } =
      axe;
    // axe.json is the default agent-facing evidence. It is intentionally compact.
    writeFileSync(
      join(runDir, "axe.json"),
      JSON.stringify(compactAxeResult(axeActionable), null, 2),
    );
    // axe-full.json keeps the raw actionable detail for targeted debugging when
    // compact samples omit a needed node or selector.
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
    const collapseWhitespace = /\s+/g;
    const clean = (s?: string | null) =>
      (s || "").replace(collapseWhitespace, " ").trim();
    // Facts are a cheap source inventory for prompts. The per-category caps keep
    // the initial brief useful on large pages without forcing raw HTML reads.
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
  // The preview server makes local transformed.html behave like a real page:
  // relative assets work, screenshots work, and axe sees browser-computed DOM.
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
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => undefined);
    dom = await page.evaluate(() => ({
      title: document.title.trim(),
      h1: document.querySelectorAll("h1").length,
      main: !!document.querySelector("main"),
    }));
    if (!dom.title) failures.push("missing title");
    if (dom.h1 !== 1) failures.push(`expected one h1, found ${dom.h1}`);
    if (!dom.main) failures.push("missing main");
    const axe = await new AxeBuilder({ page }).analyze();
    // Return compact violations to agents but keep the full violation payload on
    // disk. This is the core prompt-budget tradeoff in this profile.
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
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => undefined);
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
  // checks.json is written by core from this return value. The explicit full
  // sidecar lives next to it for rare targeted node-level debugging.
  writeFullChecks(runDir, iteration, { ...result, axeViolations: fullAxeViolations });
  return result;
}

// Agent prompts read compact axe artifacts by default. Raw axe output is kept in
// sidecar files, so the compact form keeps rule metadata, a small node sample,
// and extra locators without flooding the context window.
function compactAxeViolations(violations: AxeViolationInput[]) {
  return violations.map((violation) => {
    const nodes = violation.nodes || [];
    const sampledNodes = nodes.slice(0, AXE_NODE_SAMPLE_LIMIT);
    const sampledTargets = new Set(
      sampledNodes.map((node) => JSON.stringify(truncateAxeTarget(node.target))),
    );
    const additionalTargets: unknown[][] = [];
    // Omitted nodes still need locators for repeated failures, but not their full
    // HTML/check payloads. De-duping keeps repeated selectors from dominating.
    for (const node of nodes.slice(AXE_NODE_SAMPLE_LIMIT)) {
      const target = truncateAxeTarget(node.target);
      if (!target.length) continue;
      const key = JSON.stringify(target);
      if (sampledTargets.has(key)) continue;
      sampledTargets.add(key);
      additionalTargets.push(target);
      if (additionalTargets.length >= AXE_ADDITIONAL_TARGET_LIMIT) break;
    }

    return omitUndefinedFields({
      id: violation.id,
      impact: violation.impact || undefined,
      help: violation.help,
      helpUrl: violation.helpUrl,
      description: violation.description,
      tags: stringArray(violation.tags),
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
  // Keep the original result shape so existing consumers can still look for
  // `violations` and `incomplete`, but replace their heavy node payloads.
  return {
    ...axe,
    violations: compactAxeViolations(axe.violations || []),
    incomplete: compactAxeViolations(axe.incomplete || []),
  };
}

function compactAxeNode(node: AxeNodeInput) {
  const checks = compactChecksForNode(node);
  // A sampled node keeps enough detail to identify and fix the issue: selector,
  // clipped HTML, clipped failure summary, and clipped check messages.
  return omitUndefinedFields({
    target: truncateAxeTarget(node.target),
    impact: node.impact || undefined,
    html: truncateEvidenceText(node.html, AXE_HTML_LIMIT),
    failureSummary: truncateEvidenceText(
      node.failureSummary,
      AXE_FAILURE_SUMMARY_LIMIT,
    ),
    checks: checks.length ? checks : undefined,
  });
}

function compactChecksForNode(node: AxeNodeInput) {
  // Axe separates checks into `any`, `all`, and `none`; keeping the group label
  // helps a fixer understand why a node failed without preserving full payloads.
  return [
    ...compactCheckMessages("any", node.any),
    ...compactCheckMessages("all", node.all),
    ...compactCheckMessages("none", node.none),
  ].slice(0, AXE_NODE_CHECK_LIMIT);
}

function compactCheckMessages(type: string, checks?: AxeCheckInput[]) {
  return (checks || []).map((check) =>
    omitUndefinedFields({
      type,
      id: check.id,
      impact: check.impact || undefined,
      message: truncateEvidenceText(check.message, AXE_CHECK_MESSAGE_LIMIT),
    }),
  );
}

// Axe targets are selectors, or nested selector arrays for frames/shadow DOM.
// Preserve that shape, but cap each selector string independently.
function truncateAxeTarget(target: unknown): unknown[] {
  if (Array.isArray(target))
    return target.map(truncateAxeTargetItem).filter(Boolean);
  const item = truncateAxeTargetItem(target);
  return item === undefined ? [] : [item];
}

function truncateAxeTargetItem(item: unknown): unknown | undefined {
  if (typeof item === "string")
    return truncateEvidenceText(item, AXE_TARGET_LIMIT);
  if (!Array.isArray(item)) return undefined;
  const nested = item.map(truncateAxeTargetItem).filter(Boolean);
  return nested.length ? nested : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length ? strings : undefined;
}

function truncateEvidenceText(value: unknown, limit: number): string | undefined {
  // This function exists because the compact files are prompt inputs. Axe can
  // produce very long HTML snippets, summaries, messages, and selectors; after a
  // few repeated nodes those dominate the context window. The raw sidecars remain
  // available, so truncation removes bulk, not evidence ownership.
  if (typeof value !== "string") return undefined;
  const clean = value.replace(COLLAPSE_WHITESPACE, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

function omitUndefinedFields<T extends Record<string, unknown>>(value: T) {
  // Compact JSON should omit missing fields instead of writing noisy null-ish
  // placeholders that agents may treat as meaningful evidence.
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function writeFullChecks(runDir: string, iteration: number, result: CheckResult) {
  // `check()` returns compact data because core writes that to checks.json. This
  // sidecar preserves raw axe violations for humans or targeted agent reads.
  const iterDir = join(runDir, "iterations", String(iteration).padStart(3, "0"));
  mkdirSync(iterDir, { recursive: true });
  writeFileSync(join(iterDir, "checks-full.json"), JSON.stringify(result, null, 2));
}

function normalizeHtmlFile(file: string, baseUrl: string) {
  // Fixer output is served from localhost during checks. Convert root-relative
  // assets back to the original site so validation sees the intended resources.
  if (!baseUrl) return;
  const html = readFileSync(file, "utf8");
  const normalized = absolutizeHtmlResources(html, baseUrl);
  if (normalized !== html) writeFileSync(file, normalized);
}

function originalUrl(runDir: string) {
  // facts.json is the only place that remembers the scanned URL after scan().
  // If it is missing or malformed, URL normalization safely becomes a no-op.
  try {
    const facts = JSON.parse(
      readFileSync(join(runDir, "facts.json"), "utf8"),
    ) as { url?: unknown };
    return typeof facts.url === "string" ? facts.url : "";
  } catch {
    return "";
  }
}

// Saved snapshots are later served from the run directory. Root-relative asset
// paths must keep resolving against the original page URL, not localhost.
function absolutizeHtmlResources(html: string, baseUrl: string) {
  return html
    .replace(
      HTML_URL_ATTRIBUTE,
      (_match, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${absolutizeUrl(value, baseUrl)}${quote}`,
    )
    .replace(
      HTML_SRCSET_ATTRIBUTE,
      (_match, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${absolutizeSrcset(value, baseUrl)}${quote}`,
    )
    .replace(
      ROOT_RELATIVE_CSS_URL,
      (_match, quote: string, value: string) =>
        `url(${quote}${absolutizeUrl(value, baseUrl)}${quote})`,
    );
}

function absolutizeSrcset(value: string, baseUrl: string) {
  // srcset candidates are comma-separated, with an optional width/density
  // descriptor after the URL. Only the URL portion should be rewritten.
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      const [url, ...descriptor] = trimmed.split(COLLAPSE_WHITESPACE);
      return [absolutizeUrl(url, baseUrl), ...descriptor].join(" ");
    })
    .join(", ");
}

function absolutizeUrl(value: string, baseUrl: string) {
  // Only root-relative URLs need the original page origin. Absolute URLs,
  // protocol-relative URLs, fragments, data URLs, and relative sibling paths are
  // left unchanged.
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
    // The resolved-path check prevents `../` and encoded traversal from escaping
    // the run directory while still allowing nested local assets to be served.
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
  // Playwright/axe render pages through a real browser, so serving modern image
  // and font MIME types matters for visual/layout-dependent checks.
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
