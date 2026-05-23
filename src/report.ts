import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Decision,
  type RunState,
  artifactSummary,
  duration,
  emit,
  fileState,
  latestIteration,
  log,
  progress,
  shown,
} from "./core.js";

type VoteSummary = {
  id: string;
  name: string;
  vote: string;
  score?: number;
  reason: string;
};

type ReportInputs = {
  latest: string;
  decision?: Decision;
  checks?: Record<string, unknown>;
  solver?: Record<string, unknown>;
  votes: VoteSummary[];
  originalAxe?: Record<string, unknown>;
};

type ReportTone = "success" | "warning" | "error" | "info";

// Each row in the violations panel pairs an original axe rule with whether the
// final checks still flag it. Empty list -> the panel is skipped entirely.
type ViolationRow = {
  id: string;
  help: string;
  wcag?: string;
  count: number;
  status: "fixed" | "remains";
};

// One simple card per agent. The orchestrator and fixer always render; one card
// is added per reviewer that actually voted. summary is a short excerpt only —
// the full reason stays on disk in votes/<id>.json for anyone who wants it.
type AgentCard = {
  role: "orchestrator" | "fixer" | "reviewer";
  title: string;
  vote?: string;
  voteTone?: ReportTone;
  score?: number;
  summary: string;
};

/**
 * Writes the human-facing report after the loop has a final decision.
 *
 * Report generation is deterministic and local so the accepted artifact is not
 * held behind one more model call. The report deliberately summarizes only
 * compact artifacts that the workflow already produced.
 */
export function writeFinalReport(run: RunState, decision?: Decision) {
  const reportStarted = Date.now();
  const outputs = [join(run.runDir, "report.md"), join(run.runDir, "report.html")];
  log(run, "report", "start", { decision });
  emit(run, {
    type: "prompt",
    phase: "report",
    agent: "local",
    status: "start",
    outputs: outputs.map((path) => shown(run.rootDir, path)),
  });
  progress(run, "report", "writing local report");

  const latest = latestIteration(run.runDir);
  const iterDir = latest ? join(run.runDir, "iterations", latest) : undefined;
  const checks = iterDir
    ? readJsonObject(join(iterDir, "checks.json"))
    : undefined;
  const solver = iterDir
    ? readJsonObject(join(iterDir, "solver-result.json"))
    : undefined;
  const votes = iterDir ? readVoteSummaries(run, iterDir) : [];
  const originalAxe = readJsonObject(join(run.runDir, "axe.json"));
  const report = {
    latest,
    decision,
    checks,
    solver,
    votes,
    originalAxe,
  };
  const markdown = reportMarkdown(run, report);
  const html = reportHtml(run, report);

  writeFileSync(outputs[0], markdown);
  writeFileSync(outputs[1], html);
  const outputFiles = outputs.map((path) => fileState(run.rootDir, path));
  log(run, "report", "written", {
    elapsedMs: Date.now() - reportStarted,
    outputs: outputFiles,
  });
  emit(run, {
    type: "prompt",
    phase: "report",
    agent: "local",
    status: "done",
    outputs: outputFiles,
  });
  progress(
    run,
    "report",
    `done ${duration(reportStarted)} ${artifactSummary(run.rootDir, outputs)}`,
  );
}

function readVoteSummaries(run: RunState, iterDir: string): VoteSummary[] {
  return run.profile.reviewers.flatMap((reviewer) => {
    const data = readJsonObject(join(iterDir, "votes", `${reviewer.id}.json`));
    if (!data) return [];
    return [
      {
        id: reviewer.id,
        name: reviewer.name,
        vote: stringValue(data.vote) || "unknown",
        score: numberValue(data.score),
        reason: stringValue(data.reason) || "no reason recorded",
      },
    ];
  });
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// Pairs every original axe violation with whether the final checks still flag
// it. Missing axe.json -> empty list -> caller skips the panel entirely.
function buildViolations(report: ReportInputs): ViolationRow[] {
  const originals = axeViolationsArray(report.originalAxe);
  if (!originals.length) return [];
  const remainingIds = new Set(
    axeViolationsArray(report.checks as Record<string, unknown> | undefined)
      .map((v) => stringValue(v.id))
      .filter((id): id is string => Boolean(id)),
  );
  return originals.flatMap((v) => {
    const id = stringValue(v.id);
    if (!id) return [];
    const help = stringValue(v.help) || id;
    const count = numberValue(v.nodeCount) ??
      (Array.isArray(v.nodes) ? v.nodes.length : 0);
    return [{
      id,
      help: compactText(help),
      wcag: firstWcagSc(v.wcag),
      count,
      status: remainingIds.has(id) ? "remains" : "fixed",
    }];
  });
}

// axe results live under different keys on disk: `violations` in axe.json from
// the scan, `axeViolations` in checks.json from the per-iteration validator.
function axeViolationsArray(
  source: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const list = source?.violations ?? source?.axeViolations;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (v): v is Record<string, unknown> =>
      Boolean(v) && typeof v === "object" && !Array.isArray(v),
  );
}

// Compact axe carries a wcag[] array per violation. First entry is enough for a
// small badge in the report; the full mapping stays in axe-full.json.
function firstWcagSc(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const first = value[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  return stringValue((first as Record<string, unknown>).sc);
}

// One card per agent that ran: orchestrator + fixer always render, plus one per
// reviewer with a vote. Each card carries a short excerpt only; full text is
// available via the artifact links.
function buildAgentCards(report: ReportInputs): AgentCard[] {
  const cards: AgentCard[] = [
    {
      role: "orchestrator",
      title: "Orchestrator",
      summary: "Wrote the run brief: page purpose, content to preserve, and reviewer focus.",
    },
    {
      role: "fixer",
      title: "Fixer",
      summary: fixerHighlight(report.solver),
    },
  ];
  for (const vote of report.votes) {
    cards.push({
      role: "reviewer",
      title: vote.name,
      vote: vote.vote,
      voteTone: voteTone(vote.vote),
      score: vote.score,
      summary: excerpt(vote.reason, 220),
    });
  }
  return cards;
}

function fixerHighlight(solver: Record<string, unknown> | undefined): string {
  if (!solver) return "No fixer summary recorded.";
  const summary = stringValue(solver.summary);
  const fixes = stringArray(solver.accessibilityFixes);
  if (summary && fixes.length)
    return excerpt(`${fixes.length} ${plural(fixes.length, "fix")} applied. ${summary}`, 220);
  if (summary) return excerpt(summary, 220);
  if (fixes.length)
    return excerpt(`${fixes.length} ${plural(fixes.length, "fix")} applied. ${fixes[0]}`, 220);
  return "No fixer summary recorded.";
}

function voteTone(vote: string): ReportTone {
  if (vote === "accept") return "success";
  if (vote === "block") return "error";
  if (vote === "revise") return "warning";
  return "info";
}

// Tighter cap than compactText (360). Card bodies need to skim quickly; full
// text is in the source artifacts linked from the Artifacts section.
function excerpt(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

function reportView(run: RunState, report: ReportInputs) {
  const failures = stringArray(report.checks?.failures);
  const fixes = stringArray(report.solver?.accessibilityFixes);
  const preservation = stringArray(report.solver?.preservationNotes);
  const removed = stringArray(report.solver?.removedContent);
  const risks = stringArray(report.solver?.residualRisks);
  const solverSummary = stringValue(report.solver?.summary);
  const changeSummary = fixes.length
    ? fixes
    : solverSummary
      ? [solverSummary]
      : ["No solver summary was recorded."];
  const riskSummary = risks.length
    ? risks
    : ["No residual risks were recorded by the fixer or decision step."];
  if (report.decision?.outcome === "stop_with_risks" && report.decision.reason)
    riskSummary.unshift(report.decision.reason);

  const checksKnown = !!report.checks;
  const checksPassed = report.checks?.passed === true;
  const axeViolations = Array.isArray(report.checks?.axeViolations)
    ? report.checks.axeViolations.length
    : undefined;
  const accepts = report.decision?.accepts ?? 0;
  const blocks = report.decision?.blocks ?? 0;
  const usage = run.usage;
  const checkTone: ReportTone = !checksKnown
    ? "info"
    : checksPassed
      ? "success"
      : "error";
  const outcomeTone: ReportTone = report.decision?.outcome === "accept"
    ? "success"
    : report.decision?.outcome === "continue" ||
        report.decision?.outcome === "stop_with_risks"
      ? "warning"
      : "info";

  return {
    profile: compactText(run.profile.id),
    input: compactText(run.input),
    latest: report.latest || "none",
    decision: report.decision?.outcome || "unknown",
    decisionReason: compactText(
      report.decision?.reason || "No decision reason recorded.",
    ),
    checks: checkStatus(report.checks),
    reviewerTally: `${accepts} accept, ${blocks} block`,
    usageCost: usageCostValue(usage),
    usageTokens: usageTokenValue(usage),
    violations: buildViolations(report),
    agents: buildAgentCards(report),
    changeSummary,
    preservationSummary: preservation.length
      ? preservation
      : [
          "Review the final artifact against the source page for content, task flow, and brand/vibe preservation.",
        ],
    removed,
    votes: report.votes,
    failures,
    riskSummary,
    artifacts: artifactLinks(run, report.latest),
    outcomeTone,
    checkTone,
    metrics: [
      {
        label: "Final iteration",
        value: report.latest || "none",
        detail: "Run loop result",
        tone: "info" as ReportTone,
      },
      {
        label: "Automated checks",
        value: checksKnown ? (checksPassed ? "Passed" : "Failed") : "Not available",
        detail: checkStatus(report.checks),
        tone: checkTone,
      },
      {
        label: "Axe violations",
        value: axeViolations === undefined ? "Not recorded" : String(axeViolations),
        detail: "Browser-computed axe result",
        tone: axeViolations === undefined
          ? "info" as ReportTone
          : axeViolations === 0
            ? "success" as ReportTone
            : checkTone,
      },
      {
        label: "Reviewer tally",
        value: `${accepts} accept / ${blocks} block`,
        detail: report.votes.length
          ? `${report.votes.length} reviewer ${plural(report.votes.length, "vote")}`
          : "No reviewer votes recorded",
        tone: blocks > 0 ? "warning" as ReportTone : "info" as ReportTone,
      },
      {
        label: "AI cost",
        value: usageCostValue(usage),
        detail: usage
          ? "Reported by opencode/provider"
          : "Provider did not return usage",
        tone: "info" as ReportTone,
      },
      {
        label: "Tokens used",
        value: usageTokenValue(usage),
        detail: usageTokenDetail(usage),
        tone: "info" as ReportTone,
      },
    ],
  };
}

function reportMarkdown(run: RunState, report: ReportInputs) {
  const view = reportView(run, report);

  const lines = [
    "# Swarm Report",
    "",
    "## Outcome",
    `- Profile: ${view.profile}`,
    `- Input: ${view.input}`,
    `- Final iteration: ${view.latest}`,
    `- Decision: ${view.decision}`,
    `- Automated checks: ${view.checks}`,
    `- Reviewer tally: ${view.reviewerTally}`,
    `- AI cost: ${view.usageCost}`,
    `- Tokens used: ${view.usageTokens}`,
    `- Decision reason: ${view.decisionReason}`,
    ...(view.violations.length
      ? [
          "",
          "## Violations",
          ...view.violations.map(
            (row) =>
              `- ${row.id}${row.wcag ? ` (${row.wcag})` : ""}: ${row.help} — ${row.status === "fixed" ? "fixed" : "remains"} (${row.count} ${plural(row.count, "node")})`,
          ),
        ]
      : []),
    "",
    "## Implementation Summary",
    ...bulletLines(view.changeSummary),
    "",
    "## Preservation And Scope",
    ...bulletLines(view.preservationSummary),
    ...(view.removed.length
      ? ["", "## Removed Or Reworked Content", ...bulletLines(view.removed)]
      : []),
    "",
    "## Reviewer Votes",
    ...(view.votes.length
      ? view.votes.map(
          (vote) =>
            `- ${compactText(vote.name)}: ${compactText(vote.vote)}${vote.score === undefined ? "" : ` (${vote.score})`} - ${compactText(vote.reason)}`,
        )
      : ["- No reviewer votes were recorded for the final iteration."]),
    ...(view.failures.length
      ? ["", "## Check Failures", ...bulletLines(view.failures)]
      : []),
    "",
    "## Residual Risks And Limits",
    ...bulletLines([
      ...view.riskSummary,
      "Passing automated checks is useful evidence, not a full WCAG conformance claim.",
      "Manual keyboard, screen reader, zoom/reflow, responsive, and content-owner review should still verify production behavior.",
    ]),
    "",
    "## Artifacts",
    ...view.artifacts.map(
      (artifact) => `- [${artifact.label}](${artifact.href})`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function reportHtml(run: RunState, report: ReportInputs) {
  const view = reportView(run, report);
  const navItems = [
    { href: "#outcome", label: "Outcome" },
    { href: "#run-summary", label: "Run summary" },
    ...(view.violations.length
      ? [{ href: "#violations", label: "Violations" }]
      : []),
    { href: "#agents", label: "Agent breakdown" },
    { href: "#preservation", label: "Preservation and scope" },
    ...(view.removed.length
      ? [{ href: "#removed-content", label: "Removed or reworked content" }]
      : []),
    ...(view.failures.length
      ? [{ href: "#check-failures", label: "Check failures" }]
      : []),
    { href: "#residual-risks", label: "Residual risks and limits" },
    { href: "#artifacts", label: "Artifacts" },
    { href: "#accessibility-statement", label: "Accessibility statement" },
  ];
  const removedSection = view.removed.length
    ? `<section class="content-block" id="removed-content" aria-labelledby="removed-content-title">
        <h2 id="removed-content-title">Removed or reworked content</h2>
        ${htmlList(view.removed)}
      </section>`
    : "";
  const failuresSection = view.failures.length
    ? `<section class="content-block content-block--attention" id="check-failures" aria-labelledby="check-failures-title">
        <h2 id="check-failures-title">Check failures</h2>
        ${htmlList(view.failures)}
      </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swarm report</title>
  <style>
    :root {
      --color-primary: #003580;
      --color-primary-dark: #00265c;
      --color-primary-darker: #001a40;
      --color-primary-tint: #e6ebf3;
      --color-accent: #7b2d8e;
      --color-text: #1a1a1a;
      --color-text-muted: #595959;
      --color-text-inverse: #ffffff;
      --color-surface: #ffffff;
      --color-surface-subtle: #f3f3f3;
      --color-border: #c9c9c9;
      --color-border-input: #595959;
      --color-success: #0a7d3c;
      --color-success-bg: #e7f2eb;
      --color-warning: #8a6100;
      --color-warning-bg: #fbf0d4;
      --color-error: #b3171f;
      --color-error-bg: #fae7e8;
      --color-info: #003580;
      --color-info-bg: #e6ebf3;
      --font-sans: "Inter", "Helvetica Neue", Helvetica, Arial, "Liberation Sans", system-ui, sans-serif;
      --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --text-xs: 0.875rem;
      --text-sm: 1rem;
      --text-base: 1.125rem;
      --text-lg: 1.375rem;
      --text-xl: 1.75rem;
      --text-2xl: 2.25rem;
      --text-3xl: 2.75rem;
      --leading-tight: 1.25;
      --leading-normal: 1.6;
      --weight-regular: 400;
      --weight-semibold: 600;
      --weight-bold: 700;
      --space-1: 0.25rem;
      --space-2: 0.5rem;
      --space-3: 0.75rem;
      --space-4: 1rem;
      --space-5: 1.5rem;
      --space-6: 2rem;
      --space-7: 3rem;
      --space-8: 4rem;
      --space-9: 6rem;
      --layout-max: 1200px;
      --layout-gutter: var(--space-5);
      --radius: 0;
      --border-hairline: 1px solid var(--color-border);
      --focus-color: #1a1a1a;
      --focus-width: 3px;
      --focus-offset: 2px;
      --duration: 160ms;
      --easing: ease;
    }

    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: var(--text-base);
      font-weight: var(--weight-regular);
      line-height: var(--leading-normal);
    }
    a { color: var(--color-primary); text-decoration: underline; text-underline-offset: var(--space-1); }
    a:hover { color: var(--color-primary-dark); }
    a:focus-visible {
      outline: var(--focus-width) solid var(--focus-color);
      outline-offset: var(--focus-offset);
    }
    h1, h2, h3, p { margin-block-start: 0; }
    h1, h2, h3 { color: var(--color-text); }
    /* Heading scale matches DESIGN.md §5.2 exactly: line-heights per row, h1
       promoted to --color-primary (only the page h1 is allowed to use it). */
    h1 { color: var(--color-primary); font-size: var(--text-2xl); font-weight: var(--weight-bold); line-height: 1.2; letter-spacing: -0.02em; margin-block-end: var(--space-4); }
    h2 { font-size: var(--text-xl); font-weight: var(--weight-bold); line-height: 1.25; letter-spacing: -0.01em; margin-block-end: var(--space-4); }
    h3 { font-size: var(--text-lg); font-weight: var(--weight-semibold); line-height: 1.3; letter-spacing: -0.01em; margin-block-end: var(--space-3); }
    p { max-width: 70ch; margin-block-end: var(--space-4); }
    ul { margin-block: 0; padding-inline-start: var(--space-5); }
    li + li { margin-block-start: var(--space-2); }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: var(--space-3) var(--space-2); border-bottom: var(--border-hairline); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { border-bottom: var(--focus-offset) solid var(--color-text); font-weight: var(--weight-bold); }

    .layout { width: min(100% - calc(var(--layout-gutter) * 2), var(--layout-max)); margin-inline: auto; }
    .utility-bar { background: var(--color-primary); color: var(--color-text-inverse); font-size: var(--text-sm); }
    .utility-bar__inner { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: center; min-height: var(--space-7); }
    .utility-bar__link { color: var(--color-text-inverse); }
    .utility-bar__link:hover { color: var(--color-text-inverse); }
    .utility-bar__link:focus-visible, .site-footer a:focus-visible { outline-color: var(--color-text-inverse); }
    /* The 3px violet rule is DESIGN.md §8.1's optional brand detail -- the one
       sanctioned use of --color-accent on the page. */
    .brand-accent { height: 3px; background: var(--color-accent); }
    .brand-header { border-bottom: var(--border-hairline); background: var(--color-surface); }
    .brand-header__inner { display: grid; gap: var(--space-5); padding-block: var(--space-7); }
    .brand-header__eyebrow { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-bold); line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; margin-block-end: var(--space-2); }
    /* The 60×4px stripe under the page h1 is the valtioneuvosto.fi signature
       move, expressed with our existing --color-primary token. */
    .brand-header h1::after { content: ""; display: block; width: 60px; height: 4px; background: var(--color-primary); margin-block-start: var(--space-3); }
    .brand-header__lede { color: var(--color-text-muted); font-size: var(--text-base); margin-block-end: 0; }
    .action-list { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
    .button { display: inline-flex; align-items: center; min-height: var(--space-7); padding: var(--space-3) var(--space-5); border: var(--focus-offset) solid var(--color-primary); border-radius: var(--radius); font-size: var(--text-sm); font-weight: var(--weight-semibold); text-decoration: none; transition: background var(--duration) var(--easing); }
    .button--primary { background: var(--color-primary); color: var(--color-text-inverse); border-color: var(--color-primary); }
    .button--primary:hover { background: var(--color-primary-dark); color: var(--color-text-inverse); }
    .button--secondary { background: var(--color-surface); color: var(--color-primary); }
    .button--secondary:hover { background: var(--color-primary-tint); }
    .report-layout { display: grid; gap: var(--space-7); padding-block: var(--space-7) var(--space-8); }
    .section-nav { border: var(--border-hairline); background: var(--color-surface); }
    .section-nav__title { padding: var(--space-5); margin: 0; border-bottom: var(--border-hairline); font-size: var(--text-lg); }
    .section-nav__list { display: grid; }
    .section-nav__link { display: block; padding: var(--space-4); border-bottom: var(--border-hairline); color: var(--color-text); font-weight: var(--weight-bold); text-decoration: none; }
    .section-nav__link:hover { background: var(--color-surface-subtle); color: var(--color-primary); text-decoration: underline; }
    .report-content { display: grid; gap: var(--space-6); min-width: 0; }
    .status-banner, .content-block { border: var(--border-hairline); border-radius: var(--radius); padding: var(--space-5); background: var(--color-surface); }
    .status-banner { border-left: var(--space-1) solid var(--color-info); background: var(--color-info-bg); }
    .status-banner--success { border-left-color: var(--color-success); background: var(--color-success-bg); }
    .status-banner--warning { border-left-color: var(--color-warning); background: var(--color-warning-bg); }
    .status-banner--error { border-left-color: var(--color-error); background: var(--color-error-bg); }
    .status-banner__label { font-size: var(--text-sm); font-weight: var(--weight-bold); margin-block-end: var(--space-2); }
    .status-banner__meta { display: grid; gap: var(--space-2); margin: 0; }
    .status-banner__meta div { display: grid; gap: var(--space-1); }
    .status-banner__meta dt { color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
    .status-banner__meta dd { margin: 0; overflow-wrap: anywhere; }
    .content-block--attention { border-left: var(--space-1) solid var(--color-error); }
    .metric-grid { display: grid; gap: var(--space-5); margin: 0; }
    .metric-card { border: var(--border-hairline); padding: var(--space-5); background: var(--color-surface); }
    .metric-card--success { border-top: var(--space-1) solid var(--color-success); }
    .metric-card--warning { border-top: var(--space-1) solid var(--color-warning); }
    .metric-card--error { border-top: var(--space-1) solid var(--color-error); }
    .metric-card--info { border-top: var(--space-1) solid var(--color-info); }
    .metric-card dt { color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
    .metric-card dd { margin: 0; }
    .metric-card__value { display: block; margin-block: var(--space-2); font-size: var(--text-xl); font-weight: var(--weight-bold); line-height: var(--leading-tight); overflow-wrap: anywhere; }
    .metric-card__detail { color: var(--color-text-muted); font-size: var(--text-sm); }
    .content-list { display: grid; gap: var(--space-2); }
    .artifact-list { display: grid; gap: var(--space-3); padding-inline-start: 0; list-style: none; }
    .artifact-list__item { border-bottom: var(--border-hairline); padding-block-end: var(--space-3); }
    .data-table { font-size: var(--text-sm); }
    .violation-table code { background: var(--color-surface-subtle); padding: 0 var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs); }
    /* DESIGN.md §8.12: right-align numbers, zebra allowed where density
       requires it. The violations panel is the densest table here. */
    .violation-table td:nth-child(3) { text-align: right; }
    .violation-table tbody tr:nth-child(odd) { background: var(--color-surface-subtle); }
    .violation-status { font-weight: var(--weight-bold); white-space: nowrap; }
    .violation-status--fixed { color: var(--color-success); }
    .violation-status--remains { color: var(--color-error); }
    .agent-grid { display: grid; gap: var(--space-4); margin: 0; padding-inline-start: 0; list-style: none; }
    .agent-card { border: var(--border-hairline); padding: var(--space-5); background: var(--color-surface); display: grid; gap: var(--space-3); }
    .agent-card__header { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-start; justify-content: space-between; }
    .agent-card__role { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-bold); line-height: 1.4; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 var(--space-1) 0; }
    .agent-card__title { font-size: var(--text-base); font-weight: var(--weight-bold); margin: 0; }
    .agent-card__badge { display: inline-flex; align-items: center; padding: var(--space-1) var(--space-3); font-size: var(--text-xs); font-weight: var(--weight-bold); white-space: nowrap; }
    .agent-card__badge--success { background: var(--color-success-bg); color: var(--color-success); }
    .agent-card__badge--warning { background: var(--color-warning-bg); color: var(--color-warning); }
    .agent-card__badge--error { background: var(--color-error-bg); color: var(--color-error); }
    .agent-card__badge--info { background: var(--color-info-bg); color: var(--color-info); }
    .agent-card__summary { margin: 0; color: var(--color-text); font-size: var(--text-sm); line-height: var(--leading-normal); }
    .muted { color: var(--color-text-muted); }
    .site-footer { background: var(--color-primary-darker); color: var(--color-text-inverse); }
    .site-footer__inner { display: grid; gap: var(--space-5); padding-block: var(--space-7); }
    .site-footer a { color: var(--color-text-inverse); }
    .site-footer p { margin-block-end: 0; }

    @media (min-width: 768px) {
      h1 { font-size: var(--text-3xl); }
      .brand-header__inner { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
      .report-layout { grid-template-columns: minmax(calc(var(--space-8) * 4), calc(var(--space-9) * 3)) minmax(0, 1fr); align-items: start; }
      .section-nav { position: sticky; top: var(--space-5); }
      .status-banner__meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .site-footer__inner { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
    }

    @media (min-width: 768px) {
      .agent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (min-width: 1024px) {
      .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    @media (prefers-reduced-motion: reduce) {
      .button { transition: none; }
    }
  </style>
</head>
<body>
  <div class="utility-bar">
    <div class="layout utility-bar__inner">
      <a class="utility-bar__link" href="#main">Skip to main content</a>
      <span>Generated locally from run artifacts</span>
    </div>
  </div>
  <div class="brand-accent" aria-hidden="true"></div>
  <header class="brand-header">
    <div class="layout brand-header__inner">
      <div>
        <p class="brand-header__eyebrow">Accessibility AI Audit</p>
        <h1>Swarm report</h1>
        <p class="brand-header__lede">A deterministic summary of the final artifact, checks, reviewer votes, and residual risks.</p>
      </div>
      <nav class="action-list" aria-label="Report actions">
        <a class="button button--primary" href="${escapeHtml(run.profile.artifact)}">Open transformed artifact</a>
        <a class="button button--secondary" href="report.md">Open markdown report</a>
        <a class="button button--secondary" href="brief.md">Open brief</a>
      </nav>
    </div>
  </header>
  <main class="layout report-layout" id="main">
    <aside class="section-nav" aria-labelledby="section-nav-title">
      <h2 class="section-nav__title" id="section-nav-title">Report sections</h2>
      <nav class="section-nav__list" aria-label="Report sections">
        ${navItems.map((item) => `<a class="section-nav__link" href="${item.href}">${escapeHtml(item.label)}</a>`).join("\n        ")}
      </nav>
    </aside>
    <div class="report-content">
      <section class="status-banner status-banner--${view.outcomeTone}" id="outcome" aria-labelledby="outcome-title">
        <p class="status-banner__label">Outcome</p>
        <h2 id="outcome-title">Decision: ${escapeHtml(humanize(view.decision))}</h2>
        <p>${escapeHtml(view.decisionReason)}</p>
        <dl class="status-banner__meta">
          <div><dt>Profile</dt><dd>${escapeHtml(view.profile)}</dd></div>
          <div><dt>Input</dt><dd>${escapeHtml(view.input)}</dd></div>
          <div><dt>Automated checks</dt><dd>${escapeHtml(view.checks)}</dd></div>
          <div><dt>Reviewer tally</dt><dd>${escapeHtml(view.reviewerTally)}</dd></div>
        </dl>
      </section>

      <section class="content-block" id="run-summary" aria-labelledby="run-summary-title">
        <h2 id="run-summary-title">Run summary</h2>
        <dl class="metric-grid">
          ${view.metrics.map((metric) => `<div class="metric-card metric-card--${metric.tone}"><dt>${escapeHtml(metric.label)}</dt><dd><span class="metric-card__value">${escapeHtml(metric.value)}</span><span class="metric-card__detail">${escapeHtml(metric.detail)}</span></dd></div>`).join("\n          ")}
        </dl>
      </section>

      ${violationsSection(view.violations)}

      <section class="content-block" id="agents" aria-labelledby="agents-title">
        <h2 id="agents-title">Agent breakdown</h2>
        <p class="muted">What each agent in the swarm contributed during the final iteration.</p>
        ${agentCardsHtml(view.agents)}
      </section>

      <section class="content-block" id="preservation" aria-labelledby="preservation-title">
        <h2 id="preservation-title">Preservation and scope</h2>
        ${htmlList(view.preservationSummary)}
      </section>

      ${removedSection}

      ${failuresSection}

      <section class="content-block" id="residual-risks" aria-labelledby="residual-risks-title">
        <h2 id="residual-risks-title">Residual risks and limits</h2>
        ${htmlList([
          ...view.riskSummary,
          "Passing automated checks is useful evidence, not a full WCAG conformance claim.",
          "Manual keyboard, screen reader, zoom/reflow, responsive, and content-owner review should still verify production behavior.",
        ])}
      </section>

      <section class="content-block" id="artifacts" aria-labelledby="artifacts-title">
        <h2 id="artifacts-title">Artifacts</h2>
        <ul class="artifact-list">
          ${view.artifacts.map((artifact) => `<li class="artifact-list__item"><a href="${escapeHtml(artifact.href)}">${escapeHtml(artifact.label)}</a></li>`).join("\n          ")}
        </ul>
      </section>

      <section class="content-block" id="accessibility-statement" aria-labelledby="accessibility-statement-title">
        <h2 id="accessibility-statement-title">Accessibility statement</h2>
        <p>This generated report uses semantic landmarks, ordered headings, visible focus styles, high-contrast token pairings, and keyboard-operable links. The report itself is deterministic, but the transformed page still needs manual assistive-technology and content-owner review before any conformance claim.</p>
      </section>
    </div>
  </main>
  <footer class="site-footer">
    <div class="layout site-footer__inner">
      <p>Accessibility AI Audit report for ${escapeHtml(view.profile)}.</p>
      <p><a href="#accessibility-statement">Read the accessibility statement</a></p>
    </div>
  </footer>
</body>
</html>
`;
}

function htmlList(items: string[]) {
  return `<ul class="content-list">
          ${items.map((item) => `<li>${escapeHtml(compactText(item))}</li>`).join("\n          ")}
        </ul>`;
}

// Violations panel: skipped when the run produced no original axe.json or it
// had zero violations. Otherwise one row per original rule, tagged FIXED or
// REMAINS based on whether the final checks still flag it.
function violationsSection(rows: ViolationRow[]) {
  if (!rows.length) return "";
  const fixed = rows.filter((row) => row.status === "fixed").length;
  return `<section class="content-block" id="violations" aria-labelledby="violations-title">
        <h2 id="violations-title">Violations</h2>
        <p class="muted">${fixed} of ${rows.length} original axe ${plural(rows.length, "violation")} resolved.</p>
        <table class="data-table violation-table">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">WCAG</th>
              <th scope="col">Affected</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => violationRow(row)).join("\n            ")}
          </tbody>
        </table>
      </section>`;
}

function violationRow(row: ViolationRow) {
  const status = row.status === "fixed" ? "Fixed" : "Remains";
  return `<tr><th scope="row"><code>${escapeHtml(row.id)}</code> <span class="muted">${escapeHtml(row.help)}</span></th><td>${escapeHtml(row.wcag || "—")}</td><td>${row.count}</td><td class="violation-status violation-status--${row.status}">${status}</td></tr>`;
}

// Agent cards: predictable list of small cards in a grid. Each is just title +
// optional vote badge + a short summary excerpt. Full text stays on disk.
function agentCardsHtml(cards: AgentCard[]) {
  if (!cards.length)
    return `<p class="muted">No agent activity was recorded for the final iteration.</p>`;
  return `<ul class="agent-grid">
          ${cards.map((card) => agentCardHtml(card)).join("\n          ")}
        </ul>`;
}

function agentCardHtml(card: AgentCard) {
  const badge = card.vote
    ? `<span class="agent-card__badge agent-card__badge--${card.voteTone || "info"}">${escapeHtml(humanize(card.vote))}${card.score === undefined ? "" : ` · ${card.score}`}</span>`
    : "";
  return `<li class="agent-card"><div class="agent-card__header"><div><p class="agent-card__role">${escapeHtml(humanize(card.role))}</p><p class="agent-card__title">${escapeHtml(compactText(card.title))}</p></div>${badge}</div><p class="agent-card__summary">${escapeHtml(card.summary)}</p></li>`;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function checkStatus(checks?: Record<string, unknown>) {
  if (!checks) return "not available";
  const failures = stringArray(checks.failures);
  const axeViolations = Array.isArray(checks.axeViolations)
    ? checks.axeViolations.length
    : undefined;
  const status = checks.passed === true ? "passed" : "failed";
  const axe = axeViolations === undefined
    ? ""
    : `, ${axeViolations} axe ${plural(axeViolations, "violation")}`;
  return `${status} (${failures.length} ${plural(failures.length, "failure")}${axe})`;
}

function usageCostValue(usage: RunState["usage"]) {
  return usage ? `$${usage.total.cost.toFixed(4)}` : "Not reported";
}

function usageTokenValue(usage: RunState["usage"]) {
  if (!usage) return "Not reported";
  return formatNumber(
    usage.total.tokensIn + usage.total.tokensOut + usage.total.tokensReasoning,
  );
}

function usageTokenDetail(usage: RunState["usage"]) {
  if (!usage) return "Provider did not return usage";
  const { tokensIn, tokensOut, tokensReasoning, tokensCacheRead, tokensCacheWrite } = usage.total;
  const parts = [
    `input ${formatNumber(tokensIn)}`,
    `output ${formatNumber(tokensOut)}`,
  ];
  if (tokensReasoning) parts.push(`reasoning ${formatNumber(tokensReasoning)}`);
  if (tokensCacheRead) parts.push(`cache read ${formatNumber(tokensCacheRead)}`);
  if (tokensCacheWrite) parts.push(`cache write ${formatNumber(tokensCacheWrite)}`);
  return parts.join(", ");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function artifactLinks(run: RunState, latest: string) {
  const links = [
    { label: run.profile.artifact, href: run.profile.artifact },
    { label: "report.md", href: "report.md" },
    { label: "brief.md", href: "brief.md" },
  ];
  if (latest) {
    links.push(
      { label: "checks.json", href: `iterations/${latest}/checks.json` },
      { label: "decision.json", href: `iterations/${latest}/decision.json` },
      {
        label: "solver-result.json",
        href: `iterations/${latest}/solver-result.json`,
      },
    );
  }
  return links;
}

function bulletLines(items: string[]) {
  return items.map((item) => `- ${compactText(item)}`);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function compactText(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 360 ? `${clean.slice(0, 357)}...` : clean;
}

function plural(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
