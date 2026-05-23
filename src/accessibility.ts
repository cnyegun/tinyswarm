import { AxeBuilder } from "@axe-core/playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import type {
  CheckResult,
  SwarmProfile,
} from "./core.js";
import { listen, sendStaticFile } from "./static-server.js";

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
  { id: "semantic", name: "screen-reader and semantic structure reviewer" },
  { id: "keyboard", name: "keyboard and motor access reviewer" },
  { id: "cognitive", name: "cognitive load and clarity reviewer" },
  { id: "visual", name: "low-vision, contrast, zoom, and mobile reviewer" },
  { id: "preservation", name: "content preservation reviewer" },
];

// Short role rubrics make reviewers act like specialists without adding new
// workflow steps or forcing the whole WCAG spec into every prompt.
const reviewerRubrics: Record<string, string> = {
  semantic: `Mission: screen-reader structure, names, roles, and programmatic meaning.
WCAG focus: 1.1.1 Non-text Content; 1.3.1 Info and Relationships; 2.4.2 Page Titled; 2.4.4 Link Purpose; 2.4.6 Headings and Labels; 3.1.1 Language of Page; 4.1.2 Name, Role, Value; 4.1.3 Status Messages.
Audit procedure: check title/lang; inspect landmarks; verify exactly one useful h1; follow heading order; inspect link/button/form names; review image alt; look for ARIA that contradicts native behavior.
Block if: controls are unlabeled, meaningful images lack equivalent alt, landmarks/headings hide structure, ARIA lies, or repeated links have ambiguous purpose.
False positives: do not report visual taste, layout preference, or keyboard/contrast issues unless semantic markup is the root cause.
Example: location=footer h4 after h2 | evidence=heading jumps h2 to h4 | impact=screen-reader outline implies missing sections | fix=use h3 or non-heading labels.
Accept only if: structure is navigable, names/roles are accurate, alt text is appropriate, and no semantic regression hides content.`,
  keyboard: `Mission: keyboard-only and motor accessibility for every task path.
WCAG focus: 2.1.1 Keyboard; 2.1.2 No Keyboard Trap; 2.1.4 Character Key Shortcuts; 2.4.1 Bypass Blocks; 2.4.3 Focus Order; 2.4.7 Focus Visible; 2.5.5 Target Size Enhanced; 2.5.8 Target Size Minimum.
Audit procedure: list interactive elements; verify tab reachability; check activation; compare focus order to reading order; inspect skip link and in-page anchors; verify visible focus; check target size/spacing; flag pointer-only behavior.
Block if: primary CTA is unreachable/broken, focus disappears, a trap exists, tab order changes meaning, or hover-only content lacks keyboard access.
False positives: do not fail for aesthetics or contrast unless focus/targets become unusable.
Example: location=nav Apply link | evidence=href #apply but no matching id | impact=keyboard activation gives no destination | fix=add id to CTA section or correct href.
Accept only if: all task controls are keyboard reachable, focus is obvious, activation works, and no trap or broken anchor remains.`,
  cognitive: `Mission: comprehension, predictable navigation, and task clarity.
WCAG focus: 2.4.4 Link Purpose; 2.4.6 Headings and Labels; 3.2.3 Consistent Navigation; 3.2.4 Consistent Identification; 3.3.2 Labels or Instructions; 3.3.5 Help; 3.3.7 Redundant Entry.
Audit procedure: identify the primary task; compare CTA language; check labels/instructions; verify nav names match destinations; look for conflicting terminology; ensure dates/location/schedule/judging details remain clear.
Block if: the main action is ambiguous, apply/register language conflicts, key instructions vanish, navigation labels mislead, or the page becomes generic marketing copy.
False positives: do not report grammar polish or personal copy taste unless user impact is concrete.
Example: location=hero and nav CTAs | evidence=nav says Apply, button says Register, copy says apply early | impact=users cannot tell if this is one action or two | fix=use one term or add clarifying sentence.
Accept only if: purpose, task flow, labels, and key details are understandable and consistent.`,
  visual: `Mission: low-vision usability, contrast, zoom, reflow, and visual affordances.
WCAG focus: 1.4.1 Use of Color; 1.4.3 Contrast Minimum; 1.4.4 Resize Text; 1.4.10 Reflow; 1.4.11 Non-text Contrast; 1.4.12 Text Spacing; 2.4.11 Focus Not Obscured; 2.4.13 Focus Appearance.
Audit procedure: review axe contrast; inspect text and UI boundaries; check focus appearance contrast; verify mobile overflow result; inspect likely 200% zoom/reflow risks; look for clipped, overlapping, or unreadable content.
Block if: meaningful text fails contrast, mobile horizontal scroll remains, content clips at zoom, focus indicator is too subtle, or color alone carries meaning.
False positives: do not require a different brand style if contrast, reflow, and readability pass.
Example: location=footer copyright | evidence=#4a4a4a on black is about 2.35:1 | impact=low-vision users cannot read legal/context text | fix=lighten text to a token meeting 4.5:1.
Accept only if: text/UI contrast, focus appearance, mobile layout, and reflow are usable.`,
  preservation: `Mission: prevent accessibility fixes from destroying the original product.
WCAG support: 2.4.4 Link Purpose; 2.4.6 Headings and Labels; 3.2.3 Consistent Navigation; plus factual/content integrity.
Audit procedure: compare facts and brief against transformed page; verify links/CTAs; check logos/images; preserve dates, locations, sponsors, partners, contact info, and claims; judge whether brand vibe is still recognizable.
Block if: primary CTA/link is missing, sponsors or key details disappear, facts are invented/changed, the page becomes generic, or content was deleted only to pass axe.
False positives: do not demand identical layout; accessible restructuring is allowed when content, task flow, and vibe survive.
Example: location=partner section | evidence=original listed Microsoft and sponsors, transformed omits them | impact=material event credibility/content lost | fix=restore sponsor names/logos accessibly.
Accept only if: core content, links, factual claims, and recognizable identity are preserved or replaced with an accessible equivalent.`,
};

const TARGETED_EVIDENCE =
  "Inspect only the files and snippets needed for this phase. Use targeted reads/searches; do not load raw HTML, full axe nodes, or long artifacts wholesale. Open full sidecars only after a compact finding/violation id or target needs missing detail.";

// Every agent writes a follow-up artifact that later prompts may reference.
// Keeping this shared instruction explicit prevents evidence from being copied
// from file to file until the context window fills with duplicates.
const COMPACT_OUTPUT =
  "Keep outputs compact and deduplicated. Reference finding ids, axe ids, and short element labels; keep evidence snippets brief and do not paste raw HTML, full axe nodes, or long repeated file excerpts.";

// The full WCAG 2.2 spec is far too large to read directly. reference/wcag/ is a
// generated, navigable copy (built by `npm run build:wcag`); agents consult the
// tree index and read individual criteria on demand instead of loading the spec.
const WCAG_REFERENCE =
  "WCAG 2.2 reference: reference/wcag/index.md is the principle/guideline/success-criterion tree; reference/wcag/sc/<file>.md holds one criterion's normative text; reference/wcag/glossary.md defines terms. Read individual criteria only when you need them; never load the whole set. Compact axe violations carry a `wcag` array naming the success criteria each violation maps to, each with a `ref` path into reference/wcag/sc/.";

const SPECIALIST_REVIEW_METHOD = `Specialist review method:
1. Start with checks.json. If it fails, your vote cannot be accept.
2. Read solver-result.json to understand claimed fixes, removed content, residual risks, resolvedFindings, and unresolvedFindings.
3. Compare against brief.md and facts.json so you judge the actual page, not a generic accessibility ideal.
4. Inspect transformed.html only where your rubric points or where checks/solver evidence is ambiguous.
5. Use axe as evidence, not the full audit. If a compact violation maps to WCAG, read that specific reference file before making a nuanced call.
6. Classify only concrete user-impacting issues. A finding needs location, observable evidence, impact, and a fix.
7. Prefer one strong blocker over many weak comments. Do not duplicate another specialist's issue unless your role sees a distinct user impact.
8. Before accepting, ask: would a user in my specialty complete the primary task without avoidable confusion, loss, or barrier?

Severity guide: high blocks a key task or hides/lies about important content; medium impairs navigation, comprehension, operation, or reflow but has a workaround; low is advisory polish with limited impact.
Vote guide: accept means no high/medium role issue remains; revise means fixable high/medium issue remains; block means serious accessibility or preservation damage, broken task flow, or generic/destructive rewrite.`;

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

${WCAG_REFERENCE}

Output: ${join(runDir, "brief.md")}

Use WCAG 2.2, WAI Easy Checks, WAI-ARIA Authoring Practices, WebAIM-style pragmatic testing, Inclusive Design Principles, and accessibility usability guidance as references. Treat axe as useful evidence, not a complete evaluation.

Keep brief.md concise: target 500-800 words, no duplicated bullets, no repeated evidence across sections, no raw HTML, and no long axe-node excerpts. Prefer specific facts over broad WCAG boilerplate. If an issue belongs in multiple categories, mention it once under the most relevant category and cross-reference it by short label only if needed.

Write brief.md with these sections:
- Page purpose and vibe: 4-8 bullets covering the actual purpose, distinctive brand/visual tone, key CTAs, links, images/logos, schedule/details, judging criteria, partners/sponsors, and anything substantive that must not be lost. Do not require the original layout or section order unless it is essential to the task.
- Allowed removals: only evidence-supported non-substantive content such as a Lovable badge, decorative duplicates, empty wrappers, or duplicate inaccessible controls with an accessible equivalent.
- Top accessibility evidence: at most 8 bullets. Group related axe violations and human-review risks by affected area; cite compact ids/targets only.
- Reviewer focus: one short line each for semantic, keyboard, cognitive, visual, and preservation specialists. Name only what that specialist should uniquely verify.
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
${WCAG_REFERENCE}
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
- Work in this order: preserve truth and task flow; fix deterministic check failures; resolve reviewer vote issues from prior iterations; improve human accessibility; preserve recognizable visual identity.
- Start from the best prior transformed.html when it kept the original content and vibe. If transformed.html does not exist, copy original.html to transformed.html with cp, then edit transformed.html in place. If a prior transformed.html became generic or lost content, restore from original.html with targeted copies or by replacing transformed.html from original.html once, then improve it.
- Make the clearest effective accessibility change, even if it restructures the page. Prefer understandable, robust, accessible UI over preserving fragile original layout details. Keep original assets and hrefs unless broken, inaccessible, or replaced with an equivalent accessible fallback.
- When adding CSS overrides for Tailwind-like classes that contain slash opacity, escape the slash in selectors and cover every used variant in transformed.html; examples include text-foreground/60 and bg-background/85.
- If an issue is uncertain and changing it risks content loss or false claims, preserve the original and record the residual risk.
- Ensure transformed.html can be served directly from the run directory without external build steps.

solver-result.json must be valid JSON. Keep at least this compatible shape and add simple fields if helpful:
{ "changed": true, "summary": "string", "accessibilityFixes": ["string"], "preservationNotes": ["string"], "removedContent": ["string"], "residualRisks": ["string"], "resolvedFindings": ["string"], "unresolvedFindings": ["string"] }`,
  // Votes run after automated checks. They should use checks.json as the compact
  // source of truth, and only open checks-full.json if a specific compact node is
  // too ambiguous to judge.
  votePrompt: (
    { runDir, iterDir },
    reviewer,
  ) => `You are the ${reviewer.name}. Re-review transformed.html and vote on whether this candidate should be accepted.

Run directory: ${runDir}
Use brief.md and compact current artifacts; do not re-load unchanged source artifacts wholesale.
Specialist rubric:
${reviewerRubrics[reviewer.id] || "Use the reviewer role described above. Ground every issue in WCAG, user impact, and observable evidence."}

${SPECIALIST_REVIEW_METHOD}

Available current files:
${fileList([
  join(runDir, "brief.md"),
  join(runDir, "transformed.html"),
  join(iterDir, "checks.json"),
  `${join(iterDir, "checks-full.json")} (targeted debugging only after citing a compact violation id/target)`,
  join(iterDir, "solver-result.json"),
])}
${TARGETED_EVIDENCE}
${WCAG_REFERENCE}
Output: ${join(iterDir, "votes", `${reviewer.id}.json`)}

Compare transformed.html against the original evidence, brief, solver result, and automated checks. Vote on accessibility improvement, task success, content retention, and recognizable brand vibe. Do not penalize layout changes by themselves.

When reporting issues, prefer WCAG-backed, user-impacting findings over generic advice. A valid finding needs element/section evidence, user impact, and a concrete fix. Do not invent missing content or fail a page for subjective style preference.

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

Write valid JSON. Keep these compatible fields and add the simple arrays:
{ "vote": "accept" | "revise" | "block", "score": number, "reason": "short reason", "blockingIssues": ["id or short issue"], "resolvedFindings": ["id or short issue"], "unresolvedFindings": ["id or short issue"] }`,
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
- Use continue when checks fail, reviewer JSON lists blockingIssues or unresolvedFindings, reviewers request revise, or the candidate passes axe but still drops important content, loses links/images, loses brand vibe, has ambiguous CTAs, breaks task flow, or looks like a generic page.
- Treat failed axe color-contrast as fixable after a color/theme change unless the failure has already persisted through a targeted color-repair iteration or the run has exhausted its iteration budget.
- Use stop_with_risks only when further iterations are unlikely to improve within this run, and explain the residual risks clearly.
- If the transformed page appears worse than original, destructive, generic, or content-poor, prefer continue unless retry limits or repeated failures make stop_with_risks more honest. Do not continue solely because layout changed.

The reason should mention the decisive evidence: automated pass/fail, accept/block counts, unresolved specialist issues, and preservation status.`,
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

// WCAG reference lookup. axe tags every WCAG rule as `wcag` + the success
// criterion number with dots removed (1.4.3 -> wcag143), so mapping those tags
// to the generated reference points each compact violation straight at the
// criterion the fixer should read. Built by `npm run build:wcag`.
type WcagEntry = { title: string; level: string; slug: string; file: string };
type WcagMap = {
  criteria: Record<string, WcagEntry>;
  tags: Record<string, string>;
};

let wcagMapCache: WcagMap | null | undefined;

function wcagMap(): WcagMap | null {
  if (wcagMapCache !== undefined) return wcagMapCache;
  try {
    const path = fileURLToPath(
      new URL("../reference/wcag/wcag-map.json", import.meta.url),
    );
    wcagMapCache = JSON.parse(readFileSync(path, "utf8")) as WcagMap;
  } catch {
    // The reference is optional; without it, violations simply carry no SC refs.
    wcagMapCache = null;
  }
  return wcagMapCache;
}

// Resolves an axe violation's tags to the WCAG success criteria they map to,
// each with a pointer into reference/wcag/sc/ for the normative text.
function wcagForTags(tags: unknown) {
  const map = wcagMap();
  const tagList = stringArray(tags);
  if (!map || !tagList) return undefined;
  const refs: { sc: string; title: string; level: string; ref: string }[] = [];
  const seen = new Set<string>();
  for (const tag of tagList) {
    const sc = map.tags[tag];
    if (!sc || seen.has(sc)) continue;
    seen.add(sc);
    const entry = map.criteria[sc];
    if (!entry) continue;
    refs.push({
      sc,
      title: entry.title,
      level: entry.level,
      ref: `reference/wcag/${entry.file}`,
    });
  }
  return refs.length ? refs : undefined;
}

// Agent prompts read compact axe artifacts by default. Raw axe output is kept
// in sidecar files, so the compact form keeps rule metadata, a small node
// sample, and extra locators without flooding the context window.
//
// Exported (not on the public runSwarm API) so unit tests can pin slicing,
// group-merging, and tag-enrichment behavior without spinning up Chromium.
export function compactAxeViolations(violations: AxeViolationInput[]) {
  return violations.map((violation) => {
    const nodes = violation.nodes || [];
    const sampledNodes = nodes.slice(0, AXE_NODE_SAMPLE_LIMIT);
    const sampledTargets = new Set(
      sampledNodes.map((node) => JSON.stringify(truncateAxeTarget(node.target))),
    );
    // Omitted nodes still need locators for repeated failures, but not their
    // full HTML/check payloads. De-dup against sampled keeps the same
    // selector from appearing twice in a violation.
    const additionalTargets: unknown[][] = [];
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
      wcag: wcagForTags(violation.tags),
      nodeCount: nodes.length,
      nodes: sampledNodes.map((node) => {
        const checks = compactNodeChecks(node);
        return omitUndefinedFields({
          target: truncateAxeTarget(node.target),
          impact: node.impact || undefined,
          html: truncateEvidenceText(node.html, AXE_HTML_LIMIT),
          failureSummary: truncateEvidenceText(node.failureSummary, AXE_FAILURE_SUMMARY_LIMIT),
          checks: checks.length ? checks : undefined,
        });
      }),
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

// Axe groups checks into `any`/`all`/`none`. The compact form merges all three
// with the group label preserved (frontends sort by this), then slices once
// across the union so the cap is global, not per-group.
function compactNodeChecks(node: AxeNodeInput) {
  const groups: [string, AxeCheckInput[] | undefined][] = [
    ["any", node.any],
    ["all", node.all],
    ["none", node.none],
  ];
  return groups
    .flatMap(([type, checks]) =>
      (checks || []).map((check) =>
        omitUndefinedFields({
          type,
          id: check.id,
          impact: check.impact || undefined,
          message: truncateEvidenceText(check.message, AXE_CHECK_MESSAGE_LIMIT),
        }),
      ),
    )
    .slice(0, AXE_NODE_CHECK_LIMIT);
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
    if (!sendStaticFile(root, file, res)) {
      res.writeHead(404).end("Not found");
      return;
    }
  });
  const port = await listen(server, preferredPort);
  return { server, port };
}
