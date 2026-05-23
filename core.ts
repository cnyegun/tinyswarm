import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import {
  consoleReporter,
  emit as emitReporter,
  line as lineReporter,
  progress as progressReporter,
  type RunSwarmOptions,
  type SwarmEvent,
  type SwarmReporter,
} from "./reporter.js";
import {
  type AgentHarness,
  type PromptUsage,
  closeHarness,
  ensureHarness,
  modelName,
  modelSpec,
  promptAgent,
  readDecision,
} from "./harness.js";
import { writeFinalReport } from "./report.js";
import { serve } from "./server.js";

export type { RunSwarmOptions, SwarmEvent, SwarmReporter } from "./reporter.js";

/** A reviewer agent: stable `id` used as session key and filename prefix, plus a human label. */
export type Reviewer = {
  id: string;
  name: string;
};

/**
 * Orchestrator's verdict per iteration, written to `decision.json`.
 * `accept` ships, `continue` loops again, `stop_with_risks` halts with `reason`.
 */
export type Decision = {
  outcome: "accept" | "continue" | "stop_with_risks";
  reason: string;
  checksPass: boolean;
  accepts: number;
  blocks: number;
};

/** Output of {@link SwarmProfile.check} — the automated pass run after each fix. */
export type CheckResult = {
  passed: boolean;
  failures: string[];
  [key: string]: unknown;
};

export type RunPaths = {
  rootDir: string;
  runDir: string;
};

export type IterationPaths = RunPaths & {
  iterDir: string;
  iteration: number;
};

/**
 * Domain-specific logic for one task category (e.g. accessibility remediation).
 * The harness calls these methods in a fixed order: scan → briefPrompt →
 * (fixPrompt → check → votePrompt? → decisionPrompt)* → local report.
 */
export type SwarmProfile = {
  id: string;
  artifact: string;
  reviewers: Reviewer[];

  scan(input: string, ctx: RunPaths): Promise<void>;
  check(ctx: RunPaths, iteration: number): Promise<CheckResult>;

  briefPrompt(ctx: RunPaths): string;
  fixPrompt(ctx: IterationPaths): string;
  votePrompt(ctx: IterationPaths, reviewer: Reviewer): string;
  decisionPrompt(ctx: IterationPaths): string;
};

export type RunState = RunPaths & {
  profile: SwarmProfile;
  input: string;
  maxIterations: number;
  logFile: string;
  started: number;
  reporter: SwarmReporter;
  harness?: AgentHarness;
  // Accumulated cost+tokens across every prompt this run. Populated lazily
  // by the harness on the first successful prompt:done. Best-effort: a
  // provider that doesn't report usage leaves these counters at zero.
  usage?: { total: PromptUsage; byAgent: Record<string, PromptUsage> };
};

/** Runs the full scan → iterate → report pipeline for one profile + input. */
export async function runSwarm(
  profile: SwarmProfile,
  input: string,
  rootDir: string,
  options: RunSwarmOptions = {},
) {
  const run = prepareRun(profile, input, rootDir, options.reporter);

  try {
    await runScan(run);

    const harness = await ensureHarness(run);
    await writeBrief(run, harness);

    let lastDecision: Decision | undefined;
    for (let iteration = 1; iteration <= run.maxIterations; iteration++) {
      lastDecision = await runIteration(run, harness, iteration);
      if (lastDecision.outcome !== "continue") break;
    }

    writeFinalReport(run, lastDecision);
    const served = await serve(run, run.profile.artifact);
    log(run, "run", "completed", {
      decision: lastDecision,
      artifact: fileState(run.rootDir, join(run.runDir, run.profile.artifact)),
      report: fileState(run.rootDir, join(run.runDir, "report.html")),
    });
    emit(run, {
      type: "run_complete",
      decision: lastDecision,
      runDir: shown(run.rootDir, run.runDir),
      artifact: shown(run.rootDir, join(run.runDir, run.profile.artifact)),
      report: shown(run.rootDir, join(run.runDir, "report.html")),
      logFile: shown(run.rootDir, run.logFile),
      localUrl: `http://localhost:${served.port}`,
      usage: run.usage,
    });
    line(run, `Run: ${shown(run.rootDir, run.runDir)}`);
    line(run, `Brief: ${shown(run.rootDir, join(run.runDir, "brief.md"))}`);
    line(run, `Report: ${shown(run.rootDir, join(run.runDir, "report.html"))}`);
    line(
      run,
      `Transformed: ${shown(run.rootDir, join(run.runDir, run.profile.artifact))}`,
    );
    line(run, `Log: ${shown(run.rootDir, run.logFile)}`);
    line(run, `Local: http://localhost:${served.port}`);
    if (run.usage) line(run, formatUsageSummary(run.usage));
  } catch (error) {
    emit(run, { type: "error", message: describe(error) });
    throw error;
  } finally {
    closeHarness(run);
  }
}

function prepareRun(
  profile: SwarmProfile,
  input: string,
  rootDir: string,
  reporter: SwarmReporter = consoleReporter,
): RunState {
  const maxIterations = Math.max(
    1,
    Number(process.env.SWARM_MAX_ITERATIONS || 3),
  );
  const runDir = join(
    rootDir,
    "runs",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(runDir, { recursive: true });
  const run: RunState = {
    profile,
    input,
    rootDir,
    runDir,
    maxIterations,
    logFile: join(runDir, "swarm.log"),
    started: Date.now(),
    reporter,
  };
  const model = modelSpec();
  const orchestratorModel = modelSpec("orchestrator");
  const fixerModel = modelSpec("fixer");

  line(run, `Run: ${shown(rootDir, runDir)}`);
  line(run, `Log: ${shown(rootDir, run.logFile)}`);
  line(
    run,
    `Model: ${modelName(model)} (variant=${model.variant}), agent=${process.env.SWARM_AGENT || "build"}, maxIterations=${maxIterations}`,
  );
  if (
    modelName(orchestratorModel) !== modelName(model) ||
    orchestratorModel.variant !== model.variant
  )
    line(
      run,
      `Orchestrator model: ${modelName(orchestratorModel)} (variant=${orchestratorModel.variant})`,
    );
  if (
    modelName(fixerModel) !== modelName(model) ||
    fixerModel.variant !== model.variant
  )
    line(
      run,
      `Fixer model: ${modelName(fixerModel)} (variant=${fixerModel.variant})`,
    );

  emit(run, {
    type: "run_start",
    profile: profile.id,
    input,
    rootDir,
    runDir: shown(rootDir, runDir),
    runDirAbsolute: runDir,
    logFile: shown(rootDir, run.logFile),
    logFileAbsolute: run.logFile,
    artifact: profile.artifact,
    reviewers: profile.reviewers,
    maxIterations,
    agent: process.env.SWARM_AGENT || "build",
    model: modelName(model),
    variant: model.variant,
  });

  log(run, "run", "starting", {
    profile: profile.id,
    input,
    rootDir,
    run: shown(rootDir, runDir),
    maxIterations,
    agent: process.env.SWARM_AGENT || "build",
    model: modelName(model),
    variant: model.variant,
    orchestratorModel: modelName(orchestratorModel),
    orchestratorVariant: orchestratorModel.variant,
    fixerModel: modelName(fixerModel),
    fixerVariant: fixerModel.variant,
    timeoutMs: Number(process.env.SWARM_AGENT_TIMEOUT_MS || 900000),
    pid: process.pid,
    node: process.version,
  });

  return run;
}

async function runScan(run: RunState) {
  const { profile, input, rootDir, runDir } = run;
  const scanStarted = Date.now();
  log(run, "scan", "starting", { profile: profile.id, input });
  emit(run, { type: "phase", phase: "scan", status: "start", input });
  progress(run, "scan", `start url=${input}`);
  try {
    await profile.scan(input, run);
    const scanArtifacts = [
      "original.html",
      "facts.json",
      "axe.json",
      join("screenshots", "original.png"),
    ];
    progress(
      run,
      "scan",
      `done ${duration(scanStarted)} ${artifactSummary(
        rootDir,
        scanArtifacts.map((path) => join(runDir, path)),
      )}`,
    );
    log(run, "scan", "done", {
      elapsedMs: Date.now() - scanStarted,
      artifacts: scanArtifacts.map((path) =>
        fileState(rootDir, join(runDir, path)),
      ),
    });
    emit(run, {
      type: "phase",
      phase: "scan",
      status: "completed",
      artifacts: scanArtifacts.map((path) => fileState(rootDir, join(runDir, path))),
    });
  } catch (error) {
    log(run, "scan", "failed", {
      elapsedMs: Date.now() - scanStarted,
      error: describe(error),
    });
    emit(run, {
      type: "phase",
      phase: "scan",
      status: "failed",
      error: describe(error),
    });
    throw error;
  }
}

async function writeBrief(run: RunState, harness: AgentHarness) {
  await promptAgent(
    harness,
    run,
    "orchestrator",
    "brief",
    join(run.runDir, "prompts", "brief.md"),
    [join(run.runDir, "brief.md")],
    run.profile.briefPrompt(run),
  );
}

function prepareIteration(run: RunState, iteration: number): IterationPaths {
  const iterDir = join(run.runDir, "iterations", pad(iteration));
  const iter: IterationPaths = {
    rootDir: run.rootDir,
    runDir: run.runDir,
    iterDir,
    iteration,
  };
  mkdirSync(iterDir, { recursive: true });
  log(run, "iteration", "start", {
    iteration,
    iterDir: shown(run.rootDir, iterDir),
  });
  emit(run, {
    type: "iteration",
    iteration,
    maxIterations: run.maxIterations,
    status: "active",
    iterDir: shown(run.rootDir, iterDir),
  });
  progress(run, `iteration ${iteration}/${run.maxIterations}`, "start");
  return iter;
}

async function runIteration(
  run: RunState,
  harness: AgentHarness,
  iteration: number,
): Promise<Decision> {
  const iter = prepareIteration(run, iteration);
  await promptAgent(
    harness,
    run,
    "fixer",
    "fix",
    join(iter.iterDir, "prompts", "fix.md"),
    [
      join(run.runDir, run.profile.artifact),
      join(iter.iterDir, "solver-result.json"),
    ],
    run.profile.fixPrompt(iter),
  );
  const checks = await runChecks(run, iter);
  if (!checks.passed) return decideFromFailedChecks(run, iter, checks);

  if (run.profile.reviewers.length === 0) {
    return recordDecision(run, iter, {
      outcome: "accept",
      reason: "automated checks passed and no reviewers are configured",
      checksPass: true,
      accepts: 0,
      blocks: 0,
    });
  }

  await collectVotes(run, harness, iter);
  const decision = await decideIteration(run, harness, iter);
  emit(run, {
    type: "iteration",
    iteration,
    maxIterations: run.maxIterations,
    status: "completed",
    outcome: decision.outcome,
  });
  return decision;
}

async function runChecks(run: RunState, iter: IterationPaths): Promise<CheckResult> {
  const checkStarted = Date.now();
  // Single source of truth for check-phase reporting. Each status writes one
  // log line + one event with consistent fields. The closure captures
  // iteration/elapsedMs so the body can't drift out of sync between channels.
  const reportCheck = (status: string, extra: Record<string, unknown> = {}) => {
    log(run, "check", status, {
      iteration: iter.iteration,
      elapsedMs: Date.now() - checkStarted,
      ...extra,
    });
    emit(run, { type: "check", iteration: iter.iteration, status, ...extra });
  };
  reportCheck("start");
  progress(run, "check", `start iteration=${iter.iteration}`);

  let checks: CheckResult;
  try {
    checks = await run.profile.check(run, iter.iteration);
  } catch (error) {
    reportCheck("failed", { error: describe(error) });
    throw error;
  }
  const checksFile = join(iter.iterDir, "checks.json");
  writeFileSync(checksFile, JSON.stringify(checks, null, 2));
  const status = checks.passed ? "passed" : "failed";
  reportCheck(status, {
    passed: checks.passed,
    failures: checks.failures.length,
    axeViolations: Array.isArray(checks.axeViolations)
      ? checks.axeViolations.length
      : undefined,
    output: fileState(run.rootDir, checksFile),
  });
  progress(run, "check", `${status} ${duration(checkStarted)} failures=${checks.failures.length}`);
  for (const failure of checks.failures.slice(0, 3))
    progress(run, "check", `failure: ${failure}`);
  if (checks.failures.length > 3)
    progress(run, "check", `...${checks.failures.length - 3} more failures in checks.json`);
  return checks;
}

async function collectVotes(
  run: RunState,
  harness: AgentHarness,
  iter: IterationPaths,
) {
  await Promise.all(
    run.profile.reviewers.map((reviewer) =>
      promptAgent(
        harness,
        run,
        reviewer.id,
        "vote",
        join(iter.iterDir, "prompts", `${reviewer.id}-vote.md`),
        [join(iter.iterDir, "votes", `${reviewer.id}.json`)],
        run.profile.votePrompt(iter, reviewer),
      ),
    ),
  );
}

async function decideIteration(
  run: RunState,
  harness: AgentHarness,
  iter: IterationPaths,
): Promise<Decision> {
  const decisionFile = join(iter.iterDir, "decision.json");
  await promptAgent(
    harness,
    run,
    "orchestrator",
    "decision",
    join(iter.iterDir, "prompts", "decision.md"),
    [decisionFile],
    run.profile.decisionPrompt(iter),
  );
  let decision = readDecision(decisionFile);

  // A final `continue` would leave the run without a terminal verdict, so cap
  // it honestly as `stop_with_risks` and keep decision.json consistent.
  if (decision.outcome === "continue" && iter.iteration === run.maxIterations) {
    decision = {
      ...decision,
      outcome: "stop_with_risks",
      reason: `max iterations reached: ${decision.reason}`,
    };
  }
  return recordDecision(run, iter, decision);
}

function decideFromFailedChecks(
  run: RunState,
  iter: IterationPaths,
  checks: CheckResult,
): Decision {
  const summary = checks.failures.slice(0, 3).join("; ");
  const extra = checks.failures.length > 3 ? `; ...${checks.failures.length - 3} more` : "";
  const reason = `automated checks failed: ${summary}${extra}`;
  return recordDecision(run, iter, {
    outcome: iter.iteration >= run.maxIterations ? "stop_with_risks" : "continue",
    reason: iter.iteration >= run.maxIterations
      ? `max iterations reached: ${reason}`
      : reason,
    checksPass: false,
    accepts: 0,
    blocks: 0,
  });
}

function recordDecision(
  run: RunState,
  iter: IterationPaths,
  decision: Decision,
): Decision {
  const decisionFile = join(iter.iterDir, "decision.json");
  writeFileSync(decisionFile, JSON.stringify(decision, null, 2));
  log(run, "decision", decision.outcome, decision);
  emit(run, {
    type: "decision",
    iteration: iter.iteration,
    outcome: decision.outcome,
    reason: decision.reason,
    checksPass: decision.checksPass,
    accepts: decision.accepts,
    blocks: decision.blocks,
  });
  progress(
    run,
    "decision",
    `outcome=${decision.outcome} checksPass=${decision.checksPass} accepts=${decision.accepts} blocks=${decision.blocks} reason=${quote(decision.reason)}`,
  );
  return decision;
}

export function log(run: RunState, step: string, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${serialize(data)}`;
  const text = `${new Date().toISOString()} +${Date.now() - run.started}ms ${step} ${message}${suffix}\n`;
  appendFileSync(run.logFile, text);
}

export function line(run: RunState, text: string) {
  lineReporter(run.reporter, text);
}

export function emit(run: RunState, event: SwarmEvent) {
  emitReporter(run.reporter, run.started, event);
}

export function progress(run: RunState, phase: string, message: string) {
  progressReporter(run.reporter, run.started, phase, message);
}

export function duration(startedAt: number) {
  const ms = Date.now() - startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function artifactSummary(rootDir: string, paths: string[]) {
  return paths
    .map((path) => {
      const state = fileState(rootDir, path);
      return state.exists
        ? `${outputName(path)}=${formatBytes(state.size)}`
        : `${outputName(path)}=missing`;
    })
    .join(" ");
}

export function fileState(rootDir: string, path: string) {
  if (!existsSync(path)) return { path: shown(rootDir, path), exists: false };
  const stat = statSync(path);
  return {
    path: shown(rootDir, path),
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function outputName(path: string) {
  return basename(path);
}

// One-line human summary of total tokens + cost for the CLI summary block.
// Per-agent breakdown lives in run_complete.usage.byAgent for machine consumers.
function formatUsageSummary(usage: {
  total: PromptUsage;
  byAgent: Record<string, PromptUsage>;
}) {
  const { tokensIn, tokensOut, tokensReasoning, tokensCacheRead, cost } = usage.total;
  const cache = tokensCacheRead ? ` cache_read=${tokensCacheRead}` : "";
  const reasoning = tokensReasoning ? ` reasoning=${tokensReasoning}` : "";
  return `Tokens: in=${tokensIn} out=${tokensOut}${reasoning}${cache} cost=$${cost.toFixed(4)}`;
}

export function formatBytes(bytes?: number) {
  if (bytes === undefined) return "?B";
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round(bytes / 1024)}KB`;
}

export function shortID(id: string) {
  return id.length <= 16 ? id : `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function quote(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(
    clean.length > 160 ? `${clean.slice(0, 157)}...` : clean,
  );
}

function serialize(data: unknown) {
  try {
    return JSON.stringify(data);
  } catch (error) {
    return JSON.stringify({ unserializable: describe(error) });
  }
}

export function shown(rootDir: string, path: string) {
  return relative(rootDir, path);
}

function pad(n: number) {
  return String(n).padStart(3, "0");
}

export function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Returns the highest-numbered iteration folder that has a `checks.json`, or "". */
export function latestIteration(runDir: string) {
  for (let i = 99; i >= 1; i--)
    if (existsSync(join(runDir, "iterations", pad(i), "checks.json")))
      return pad(i);
  return "";
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.cause === undefined
      ? error.message
      : `${error.message}; cause: ${describe(error.cause)}`;
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    const code = typeof obj.code === "string" ? ` code=${obj.code}` : "";
    const message =
      typeof obj.message === "string" ? ` message=${obj.message}` : "";
    const cause =
      obj.cause === undefined ? "" : ` cause=${describe(obj.cause)}`;
    if (code || message || cause) return `${code}${message}${cause}`.trim();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
