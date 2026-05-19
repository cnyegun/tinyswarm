import { AxeBuilder } from "@axe-core/playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";
import type { CheckResult, Decision, SwarmProfile } from "./core.js";

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

const reviewers = [
  { id: "semantic", name: "screen-reader/semantic structure reviewer" },
  { id: "keyboard", name: "keyboard and motor access reviewer" },
  { id: "cognitive", name: "cognitive load and task clarity reviewer" },
  { id: "visual", name: "low-vision, contrast, zoom, mobile reviewer" },
];

export const accessibilityProfile: SwarmProfile = {
  id: "accessibility",
  artifact: "transformed.html",
  reviewers,
  scan,
  check,
  briefPrompt: ({
    runDir,
  }) => `You are the swarm orchestrator for an accessibility remediation run. Read the source page evidence and write a practical, preservation-focused accessibility brief for specialist reviewers and the fixer.

Run directory: ${runDir}
Inputs:
- ${join(runDir, "original.html")}
- ${join(runDir, "facts.json")}
- ${join(runDir, "axe.json")}

Output: ${join(runDir, "brief.md")}

Use WCAG 2.2, WAI Easy Checks, WAI-ARIA Authoring Practices, WebAIM-style pragmatic testing, Inclusive Design Principles, and accessibility usability guidance as references. Treat axe as useful evidence, not a complete evaluation.

Write brief.md with these sections:
- Page purpose and user tasks: infer the actual purpose from original.html and facts.json without inventing a new campaign, event, product, or organization.
- Preservation inventory: list concrete brand/signature elements, section order, copy themes, CTAs, links, image/logo assets, schedule details, judging criteria, sponsor/partner information, and any unique visual tone that must survive remediation.
- Allowed removals: only identify content that may be removed if evidence supports it, such as a Lovable badge, duplicated decorative clutter, inaccessible duplicate controls with an accessible equivalent, or empty generated wrappers. Do not authorize removal of substantive content.
- Initial accessibility evidence: summarize axe violations by id and affected area, plus likely semantic, keyboard, cognitive, and visual risks that need human review.
- Reviewer focus: assign category-specific criteria. Screen-reader/semantic reviewers should check names, roles, landmarks, heading hierarchy, text alternatives, language, reading order, and link purpose. Keyboard reviewers should check focus order, activation, traps, visible focus, target size, skip/bypass needs, and pointer-only behavior. Cognitive reviewers should check task clarity, CTA meaning, form/instruction clarity, content simplification risks, and whether original information remains understandable. Visual reviewers should check contrast, reflow, zoom, spacing, responsive behavior, non-text contrast, focus appearance, and mobile overflow.
- Acceptance bar: passing automated checks is required but not sufficient. Acceptable remediation must improve accessibility while preserving the original page identity and materially all user-relevant content.

Be evidence-based. If something is uncertain, mark it as uncertain rather than turning it into a requirement. Write only files inside the run directory.`,
  findingsPrompt: (
    { runDir, iterDir, iteration },
    reviewer,
  ) => `You are the ${reviewer.name}. Review iteration ${iteration} as a specialist accessibility detector. Your job is to produce specific, evidence-based findings, not generic advice.

Run directory: ${runDir}
Read original.html, facts.json, axe.json, brief.md, transformed.html if present, ${join(iterDir, "checks.json")} if present, and prior iteration artifacts if useful.
Output: ${join(iterDir, "findings", `${reviewer.id}.json`)}

Ground every finding in observable evidence from the files. Cite concrete element text, heading text, link text/href, image src/alt, section names, axe violation ids/nodes, or before/after differences. Do not hallucinate failures. If you cannot locate the affected content, do not report it as a finding.

Use this severity model when deciding risk:
- high: blocks key tasks, drops important original content, creates an inaccessible control/path, causes a serious WCAG failure, or substantially flattens brand/content into a generic page.
- medium: likely impairs comprehension, navigation, reading order, link purpose, focus visibility, contrast, zoom/reflow, or content preservation but has a workaround.
- low: minor polish, ambiguous improvement, or advisory issue with limited user impact.

Role-specific criteria:
- semantic: WCAG 1.1.1, 1.3.1, 1.3.2, 2.4.2, 2.4.4, 2.4.6, 3.1.1, 4.1.2; landmark structure; one meaningful h1; heading hierarchy; accessible names/descriptions; alt text that is equivalent in context; avoid ARIA when native HTML is enough.
- keyboard: WCAG 2.1.1, 2.1.2, 2.4.1, 2.4.3, 2.4.7, 2.4.11, 2.5.3, 2.5.8; all interactive elements reachable and operable; no pointer-only affordances; logical tab order; visible unobscured focus; target size and spacing.
- cognitive: WCAG 2.4.4, 2.4.6, 3.2.x, 3.3.x where applicable; clear CTA purpose; labels/instructions; predictable navigation; understandable schedule/judging/partner information; no destructive rewriting or vague marketing replacement.
- visual: WCAG 1.4.1, 1.4.3, 1.4.4, 1.4.10, 1.4.11, 1.4.12, 2.4.7, 2.4.13; contrast; text spacing; 200 percent zoom/reflow; mobile layout; non-text contrast; focus appearance; preserve distinctive visual identity where possible.

When transformed.html exists, compare it against original.html, facts.json, brief.md, and the preservation inventory. Flag regressions if important copy, CTAs, links, logos/images, schedule details, judging criteria, partner information, or brand feel were lost without accessibility justification. Passing axe does not excuse these regressions.

Prefer typed findings in the findings array using compact strings with this pattern: id=<role>-N | category=<semantic|keyboard|cognitive|visual|preservation|automated> | severity=<low|medium|high> | confidence=<low|medium|high> | location=<specific element/section/text> | evidence=<observable fact> | issue=<user impact> | suggestedFix=<faithful remediation>. The JSON contract still requires findings to be an array of strings, so keep each record as one string.

If no issue is proven, use an empty findings array and risk low. Do not edit transformed.html.

Write exactly this JSON shape:
{ "role": "${reviewer.id}", "findings": ["id=${reviewer.id}-1 | category=... | severity=... | confidence=... | location=... | evidence=... | issue=... | suggestedFix=..."], "risk": "low" | "medium" | "high" }`,
  aggregatePrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the swarm orchestrator. Aggregate specialist findings for iteration ${iteration} into an evidence-first remediation task. Normalize, deduplicate, and prioritize; do not invent issues that reviewers did not support with evidence.

Run directory: ${runDir}
Read brief.md, original.html, facts.json, axe.json, transformed.html if present, ${join(iterDir, "findings")}/*.json, and prior iterations if useful.
Outputs:
- ${join(iterDir, "aggregate-feedback.json")}
- ${join(iterDir, "solver-task.md")}

aggregate-feedback.json must remain compatible with this shape:
{ "summary": "string", "priorities": ["short task"], "risks": ["short risk"] }
You may make the strings rich and structured. Include evidence ids, severity, confidence, category, source reviewer, affected original/transformed content, and whether the item is a must-fix, should-fix, preservation guardrail, or residual risk.

Build a score-driven priority order:
- Critical preservation regressions and blocked key tasks outrank cosmetic accessibility tweaks.
- Axe violations and deterministic check failures are must-fix, but automated pass is not enough.
- Semantic and usability findings need evidence and confidence. Do not let a low-confidence hallucinated finding drive destructive changes.
- If the current transformed.html is worse than original because it dropped content or became a generic landing page, instruct the fixer to restore from original first, then remediate narrowly.

solver-task.md should tell the fixer exactly what to change and what not to change. Include these sections:
- Objective: faithful accessibility remediation of the original page, not a generic replacement.
- Source of truth: original.html, facts.json, axe.json, brief.md, and this aggregate feedback.
- Preservation requirements: preserve original brand feel, section order, substantive copy, CTAs, link destinations/text meaning, images/logos unless decorative, schedule details, judging criteria, partner/sponsor information, and any distinctive visual language unless accessibility requires a targeted adjustment.
- Allowed removals: only the Lovable badge, purely decorative duplicated content, empty wrappers, or duplicate inaccessible controls when an accessible equivalent remains. Require a short justification for each removal.
- Must-fix accessibility items: list each supported issue with evidence, affected element/section, user impact, and acceptance criteria.
- Faithful remediation constraints: prefer semantic HTML, corrected names/labels/alt text, contrast/focus/reflow CSS, and small structural repairs over wholesale redesign. Do not replace the page with a generic hero/features/testimonials/contact template. Do not rewrite CTAs into vague labels. Do not drop links or images to make axe pass.
- Color/theme repair guardrail: treat background, foreground, muted, accent, link, and CTA/button colors as a paired system. If a task changes dark/light background utilities, also require matching foreground utilities, slash-opacity variants, bg-background opacity variants, body background, and default anchor/CTA colors so computed contrast passes. Do not accept token-name fixes without computed foreground/background contrast evidence.
- Acceptance criteria: valid standalone HTML, title, exactly one h1, main landmark, no axe violations, no mobile horizontal overflow, visible focus styles, responsive layout, improved accessibility score, preserved key content and identity, no unsupported removals.
- Solver evidence request: solver-result.json should include changed, summary, accessibilityFixes, preservationNotes, removedContent, and residualRisks if useful, while remaining simple JSON.

Write only these files.`,
  fixPrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the fixer. Apply solver-task.md for iteration ${iteration}. Your output must be a faithful accessibility remediation of the original page, not a generic replacement landing page.

Run directory: ${runDir}
Read original.html, facts.json, axe.json, brief.md, ${join(iterDir, "aggregate-feedback.json")}, and ${join(iterDir, "solver-task.md")}.
Outputs:
- ${join(runDir, "transformed.html")}
- ${join(iterDir, "solver-result.json")}

Hard constraints:
- Produce valid standalone HTML in transformed.html.
- Keep the original page purpose, brand feel, visual tone, section order, substantive copy, CTAs, links, images/logos, schedule details, judging criteria, partner/sponsor information, and other user-relevant details unless solver-task.md identifies an accessibility reason to change them.
- Do not create a generic hero/features/testimonials/contact page. Do not replace specific event or organization content with vague marketing filler. Do not invent new dates, sponsors, judging criteria, links, or claims.
- Only remove the Lovable badge, purely decorative duplicated content, empty wrappers, or duplicate inaccessible controls when an accessible equivalent remains and the removal is justified in solver-result.json.
- Passing axe is required but not sufficient. Also preserve content and improve human accessibility.
- Color fixes must repair the whole computed color system, not a single class. If restoring or changing backgrounds, also verify and fix body/html background, text-foreground, text-foreground slash-opacity variants, text-muted-foreground, accent text, bg-background slash-opacity variants, default anchors, and CTA/button foreground/background colors.

Required accessibility baseline:
- Meaningful title, page language when known, exactly one h1, main landmark, sensible landmarks/sections, logical heading hierarchy, and DOM order matching visual/reading order.
- Accessible names for links, buttons, controls, and images. Link and CTA text must remain specific enough to convey purpose in context. Alt text must be equivalent in context; decorative images need empty alt, not fabricated descriptions.
- Keyboard operability for every interactive element, no keyboard traps, logical focus order, visible focus indicator with sufficient contrast, and no pointer-only behavior.
- Sufficient color contrast for text and meaningful graphics, no reliance on color alone, responsive layout without mobile horizontal overflow, and reflow/zoom-friendly spacing.
- Use native HTML before ARIA. If ARIA is needed, follow WAI-ARIA Authoring Practices for roles, states, properties, names, keyboard behavior, and landmarks.

Implementation guidance:
- Start from original.html or the best prior transformed.html only if it preserved the original well. If prior output became generic or lost content, rebuild from original.html and apply targeted fixes.
- Make the smallest effective changes for each supported finding. Keep original assets and hrefs unless broken or inaccessible with no safe repair.
- When adding CSS overrides for Tailwind-like classes that contain slash opacity, escape the slash in selectors and cover every used variant in transformed.html; examples include text-foreground/60 and bg-background/85.
- If an issue is uncertain and changing it risks content loss or false claims, preserve the original and record the residual risk.
- Ensure transformed.html can be served directly from the run directory without external build steps.

solver-result.json must be valid JSON. Keep at least this compatible shape and add simple fields if helpful:
{ "changed": true, "summary": "string", "accessibilityFixes": ["string"], "preservationNotes": ["string"], "removedContent": ["string"], "residualRisks": ["string"] }`,
  votePrompt: (
    { runDir, iterDir },
    reviewer,
  ) => `You are the ${reviewer.name}. Re-review transformed.html and vote on whether this candidate should be accepted.

Run directory: ${runDir}
Read transformed.html, ${join(iterDir, "checks.json")}, original.html, facts.json, axe.json, brief.md, ${join(iterDir, "aggregate-feedback.json")}, ${join(iterDir, "solver-task.md")}, and ${join(iterDir, "solver-result.json")}.
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
  decisionPrompt: ({
    runDir,
    iterDir,
    iteration,
  }) => `You are the swarm orchestrator. Decide whether iteration ${iteration} is done. Do not accept merely because automated checks pass.

Run directory: ${runDir}
Read ${join(iterDir, "checks.json")}, brief.md, ${join(iterDir, "aggregate-feedback.json")}, ${join(iterDir, "solver-task.md")}, ${join(iterDir, "solver-result.json")}, and ${join(iterDir, "votes")}/*.json.
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
  reportPrompt: (
    { runDir },
    decision?: Decision,
  ) => `You are the swarm orchestrator. Write the final accessibility remediation report. The report should be useful for auditing, not just a success message.

Run directory: ${runDir}
Final decision: ${JSON.stringify(decision || null)}
Read brief.md, facts.json, axe.json, transformed.html if present, iterations/*/aggregate-feedback.json, iterations/*/solver-result.json, iterations/*/checks.json, votes, and decision.json.
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
    writeFileSync(join(runDir, "axe.json"), JSON.stringify(axe, null, 2));
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
    axeViolations = axe.violations;
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
  return {
    passed: failures.length === 0,
    failures,
    title: dom.title,
    h1: dom.h1,
    main: dom.main,
    mobileOverflow,
    axeViolations,
  };
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(readFileSync(file));
  });
  const port = await listen(server, preferredPort);
  return { server, port };
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
