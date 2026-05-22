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

// Every agent writes a follow-up artifact that later prompts may reference.
// Keeping this shared instruction explicit prevents evidence from being copied
// from file to file until the context window fills with duplicates.
const COMPACT_OUTPUT =
  "Keep outputs compact and deduplicated. Reference finding ids, axe ids, and short element labels; keep evidence snippets brief and do not paste raw HTML, full axe nodes, or long repeated file excerpts.";

function fileList(paths: string[]) {
  return paths.map((path) => `- ${path}`).join("\n");
}

// Findings happen before the current iteration's check step, so the newest
// check evidence available during iteration N is from iteration N-1.
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
  }) => `You are the swarm orchestrator for an accessibility remediation run. Use the available source page evidence to write a practical, preservation-focused accessibility brief for specialist reviewers and the fixer.

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

Write brief.md with these sections:
- Page purpose and user tasks: infer the actual purpose from facts.json and targeted original snippets without inventing a new campaign, event, product, or organization.
- Preservation inventory: list concrete brand/signature elements, section order, copy themes, CTAs, links, image/logo assets, schedule details, judging criteria, sponsor/partner information, and any unique visual tone that must survive remediation.
- Allowed removals: only identify content that may be removed if evidence supports it, such as a Lovable badge, duplicated decorative clutter, inaccessible duplicate controls with an accessible equivalent, or empty generated wrappers. Do not authorize removal of substantive content.
- Initial accessibility evidence: summarize axe violations by id and affected area, plus likely semantic, keyboard, cognitive, and visual risks that need human review.
- Reviewer focus: assign category-specific criteria. Screen-reader/semantic reviewers should check names, roles, landmarks, heading hierarchy, text alternatives, language, reading order, and link purpose. Keyboard reviewers should check focus order, activation, traps, visible focus, target size, skip/bypass needs, and pointer-only behavior. Cognitive reviewers should check task clarity, CTA meaning, form/instruction clarity, content simplification risks, and whether original information remains understandable. Visual reviewers should check contrast, reflow, zoom, spacing, responsive behavior, non-text contrast, focus appearance, and mobile overflow.
- Acceptance bar: passing automated checks is required but not sufficient. Acceptable remediation must improve accessibility while preserving the original page identity and materially all user-relevant content.

${COMPACT_OUTPUT}

Be evidence-based. If something is uncertain, mark it as uncertain rather than turning it into a requirement. Write only files inside the run directory.`,
  // Findings are per-reviewer and intentionally narrow. Later iterations reuse
  // the same reviewer session, so the prompt points at only the latest changed
  // files instead of making each reviewer re-read the whole source page.
  findingsPrompt: (
    { runDir, iterDir, iteration },
    reviewer,
  ) => `You are the ${reviewer.name}. Review iteration ${iteration} as a specialist accessibility detector. Your job is to produce specific, evidence-based findings, not generic advice.

Run directory: ${runDir}
${
  iteration === 1
    ? `Available files:
${fileList([
  join(runDir, "brief.md"),
  join(runDir, "facts.json"),
  join(runDir, "axe.json"),
  `${join(runDir, "transformed.html")} (if present)`,
  `${join(iterDir, "checks.json")} (if present)`,
])}
Use ${join(runDir, "original.html")} or ${join(runDir, "axe-full.json")} only for targeted verification when compact evidence is insufficient for a named id/target.`
    : `Use source evidence already in this reviewer session; do not re-load unchanged source artifacts wholesale.
Available current and latest prior files:
${fileList([
  join(runDir, "transformed.html"),
  `${join(previousIterationDir(runDir, iteration), "checks.json")} (latest prior compact checks)`,
  `${join(previousIterationDir(runDir, iteration), "aggregate-feedback.json")} (latest prior summary, if needed)`,
  `${join(previousIterationDir(runDir, iteration), "solver-result.json")} (latest prior solver notes, if needed)`,
])}
Use ${join(previousIterationDir(runDir, iteration), "checks-full.json")} only for targeted debugging after citing a compact check id/target that lacks enough element detail.`
}
${TARGETED_EVIDENCE}
Output: ${join(iterDir, "findings", `${reviewer.id}.json`)}

Ground every finding in observable evidence from the files. Cite concrete element text, heading text, link text/href, image src/alt, section names, axe violation ids/nodes, or before/after differences. Do not hallucinate failures. If you cannot locate the affected content, do not report it as a finding.

Use this severity model when deciding risk:
- high: blocks key tasks, drops important original content, creates an inaccessible control/path, causes a serious WCAG failure, or substantially flattens brand/content into a generic page.
- medium: likely impairs comprehension, navigation, reading order, link purpose, focus visibility, contrast, zoom/reflow, or content preservation but has a workaround.
- low: minor polish, ambiguous improvement, or advisory issue with limited user impact.

Your role criteria: ${roleCriteria[reviewer.id] || "use the role described above."}

When transformed.html exists, compare it against compact source evidence, targeted original snippets, brief.md, and the preservation inventory. Flag regressions if important copy, CTAs, links, logos/images, schedule details, judging criteria, partner information, or brand feel were lost without accessibility justification. Passing axe does not excuse these regressions.

Prefer typed findings in the findings array using compact strings with this pattern: id=<role>-N | category=<semantic|keyboard|cognitive|visual|preservation|automated> | severity=<low|medium|high> | confidence=<low|medium|high> | location=<specific element/section/text> | evidence=<observable fact> | issue=<user impact> | suggestedFix=<faithful remediation>. The JSON contract still requires findings to be an array of strings, so keep each record as one string.

If no issue is proven, use an empty findings array and risk low. Do not edit transformed.html.

Write exactly this JSON shape:
{ "role": "${reviewer.id}", "findings": ["id=${reviewer.id}-1 | category=... | severity=... | confidence=... | location=... | evidence=... | issue=... | suggestedFix=..."], "risk": "low" | "medium" | "high" }`,
  // The aggregate phase is where noisy parallel reviewer output gets converted
  // into a small work order. The caps below are prompt-level guardrails: they do
  // not hide data, because agents can still inspect targeted artifacts.
  aggregatePrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the swarm orchestrator. Aggregate specialist findings for iteration ${iteration} into an evidence-first remediation task. Normalize, deduplicate, and prioritize; do not invent issues that reviewers did not support with evidence.

Run directory: ${runDir}
Use source evidence and brief already in this orchestrator session; do not re-load unchanged source artifacts wholesale.
Available current files:
${fileList([
  `${join(iterDir, "findings")}/*.json`,
  join(runDir, "transformed.html"),
  ...(iteration > 1
    ? [
        `${join(previousIterationDir(runDir, iteration), "aggregate-feedback.json")} (latest prior summary, if needed)`,
        `${join(previousIterationDir(runDir, iteration), "solver-result.json")} (latest prior solver notes, if needed)`,
        `${join(previousIterationDir(runDir, iteration), "checks.json")} (latest prior checks, if needed)`,
      ]
    : []),
])}
Inspect only targeted snippets needed to resolve supported findings. Use latest prior iteration artifacts by default; inspect older iterations only to resolve a named regression or decision conflict.
Outputs:
- ${join(iterDir, "aggregate-feedback.json")}
- ${join(iterDir, "solver-task.md")}

aggregate-feedback.json must remain compatible with this shape:
{ "summary": "string", "priorities": ["short task"], "risks": ["short risk"] }
Keep summary to three sentences or fewer, priorities to the high-signal top eight, and risks to the high-signal top six. Reference evidence ids, severity, confidence, category, source reviewer, affected original/transformed content, and whether the item is a must-fix, should-fix, preservation guardrail, or residual risk; do not restate full evidence unless a short quote is necessary.

Build a score-driven priority order:
- Critical preservation regressions and blocked key tasks outrank cosmetic accessibility tweaks.
- Axe violations and deterministic check failures are must-fix, but automated pass is not enough.
- Semantic and usability findings need evidence and confidence. Do not let a low-confidence hallucinated finding drive destructive changes.
- If the current transformed.html is worse than the source evidence because it dropped content or became a generic landing page, instruct the fixer to restore affected sections from targeted original snippets, then remediate narrowly.

solver-task.md should be an outcome-based work order, not a patch recipe. The orchestrator acts as a manager: define the problem, priority, evidence, user impact, preservation boundaries, policy decisions, and acceptance criteria. The fixer owns implementation strategy and may make any local HTML/CSS/JS/asset-reference changes needed to satisfy accessibility checks while preserving the page.

Do not micromanage implementation tactics in solver-task.md:
- Do not limit the fixer to a fixed number of changes when violations remain.
- Do not require exact CSS blocks, exact selector edits, wrapper structures, or DOM mechanics unless a specific target is cited as evidence.
- Do not prescribe clipping or scrolling tactics such as overflow-x:hidden or overflow:auto as a reflow fix. If scrolling is an intentional accessible design choice, state the accessibility requirements instead: keyboard access, focusability, accessible name, and no hidden content.
- Do not say no structural changes when fixing the issue may require responsive layout, landmark, control, or embed restructuring.
- Do not claim third-party violations are residual risks while also requiring zero axe violations. Choose and state the policy: either preserve with explicit residual risk, or allow the fixer to replace the third-party embed/widget with an accessible fallback that preserves equivalent user access.

Include these sections:
- Objective: faithful accessibility remediation of the original page, not a generic replacement.
- Source of truth: compact source evidence, targeted original/transformed snippets, brief.md, and this aggregate feedback.
- Preservation requirements: preserve original brand feel, section order, substantive copy, CTAs, link destinations/text meaning, images/logos unless decorative, schedule details, judging criteria, partner/sponsor information, and any distinctive visual language unless accessibility requires a targeted adjustment.
- Allowed removals/replacements: avoid removing substantive content to make checks pass. Allow removal of the Lovable badge, decorative duplicates, empty wrappers, duplicate inaccessible controls when an accessible equivalent remains, and third-party widgets/embeds only when replaced with equivalent accessible content or links. Require a short justification for each removal or replacement.
- Must-fix accessibility items: list each supported issue with evidence ids or short evidence, affected element/section, user impact, and acceptance criteria.
- Faithful remediation constraints: prefer semantic HTML, corrected names/labels/alt text, contrast/focus/reflow CSS, and focused structural repairs over wholesale redesign. Do not replace the page with a generic hero/features/testimonials/contact template. Do not rewrite CTAs into vague labels. Do not drop links or images to make axe pass unless an equivalent accessible replacement is provided and justified.
- Color/theme repair guardrail: treat background, foreground, muted, accent, link, and CTA/button colors as a paired system. If a task changes dark/light background utilities, also require matching foreground utilities, slash-opacity variants, bg-background opacity variants, body background, and default anchor/CTA colors so computed contrast passes. Do not accept token-name fixes without computed foreground/background contrast evidence.
- Acceptance criteria: valid standalone HTML, title, exactly one h1, main landmark, no axe violations, no mobile horizontal overflow, visible focus styles, responsive layout, improved accessibility score, preserved key content and identity, no unsupported removals.
- Solver evidence request: solver-result.json should include changed, summary, accessibilityFixes, implementation decisions, deviations from solver-task tactics if any, preservationNotes, removedContent/replacements, and residualRisks if useful, while remaining simple compact JSON.

${COMPACT_OUTPUT}

Write only these files.`,
  // The fixer is the only role allowed to use original.html as a full starting
  // point. Reviewer/orchestrator phases should cite snippets, while the fixer may
  // need the whole page once to produce a faithful standalone HTML output.
  fixPrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the fixer. Apply solver-task.md for iteration ${iteration}. Your output must be a faithful accessibility remediation of the original page, not a generic replacement landing page.

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
  join(iterDir, "aggregate-feedback.json"),
  join(iterDir, "solver-task.md"),
])}
Inspect only the source snippets needed to preserve and repair the page. The fixer is the only role allowed to load/copy original.html wholesale, and only once as the implementation base when no faithful transformed.html exists. If transformed.html does not exist, do not build it from scratch: run cp from original.html to transformed.html first, then edit transformed.html in place to save tokens and preserve the page. never copy raw HTML into notes or summaries.`
    : `Use unchanged source evidence already in this fixer session; do not re-load unchanged source artifacts wholesale.
Available current files:
${fileList([
  join(iterDir, "aggregate-feedback.json"),
  join(iterDir, "solver-task.md"),
  `${join(runDir, "transformed.html")} (targeted inspection only)`,
])}`
}
${TARGETED_EVIDENCE}
Outputs:
- ${join(runDir, "transformed.html")}
- ${join(iterDir, "solver-result.json")}

Hard constraints:
- Produce valid standalone HTML in transformed.html.
- Keep the original page purpose, brand feel, visual tone, section order, substantive copy, CTAs, links, images/logos, schedule details, judging criteria, partner/sponsor information, and other user-relevant details unless an accessibility fix requires a targeted change.
- Do not create a generic hero/features/testimonials/contact page. Do not replace specific event or organization content with vague marketing filler. Do not invent new dates, sponsors, judging criteria, links, or claims.
- Do not remove substantive content solely to make checks pass. You may remove or replace decorative duplicates, empty wrappers, duplicate inaccessible controls, or inaccessible third-party widgets/embeds when an accessible equivalent remains and the decision is justified in solver-result.json.
- Passing axe is required but not sufficient. Also preserve content and improve human accessibility.
- Color fixes must repair the whole computed color system, not a single class. If restoring or changing backgrounds, also verify and fix body/html background, text-foreground, text-foreground slash-opacity variants, text-muted-foreground, accent text, bg-background slash-opacity variants, default anchors, and CTA/button foreground/background colors.

Implementation authority:
- You own the implementation strategy. Treat solver-task.md as goals, evidence, constraints, policy, and acceptance criteria; do not treat any tactical suggestion as mandatory if it conflicts with accessibility, preservation, or the automated checks.
- You may make whatever local HTML, CSS, JS, ARIA, landmark, responsive layout, embed/widget, or asset-reference changes are needed to fix supported violations and avoid regressions.
- If solver-task.md is too narrow, contradictory, or suggests a tactic that would create a new violation, choose the better implementation and explain the deviation in solver-result.json.
- Fix root causes, not symptoms. Do not hide overflow, clip content, add inaccessible scroll wrappers, remove focusability, or drop content merely to silence a checker.

Required accessibility baseline:
- Meaningful title, page language when known, exactly one h1, main landmark, sensible landmarks/sections, logical heading hierarchy, and DOM order matching visual/reading order.
- Accessible names for links, buttons, controls, and images. Link and CTA text must remain specific enough to convey purpose in context. Alt text must be equivalent in context; decorative images need empty alt, not fabricated descriptions.
- Keyboard operability for every interactive element, no keyboard traps, logical focus order, visible focus indicator with sufficient contrast, and no pointer-only behavior.
- Sufficient color contrast for text and meaningful graphics, no reliance on color alone, responsive layout without mobile horizontal overflow, and reflow/zoom-friendly spacing.
- Use native HTML before ARIA. If ARIA is needed, follow WAI-ARIA Authoring Practices for roles, states, properties, names, keyboard behavior, and landmarks.

Implementation guidance:
- Start from the best prior transformed.html when it preserved the original well. If transformed.html does not exist, copy original.html to transformed.html with cp, then edit transformed.html in place. If a prior transformed.html exists but became generic or lost content, restore from original.html with targeted copies or by replacing transformed.html from original.html once, then apply narrow fixes. Do not build transformed.html from scratch.
- Make the smallest effective set of changes that actually clears supported violations and preserves the page. Keep original assets and hrefs unless broken, inaccessible, or replaced with an equivalent accessible fallback.
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
Use source evidence already available from your findings pass; do not re-load unchanged source artifacts wholesale.
Available current files:
${fileList([
  join(runDir, "transformed.html"),
  join(iterDir, "checks.json"),
  `${join(iterDir, "checks-full.json")} (targeted debugging only after citing a compact violation id/target)`,
  join(iterDir, "aggregate-feedback.json"),
  join(iterDir, "solver-task.md"),
  join(iterDir, "solver-result.json"),
])}
${TARGETED_EVIDENCE}
Output: ${join(iterDir, "votes", `${reviewer.id}.json`)}

Compare transformed.html against the original evidence, brief, findings, solver task, solver result, and automated checks. Vote on both accessibility improvement and preservation quality.

Accept only when:
- checks.json passes, including axe, one h1, main, and no mobile horizontal overflow;
- your role's important findings were fixed or credibly reduced;
- no high-impact accessibility regression was introduced;
- original brand identity, section order, substantive copy, CTAs, links, images/logos, schedule details, judging criteria, and partner information are acceptably preserved;
- the page remains task-specific and does not read like a generic replacement.

Vote revise when a fix is close but still has concrete remediable issues, such as weak focus styling, ambiguous CTA/link text, missing alt nuance, moderate contrast/reflow risk, or partial content preservation.

Vote block when there is a serious accessibility failure, checks fail, important content was dropped, links/images were lost, brand identity was flattened, CTA meaning became ambiguous, schedule/judging/partner information disappeared, solver removed content merely to pass axe, or the page only passes automated checks while failing human accessibility/preservation review.

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
Use the brief, aggregate feedback, and solver task already in this orchestrator session; do not re-load unchanged source artifacts wholesale.
Available current files:
${fileList([
  join(iterDir, "checks.json"),
  join(iterDir, "solver-result.json"),
  `${join(iterDir, "votes")}/*.json`,
  `${join(iterDir, "aggregate-feedback.json")} (targeted clarification only)`,
  `${join(iterDir, "solver-task.md")} (targeted clarification only)`,
])}
Output: ${join(iterDir, "decision.json")}

Write exactly this JSON shape:
{ "outcome": "accept" | "continue" | "stop_with_risks", "reason": "string", "checksPass": boolean, "accepts": number, "blocks": number }

Decision rules:
- checksPass must reflect checks.json, not reviewer optimism.
- Use accept only when checks pass, there are no block votes, reviewers mostly accept, accessibility is materially improved, and preservation is acceptable against the brief and solver-task.
- Use continue when checks fail, important findings remain fixable, reviewers request revise, or the candidate passes axe but still drops content, loses links/images, flattens brand identity, has ambiguous CTAs, or looks like a generic page.
- Treat failed axe color-contrast as fixable after a color/theme change unless the failure has already persisted through a targeted color-repair iteration or the run has exhausted its iteration budget.
- Use stop_with_risks only when further iterations are unlikely to improve within this run, and explain the residual risks clearly.
- If the transformed page appears worse than original or destructive, prefer continue unless retry limits or repeated failures make stop_with_risks more honest.

The reason should mention the decisive evidence: automated pass/fail, accept/block counts, major unresolved accessibility items, and preservation status.`,
  // Reports should be audit-friendly, not marketing copy. They summarize compact
  // artifacts from the completed run and avoid claiming full WCAG conformance.
  reportPrompt: (
    { runDir },
    decision?: Decision,
  ) => `You are the swarm orchestrator. Write the final accessibility remediation report. The report should be useful for auditing, not just a success message.

Run directory: ${runDir}
Final decision: ${JSON.stringify(decision || null)}
Use source evidence, brief, aggregate summaries, and prior decisions already in this orchestrator session.
Available final artifacts:
${fileList([
  `${join(runDir, "iterations")}/*/solver-result.json`,
  `${join(runDir, "iterations")}/*/checks.json`,
  `${join(runDir, "iterations")}/*/votes/*.json`,
  `${join(runDir, "iterations")}/*/decision.json`,
  `${join(runDir, "transformed.html")} (targeted inspection only)`,
])}
Prefer compact artifacts and the latest iteration by default; inspect transformed.html or older iterations only as needed for concrete report evidence.
Outputs:
- ${join(runDir, "report.md")}
- ${join(runDir, "report.html")}

report.md should be concise but evidence-first. Include:
- final outcome and whether automated checks passed;
- what accessibility improved by category: semantic/screen reader, keyboard/motor, cognitive/task clarity, visual/low vision/responsive;
- preservation assessment: what original content, CTAs, links, images/logos, schedule details, judging criteria, partners, and brand feel were preserved; identify any justified removals such as Lovable badge or decorative duplicates;
- residual risks and limitations: issues not covered by axe, manual checks not performed, dynamic states not observed, uncertain semantic judgments, contrast/zoom/mobile caveats, or content that may need human verification;
- reviewer vote summary and any stop_with_risks rationale;
- link/reference to transformed.html and key artifacts.

report.html should be simple standalone HTML linking to transformed.html and artifacts. Do not overstate compliance. Say that passing axe is required evidence, not a full WCAG conformance claim. Write only these report files.`,
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
