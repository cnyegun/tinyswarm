import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic aggregator that replaces the LLM-driven `aggregatePrompt` step.
 *
 * Why deterministic:
 * - The AccessGuru paper (takeaway #1) recommends splitting work into typed
 *   categories with explicit detection and correction logic. Aggregation is
 *   merge + dedup + scoring — pure data work that does not need a language model.
 * - Removing this LLM call saves ~30-60s per iteration and reproduces exactly
 *   between runs, which is required for EU AI Act audit traceability.
 *
 * Input contract: each reviewer's findings/<id>.json contains:
 *   { role: string, findings: string[], risk: "low" | "medium" | "high" }
 * where each finding string follows the pipe-delimited convention from
 * accessibility.ts findingsPrompt:
 *   "id=<id> | category=<cat> | severity=<sev> | confidence=<conf> | location=<loc>
 *    | evidence=<ev> | issue=<iss> | suggestedFix=<fix>"
 *
 * Output contract preserves backward compatibility with the existing
 * aggregate-feedback.json + solver-task.md files produced by the previous
 * LLM step, so downstream prompts (fixer) keep working unchanged.
 */

export type Severity = "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";

export type ParsedFinding = {
  /** Raw original string, preserved for audit. */
  raw: string;
  id?: string;
  category?: string;
  severity?: Severity;
  confidence?: Confidence;
  location?: string;
  evidence?: string;
  issue?: string;
  suggestedFix?: string;
  /** Which reviewer reported this finding. */
  sourceReviewer: string;
};

export type ScoredFinding = ParsedFinding & {
  /** Weighted priority score: severity * confidence * sqrt(consensus). */
  score: number;
  /** Number of reviewers that reported a deduplicated-equivalent finding. */
  consensus: number;
};

export type AggregateResult = {
  summary: string;
  priorities: string[];
  risks: string[];
  /** Full scored finding list, for downstream tooling and audit. */
  scoredFindings: ScoredFinding[];
  /** Findings that appeared in this iter but not the previous (regression detection). */
  introducedFindings: ScoredFinding[];
  /** Non-fatal data quality warnings (missing files, non-string entries, etc.). */
  warnings: string[];
};

export type AggregateOptions = {
  iterDir: string;
  runDir: string;
  reviewers: Array<{ id: string; name: string }>;
  iteration: number;
  /** Default 8 — top-K priorities for solver-task.md. */
  topPriorities?: number;
  /** Default 6 — top-K risks for residual-risk reporting. */
  topRisks?: number;
  /** Previous iteration's iterDir, for regression detection. */
  previousIterDir?: string;
};

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 5, medium: 3, low: 1 };
const CONFIDENCE_WEIGHT: Record<Confidence, number> = { high: 1.0, medium: 0.7, low: 0.4 };

// ---------- Pure functions ----------

/**
 * Parse a single pipe-delimited finding string into a structured ParsedFinding.
 * Tolerant of missing fields and whitespace; unknown keys are ignored.
 */
export function parseFinding(raw: string, sourceReviewer: string): ParsedFinding {
  const finding: ParsedFinding = { raw, sourceReviewer };
  for (const part of raw.split("|")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) continue;
    switch (key) {
      case "id":
        finding.id = value;
        break;
      case "category":
        finding.category = value;
        break;
      case "severity":
        if (value === "low" || value === "medium" || value === "high") {
          finding.severity = value;
        }
        break;
      case "confidence":
        if (value === "low" || value === "medium" || value === "high") {
          finding.confidence = value;
        }
        break;
      case "location":
        finding.location = value;
        break;
      case "evidence":
        finding.evidence = value;
        break;
      case "issue":
        finding.issue = value;
        break;
      case "suggestedFix":
        finding.suggestedFix = value;
        break;
    }
  }
  return finding;
}

function normalizeLocation(loc?: string): string {
  if (!loc) return "";
  return loc.toLowerCase().replace(/['"`]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Generate a stable dedup key. Findings with the same key are merged into one
 * group; their consensus count is the number of reviewers reporting it.
 *
 * The key combines category + normalized location + first 50 chars of the
 * issue text. This handles the common case where two reviewers describe the
 * same problem with slightly different wording, while still allowing distinct
 * issues at the same location to remain separate.
 */
export function dedupKey(f: ParsedFinding): string {
  const cat = (f.category || "unknown").toLowerCase();
  const loc = normalizeLocation(f.location);
  const issuePrefix = (f.issue || "").slice(0, 50).toLowerCase().replace(/\s+/g, " ").trim();
  return `${cat}::${loc}::${issuePrefix}`;
}

const STOPWORDS = new Set([
  "the", "and", "has", "this", "that", "with", "for", "are", "was",
  "not", "but", "you", "your", "its", "from", "have", "been", "will",
  "does", "can", "should", "must", "may", "would", "could", "when",
  "where", "which", "what", "into", "onto", "upon", "over", "under",
  "also", "just", "only", "than", "then", "there", "their", "they",
  "them", "some", "such", "each", "more", "most", "very",
]);

const GENERIC_CONTAINER = new Set(["html", "body", "div", "span"]);

/**
 * Reduce a CSS-selector-style location string to its 2 most semantically
 * meaningful element types, stripping positional pseudo-selectors that vary
 * between iterations (e.g. `:nth-child(3)`).
 *
 * "html>body>section>div:nth-child(3)>h2" → "section>h2"
 */
function locationFamily(loc?: string): string {
  if (!loc) return "";
  const normalized = loc
    .toLowerCase()
    .replace(/:[a-z-]+(\([^)]*\))?/g, "") // :nth-child(3), :hover, :not(.x)
    .replace(/\[[^\]]*\]/g, "")            // [attr=val]
    .replace(/\s*>\s*/g, ">")
    .replace(/\s+/g, "");

  const parts = normalized
    .split(">")
    .map((p) => {
      const m = p.match(/^([a-z][a-z0-9]*)/);
      return m ? m[1] : "";
    })
    .filter((p) => p.length > 0);

  const semantic = parts.filter((p) => !GENERIC_CONTAINER.has(p));
  const candidates = semantic.length >= 2 ? semantic.slice(0, 2) : parts.slice(-2);
  return candidates.join(">");
}

/**
 * Produce a sorted bag-of-words from an issue string.
 * Tokens shorter than 4 chars and common stopwords are removed so that
 * minor phrasing differences between reviewers don't break equivalence.
 */
function issueTokenBag(issue?: string): string {
  if (!issue) return "";
  const tokens = issue
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
  tokens.sort();
  return tokens.slice(0, 8).join(" ");
}

/**
 * A fuzzy dedup key for cross-iteration regression detection.
 *
 * Unlike `dedupKey` (which uses exact location + issue prefix), this key is
 * stable across `:nth-child` index shifts and minor issue-text rewording —
 * the two most common ways the same finding gets a different key between runs.
 *
 * Use `dedupKey` for within-iteration merging; `looseDedupKey` only for
 * comparing whether a finding is genuinely new vs. the previous iteration.
 */
export function looseDedupKey(f: ParsedFinding): string {
  const cat = (f.category ?? "unknown").toLowerCase();
  const locFam = locationFamily(f.location);
  const bag = issueTokenBag(f.issue);
  return `${cat}::${locFam}::${bag}`;
}

/** Numeric score: severity × confidence × sqrt(consensus). */
export function scoreOf(f: ParsedFinding, consensusCount: number): number {
  const sev = SEVERITY_WEIGHT[f.severity || "low"];
  const conf = CONFIDENCE_WEIGHT[f.confidence || "low"];
  return sev * conf * Math.sqrt(consensusCount);
}

// ---------- I/O ----------

function loadFindingsForReviewer(
  findingsDir: string,
  reviewerId: string,
): { findings: ParsedFinding[]; warnings: string[] } {
  const file = join(findingsDir, `${reviewerId}.json`);
  if (!existsSync(file)) {
    return { findings: [], warnings: [`${reviewerId}: findings file not found`] };
  }
  let data: { findings?: unknown };
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as { findings?: unknown };
  } catch (e) {
    return {
      findings: [],
      warnings: [`${reviewerId}: JSON parse error — ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (!Array.isArray(data.findings)) {
    return { findings: [], warnings: [`${reviewerId}: findings field is not an array`] };
  }
  const nonStrings = data.findings.filter((s) => typeof s !== "string" || s.trim().length === 0).length;
  const findings = data.findings
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((raw) => parseFinding(raw, reviewerId));
  const warnings: string[] = nonStrings > 0
    ? [`${reviewerId}: ${nonStrings} non-string or empty finding(s) skipped`]
    : [];
  return { findings, warnings };
}

// ---------- Main entry ----------

export function aggregate(opts: AggregateOptions): AggregateResult {
  const findingsDir = join(opts.iterDir, "findings");
  const allFindings: ParsedFinding[] = [];
  const allWarnings: string[] = [];

  for (const reviewer of opts.reviewers) {
    const { findings, warnings } = loadFindingsForReviewer(findingsDir, reviewer.id);
    allFindings.push(...findings);
    allWarnings.push(...warnings);
  }

  // Group by dedup key
  const groups = new Map<string, ParsedFinding[]>();
  for (const f of allFindings) {
    const k = dedupKey(f);
    const existing = groups.get(k);
    if (existing) existing.push(f);
    else groups.set(k, [f]);
  }

  // Pick representative (highest individual score) and compute group score
  const scored: ScoredFinding[] = [];
  for (const group of groups.values()) {
    const representative = [...group].sort(
      (a, b) => scoreOf(b, 1) - scoreOf(a, 1),
    )[0];
    scored.push({
      ...representative,
      score: scoreOf(representative, group.length),
      consensus: group.length,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // Regression detection vs previous iteration
  const introducedFindings = opts.previousIterDir
    ? detectIntroduced(scored, opts.previousIterDir, opts.reviewers)
    : [];

  const topN = opts.topPriorities ?? 8;
  const riskN = opts.topRisks ?? 6;

  const priorities = scored.slice(0, topN).map(formatPriority);
  const risks = scored
    .filter(
      (f) =>
        f.severity === "high" ||
        (f.severity === "medium" && f.consensus >= 2),
    )
    .slice(0, riskN)
    .map(formatRisk);

  const summary = generateSummary(scored, introducedFindings, opts.iteration);

  return { summary, priorities, risks, scoredFindings: scored, introducedFindings, warnings: allWarnings };
}

function detectIntroduced(
  current: ScoredFinding[],
  previousIterDir: string,
  reviewers: Array<{ id: string; name: string }>,
): ScoredFinding[] {
  const previousDir = join(previousIterDir, "findings");
  const previousLooseKeys = new Set<string>();
  for (const r of reviewers) {
    const { findings } = loadFindingsForReviewer(previousDir, r.id);
    for (const f of findings) {
      previousLooseKeys.add(looseDedupKey(f));
    }
  }
  return current.filter((f) => !previousLooseKeys.has(looseDedupKey(f)));
}

function formatPriority(f: ScoredFinding): string {
  // Keep the same pipe-delimited string format the fixer prompt expects.
  return [
    `id=${f.id || "agg-" + f.category}`,
    `score=${f.score.toFixed(2)}`,
    `severity=${f.severity || "low"}`,
    `confidence=${f.confidence || "low"}`,
    `consensus=${f.consensus}`,
    `category=${f.category || "unknown"}`,
    `location=${truncate(f.location, 100)}`,
    `issue=${truncate(f.issue, 120)}`,
    `suggestedFix=${truncate(f.suggestedFix, 160)}`,
  ].join(" | ");
}

function formatRisk(f: ScoredFinding): string {
  return `[${f.severity}/${f.confidence}] ${f.category || "?"}: ${truncate(f.issue || f.location, 160)}`;
}

function generateSummary(
  scored: ScoredFinding[],
  introduced: ScoredFinding[],
  iteration: number,
): string {
  const total = scored.length;
  const high = scored.filter((f) => f.severity === "high").length;
  const med = scored.filter((f) => f.severity === "medium").length;
  const reviewers = new Set(scored.flatMap((f) => [f.sourceReviewer])).size;
  const byCat = new Map<string, number>();
  for (const f of scored) {
    const c = f.category || "unknown";
    byCat.set(c, (byCat.get(c) || 0) + 1);
  }
  const topCats = Array.from(byCat.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, n]) => `${cat}=${n}`)
    .join(", ");
  const regressionNote = introduced.length > 0
    ? ` ${introduced.length} new finding(s) introduced since previous iteration (regression watch).`
    : "";
  return `Iteration ${iteration}: ${total} unique findings (${high} high, ${med} medium) from ${reviewers} reviewers. Top categories: ${topCats}.${regressionNote} Aggregated deterministically without LLM.`;
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

// ---------- Write outputs ----------

export function writeAggregate(
  opts: AggregateOptions,
  result: AggregateResult,
): { aggregatePath: string; solverTaskPath: string } {
  const aggregatePath = join(opts.iterDir, "aggregate-feedback.json");
  writeFileSync(
    aggregatePath,
    JSON.stringify(
      {
        summary: result.summary,
        priorities: result.priorities,
        risks: result.risks,
        // Extended fields — backwards compatible because JSON consumers ignore unknowns.
        meta: {
          deterministic: true,
          totalFindings: result.scoredFindings.length,
          introducedFindings: result.introducedFindings.length,
          warnings: result.warnings,
          generatedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    ),
  );

  const compactPath = join(opts.iterDir, "previousFindings.compact.json");
  writeFileSync(
    compactPath,
    JSON.stringify(
      result.scoredFindings.map((f) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        snippet: f.issue?.slice(0, 60),
      })),
      null,
      2,
    ),
  );

  const solverTaskPath = join(opts.iterDir, "solver-task.md");
  writeFileSync(solverTaskPath, renderSolverTask(opts, result));

  return { aggregatePath, solverTaskPath };
}

function renderSolverTask(opts: AggregateOptions, result: AggregateResult): string {
  const high = result.scoredFindings.filter((f) => f.severity === "high");
  const medium = result.scoredFindings.filter((f) => f.severity === "medium");
  const introducedList = result.introducedFindings;

  const transformedPath = join(opts.runDir, "transformed.html");

  return `# Solver Task — Iteration ${opts.iteration}

## Objective
Faithful accessibility remediation. Preserve the original page identity, brand feel, substantive copy, CTAs, links, images/logos, schedule details, and partner/sponsor information. Apply targeted accessibility fixes for supported findings only. Do not produce a generic landing-page replacement.

## Source of Truth
- ${join(opts.runDir, "brief.md")}
- ${join(opts.iterDir, "aggregate-feedback.json")}
- ${transformedPath} (latest candidate, if exists)
- Targeted snippets from ${join(opts.runDir, "original.html")} only when needed.

## Aggregation Summary
${result.summary}

${introducedList.length > 0
  ? `## ⚠️ Regressions Introduced Since Last Iteration (${introducedList.length})
The previous solver pass introduced these new findings. Investigate before applying further changes.

${introducedList.slice(0, 5).map((f, i) => `
${i + 1}. **${f.category}** at \`${f.location || "(unspecified)"}\`
   Issue: ${f.issue || "(see evidence)"}
   Likely cause: a fix in the previous iteration is responsible.
`).join("\n")}
`
  : ""}

## Must-Fix (${high.length} high-severity)
${high.length === 0
    ? "_None._"
    : high.map((f, i) => `
${i + 1}. **${f.category}** [score=${f.score.toFixed(2)}, confidence=${f.confidence}, consensus=${f.consensus}]
   - **Location:** \`${f.location || "(unspecified)"}\`
   - **User impact:** ${f.issue || "(see evidence)"}
   - **Evidence:** ${f.evidence || "(none)"}
   - **Suggested fix:** ${f.suggestedFix || "(open — solver discretion)"}
   - **Source reviewer:** \`${f.sourceReviewer}\``).join("\n")}

## Should-Fix (top ${Math.min(medium.length, 5)} medium-severity)
${medium.length === 0
    ? "_None._"
    : medium.slice(0, 5).map((f, i) => `
${i + 1}. **${f.category}** [score=${f.score.toFixed(2)}]
   - Location: \`${f.location || "(unspecified)"}\`
   - Fix: ${f.suggestedFix || "(open)"}`).join("\n")}

## Preservation Guardrails
- Do NOT replace specific content with generic hero/features/testimonials filler.
- Do NOT drop links, images, CTAs, or schedule details to make axe pass.
- Color fixes must repair the full computed color system: bg, fg, anchor, CTA, slash-opacity variants (e.g. \`text-foreground/60\`, \`bg-background/85\`).
- Allowed removals (with one-sentence justification each in solver-result.json): Lovable badge, purely decorative duplicates, empty wrappers, duplicate inaccessible controls where an accessible equivalent remains.

## Acceptance Criteria
- Valid standalone HTML at \`${transformedPath}\`
- Page title, language attribute, exactly one h1, main landmark, sensible landmarks/headings
- Keyboard operability for every interactive element, visible focus, no traps
- Contrast meets WCAG 2.2 AA for text and meaningful non-text content
- No mobile horizontal overflow at 320px width
- Improved accessibility vs. previous iteration without content regressions

## Residual Risk Watchlist
${result.risks.length === 0 ? "_None reported._" : result.risks.map((r) => `- ${r}`).join("\n")}

## Output Contract
- ${transformedPath}
- ${join(opts.iterDir, "solver-result.json")} in shape:
\`\`\`json
{
  "changed": true,
  "summary": "one-paragraph plain-English description of what was changed",
  "accessibilityFixes": ["specific fix 1", "specific fix 2"],
  "preservationNotes": ["what was preserved deliberately"],
  "removedContent": ["item + one-sentence justification"],
  "residualRisks": ["risk not addressed in this pass + why"]
}
\`\`\`
`;
}
