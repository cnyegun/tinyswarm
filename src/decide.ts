import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic decision step that replaces the LLM-driven `decisionPrompt`.
 *
 * Why deterministic:
 * - Counting votes and checking thresholds is the textbook example of work
 *   that should NEVER be delegated to an LLM. Doing so is wasteful and makes
 *   the decision unreproducible — the same input can yield different outcomes,
 *   which violates EU AI Act Article 15 (accuracy & robustness).
 * - Removing this LLM call saves ~20-40s per iteration and produces an
 *   auditable, deterministic verdict every time.
 *
 * Output contract is the existing `decision.json` shape consumed by core.ts's
 * `readDecision()`, so no caller changes are needed.
 */

export type VoteValue = "accept" | "block" | "revise";

export type Vote = {
  vote: VoteValue;
  reasoning?: string;
  reviewerId: string;
};

export type CheckResult = {
  passed: boolean;
  failures: string[];
};

export type Decision = {
  outcome: "accept" | "continue" | "stop_with_risks";
  reason: string;
  checksPass: boolean;
  accepts: number;
  blocks: number;
  /** Extended (backward compatible: orchestrator code ignores unknown fields). */
  revises?: number;
  totalVotes?: number;
  introducedFindings?: number;
  rulesApplied?: string[];
};

export type DecideOptions = {
  iterDir: string;
  iteration: number;
  maxIterations: number;
  reviewers: Array<{ id: string; name: string }>;
  /** Number of findings introduced in this iter that did not exist before. */
  introducedFindings?: number;
  /** Breakdown by severity for weighted regression scoring (T4.2). */
  introducedFindingsBySeverity?: { high: number; medium: number; low: number };
};

// ---------- Pure decision rules ----------

/**
 * Returns true if enough reviewers voted accept.
 *
 * Normal mode: at least ceil(N/2) — strict majority.
 *   N=4 → need ≥ 2. N=5 → need ≥ 3.
 * Demo mode (SWARM_DEMO=1): at least floor(N/2) — relaxed plurality.
 *   N=4 → need ≥ 2. N=5 → need ≥ 2. Allows 2/4 to accept where normal requires 3/4 for N>4.
 */
export function isMajorityAccept(accepts: number, total: number): boolean {
  if (total === 0) return false;
  const threshold = process.env.SWARM_DEMO === "1"
    ? Math.floor(total / 2)
    : Math.ceil(total / 2);
  return accepts >= threshold;
}

/**
 * The core decision rule, broken out so it can be unit-tested in isolation.
 */
export function decideRules(input: {
  votes: Vote[];
  checks: CheckResult;
  iteration: number;
  maxIterations: number;
  introducedFindings: number;
  introducedFindingsBySeverity?: { high: number; medium: number; low: number };
}): Decision {
  const { votes, checks, iteration, maxIterations, introducedFindings } = input;
  const accepts = votes.filter((v) => v.vote === "accept").length;
  const blocks = votes.filter((v) => v.vote === "block").length;
  const revises = votes.filter((v) => v.vote === "revise").length;
  const totalVotes = votes.length;
  const checksPass = checks.passed;
  const noBlocks = blocks === 0;
  const majorityAccepts = isMajorityAccept(accepts, totalVotes);
  const noRegression = introducedFindings === 0;

  const rulesApplied: string[] = [];

  // Rule 1: Hard accept — every condition satisfied
  if (checksPass && noBlocks && majorityAccepts && noRegression) {
    rulesApplied.push(
      "R1_hard_accept: checksPass && noBlocks && majorityAccepts && noRegression",
    );
    return {
      outcome: "accept",
      reason: `Checks pass (0 failures). ${accepts}/${totalVotes} reviewers accepted, 0 blocked. No regressions introduced.`,
      checksPass,
      accepts,
      blocks,
      revises,
      totalVotes,
      introducedFindings,
      rulesApplied,
    };
  }

  // Rule 2: Max iterations exhausted — terminate honestly
  if (iteration >= maxIterations) {
    rulesApplied.push("R2_max_iter_exhausted");
    const issues: string[] = [];
    if (!checksPass) issues.push(`${checks.failures.length} automated check failures`);
    if (blocks > 0) issues.push(`${blocks} block vote(s)`);
    if (introducedFindings > 0) issues.push(`${introducedFindings} introduced findings`);
    if (!majorityAccepts) issues.push(`only ${accepts}/${totalVotes} accept votes`);
    return {
      outcome: "stop_with_risks",
      reason: `Max iterations (${maxIterations}) reached. Residual issues: ${issues.join("; ") || "minor unresolved concerns"}.`,
      checksPass,
      accepts,
      blocks,
      revises,
      totalVotes,
      introducedFindings,
      rulesApplied,
    };
  }

  // Rule 3: Critical regression — pull the plug to avoid worsening.
  // Uses weighted score when severity breakdown is available; falls back to
  // raw count (>= 3) for backward compatibility.
  const bySev = input.introducedFindingsBySeverity;
  const weightedRegression = bySev !== undefined
    ? bySev.high * 5 + bySev.medium * 3 + bySev.low * 1
    : NaN;
  const regressionTriggered = bySev !== undefined
    ? weightedRegression >= 20 && iteration >= 2
    : introducedFindings >= 3 && iteration >= 2;

  if (regressionTriggered) {
    const ruleTag = bySev !== undefined ? "R3_weighted_regression" : "R3_critical_regression";
    rulesApplied.push(ruleTag);
    const detail = bySev !== undefined
      ? `weighted regression score ${weightedRegression} (high×5=${bySev.high * 5} medium×3=${bySev.medium * 3} low×1=${bySev.low * 1})`
      : `${introducedFindings} regressions introduced`;
    return {
      outcome: "stop_with_risks",
      reason: `Aborting: ${detail} after iteration ${iteration - 1}. Further fixing risks worsening the artifact.`,
      checksPass,
      accepts,
      blocks,
      revises,
      totalVotes,
      introducedFindings,
      rulesApplied,
    };
  }

  // Rule 4: Continue with explicit reason
  rulesApplied.push("R4_continue");
  const reasons: string[] = [];
  if (!checksPass) reasons.push(`${checks.failures.length} check failure(s)`);
  if (blocks > 0) reasons.push(`${blocks} block vote(s)`);
  if (!majorityAccepts) reasons.push(`${accepts}/${totalVotes} accept`);
  if (introducedFindings > 0) reasons.push(`${introducedFindings} regression(s)`);
  if (revises > 0) reasons.push(`${revises} revise vote(s)`);

  return {
    outcome: "continue",
    reason: `Iteration ${iteration}/${maxIterations}: ${reasons.join(", ") || "improvements still possible"}. Re-running with structured feedback.`,
    checksPass,
    accepts,
    blocks,
    revises,
    totalVotes,
    introducedFindings,
    rulesApplied,
  };
}

// ---------- I/O ----------

function loadVotes(
  iterDir: string,
  reviewers: Array<{ id: string; name: string }>,
): Vote[] {
  const votes: Vote[] = [];
  for (const reviewer of reviewers) {
    const file = join(iterDir, "votes", `${reviewer.id}.json`);
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as {
        vote?: unknown;
        reasoning?: unknown;
      };
      if (
        data.vote === "accept" ||
        data.vote === "block" ||
        data.vote === "revise"
      ) {
        votes.push({
          vote: data.vote,
          reasoning: typeof data.reasoning === "string" ? data.reasoning : undefined,
          reviewerId: reviewer.id,
        });
      }
    } catch {
      // skip malformed
    }
  }
  return votes;
}

function loadChecks(iterDir: string): CheckResult {
  const file = join(iterDir, "checks.json");
  if (!existsSync(file)) {
    return { passed: false, failures: ["checks.json missing"] };
  }
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      passed?: unknown;
      failures?: unknown;
    };
    return {
      passed: data.passed === true,
      failures: Array.isArray(data.failures)
        ? data.failures.filter((f): f is string => typeof f === "string")
        : [],
    };
  } catch {
    return { passed: false, failures: ["checks.json malformed"] };
  }
}

// ---------- Main entry ----------

export function decide(opts: DecideOptions): Decision {
  const votes = loadVotes(opts.iterDir, opts.reviewers);
  const checks = loadChecks(opts.iterDir);
  const introducedFindings = opts.introducedFindings ?? 0;

  return decideRules({
    votes,
    checks,
    iteration: opts.iteration,
    maxIterations: opts.maxIterations,
    introducedFindings,
    introducedFindingsBySeverity: opts.introducedFindingsBySeverity,
  });
}

export function writeDecision(iterDir: string, decision: Decision): string {
  const path = join(iterDir, "decision.json");
  writeFileSync(path, JSON.stringify(decision, null, 2));
  return path;
}
