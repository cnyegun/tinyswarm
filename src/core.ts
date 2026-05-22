import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type PermissionRuleset,
} from "@opencode-ai/sdk/v2";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  axeViolationCount,
  consoleReporter,
  emit as emitReporter,
  line as lineReporter,
  progress as progressReporter,
  promptOutputEvent,
  type RunSwarmOptions,
  type SwarmEvent,
  type SwarmReporter,
} from "./reporter.js";

export type { RunSwarmOptions, SwarmEvent, SwarmReporter } from "./reporter.js";

/**
 * Identifies a reviewer agent participating in the swarm evaluation loop.
 * Each reviewer runs independently in its own opencode session and votes per iteration.
 */
export type Reviewer = {
  /** Stable machine identifier used as a session key and filename prefix (e.g. `"a11y"`). */
  id: string;
  /** Human-readable label passed into reviewer prompt templates (e.g. `"Accessibility Reviewer"`). */
  name: string;
};

/**
 * The orchestrator's verdict at the end of each iteration, written to `decision.json`.
 *
 * - `"accept"` — the orchestrator judged the artifact ready to ship.
 * - `"continue"` — issues remain; the loop should run another iteration.
 * - `"stop_with_risks"` — stop the loop and report the known risks in `reason`.
 */
export type Decision = {
  /** Final outcome of the iteration review. */
  outcome: "accept" | "continue" | "stop_with_risks";
  /** Human-readable explanation of why this outcome was chosen. */
  reason: string;
  /** Whether the automated {@link SwarmProfile.check} passed in this iteration. */
  checksPass: boolean;
  /** Number of reviewers who voted to accept. */
  accepts: number;
  /** Number of reviewers who voted to block. */
  blocks: number;
};

/**
 * Structured output from {@link SwarmProfile.check}, representing the automated
 * validation pass run after the fixer agent applies its changes each iteration.
 *
 * Any additional tool-specific properties (e.g. axe violation counts) may be
 * included alongside the required fields via the index signature.
 */
export type CheckResult = {
  /** `true` if all automated checks passed; `false` if any failure was found. */
  passed: boolean;
  /** Short human-readable descriptions of every failing check, one per entry. */
  failures: string[];
  /** Open-ended additional data returned by the profile's check implementation. */
  [key: string]: unknown;
};

/**
 * Filesystem paths shared across all phases of a single swarm run.
 * Passed to profile methods that need to read scan artifacts or write outputs
 * relative to a stable root.
 */
export type RunPaths = {
  /** Absolute path to the project root; used to relativize all displayed paths. */
  rootDir: string;
  /** Absolute path to the timestamped directory for this run (e.g. `runs/2025-01-15T...`). */
  runDir: string;
};

/**
 * Extends {@link RunPaths} with per-iteration paths and numbering.
 * Passed to profile methods that generate prompts or consume outputs scoped to
 * a single iteration (fix, vote, decision).
 */
export type IterationPaths = RunPaths & {
  /** Absolute path to this iteration's output directory (e.g. `.../iterations/001`). */
  iterDir: string;
  /** 1-based iteration number within the current run. */
  iteration: number;
};

/**
 * The primary extension point for `core.ts`. A `SwarmProfile` encapsulates all
 * domain-specific logic for one task category (e.g. accessibility remediation,
 * code review, security scanning).
 *
 * Implementors provide:
 * - An initial scan step that fetches and analyzes the target
 * - An automated check that validates the artifact after each fix
 * - A set of named reviewer agents and the prompt templates they use
 *
 * The swarm harness calls these methods in a fixed order:
 * `scan → briefPrompt → [fixPrompt → check → optional votePrompt →
 * decisionPrompt]* → local report`
 *
 * @example
 * ```typescript
 * const profile: SwarmProfile = {
 *   id: "a11y",
 *   artifact: "fixed.html",
 *   reviewers: [{ id: "wcag", name: "WCAG Reviewer" }],
 *   async scan(url, ctx) { ... },
 *   async check(ctx, iter) { return { passed: true, failures: [] }; },
 *   briefPrompt: (ctx) => `Fix the accessibility issues in ${ctx.runDir}/original.html`,
 *   // ... remaining prompt methods
 * };
 * ```
 */
export type SwarmProfile = {
  /** Stable identifier for this profile; appears in log lines and session titles. */
  id: string;
  /**
   * Relative filename (within `runDir`) of the artifact produced by the fixer agent
   * and served by the local preview server (e.g. `"fixed.html"`).
   */
  artifact: string;
  /** Ordered list of reviewer agents; all run concurrently within each iteration. */
  reviewers: Reviewer[];

  /**
   * Fetches and analyzes the target input, writing raw artifacts to `ctx.runDir`.
   * Runs once at the start of the swarm before any agent sessions are opened.
   * @param input - URL or identifier of the resource to scan.
   * @param ctx - Run-level filesystem paths.
   */
  scan(input: string, ctx: RunPaths): Promise<void>;

  /**
   * Runs automated validation on the current state of the artifact.
   * Called after every fixer pass; results are written to `checks.json` and
   * fed into the next fix prompt, reviewer votes, and decision prompts.
   * @param ctx - Run-level filesystem paths.
   * @param iteration - Current 1-based iteration number.
   */
  check(ctx: RunPaths, iteration: number): Promise<CheckResult>;

  /**
   * Returns the prompt that instructs the orchestrator to produce `brief.md` —
   * a high-level task description consumed by all subsequent agent prompts.
   */
  briefPrompt(ctx: RunPaths): string;

  /**
   * Returns the prompt that instructs the fixer agent to apply changes and
   * write the updated artifact plus a `solver-result.json` summary.
   */
  fixPrompt(ctx: IterationPaths): string;

  /**
   * Returns the prompt for a reviewer agent to cast its vote (`votes/<id>.json`)
   * based on the fixer's result and the automated check outcome.
   */
  votePrompt(ctx: IterationPaths, reviewer: Reviewer): string;

  /**
   * Returns the prompt that instructs the orchestrator to read all votes and
   * write a `decision.json` with outcome, reason, and tally.
   */
  decisionPrompt(ctx: IterationPaths): string;

};

/**
 * Holds the live opencode server connection and the session ID registry.
 * Created per swarm run by {@link ensureHarness} and torn down in the
 * `finally` block of {@link runSwarm} when this process owns the server.
 */
type AgentHarness = {
  /** Typed SDK client bound to `url`. */
  client: OpencodeClient;
  /** Base URL of the opencode server (either external or locally spawned). */
  url: string;
  /**
   * If present, calling this closes the locally-spawned opencode server.
   * Absent when the harness was attached to a pre-existing external server,
   * in which case the server is left running after the swarm finishes.
   */
  close?: () => void;
  /** Maps logical agent keys (e.g. `"orchestrator"`, `"fixer"`) to their opencode session IDs. */
  sessions: Record<string, string>;
  /** Whether the configured opencode models were already checked for this harness. */
  modelsValidated?: boolean;
};

/** Explicit per-run state threaded through operational helpers. */
type RunState = RunPaths & {
  /** Profile executing this run. */
  profile: SwarmProfile;
  /** Original input passed to {@link SwarmProfile.scan}. */
  input: string;
  /** Maximum number of reviewer/fixer iterations allowed for this run. */
  maxIterations: number;
  /** Absolute path to this run's structured log file. */
  logFile: string;
  /** Epoch ms when this run started; used for `+Nms` log offsets. */
  started: number;
  /** Presentation hooks for plain CLI output or structured TUI events. */
  reporter: SwarmReporter;
  /** Live harness for this run, if initialized. */
  harness?: AgentHarness;
};

/**
 * Snapshot of a single expected output file, used to detect whether the file
 * changed after a prompt was submitted.
 */
type FileOutputState = {
  /** Display path (relative to `rootDir`). */
  path: string;
  /** Whether the file exists on disk at the time of the snapshot. */
  exists: boolean;
  /**
   * `true` if the file exists and its `mtimeMs` is strictly greater than
   * `previousMtimeMs`, indicating the output changed after the prompt.
   */
  changed: boolean;
  /** Modification timestamp captured before the prompt was submitted. */
  previousMtimeMs: number;
  /** Current modification timestamp; present only when `exists` is `true`. */
  mtimeMs?: number;
  /** File size in bytes; present only when `exists` is `true`. */
  size?: number;
};

/** Grants every permission to every file pattern; applied to all swarm sessions. */
const allowAll: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
];

/**
 * Executes a complete swarm run for the given profile and input.
 *
 * @description
 * Orchestrates the full scan-iterate-report pipeline:
 * 1. Creates a timestamped run directory under `<rootDir>/runs/`.
 * 2. Calls `profile.scan()` to fetch and analyze the target.
 * 3. Starts (or connects to) an opencode server and opens agent sessions.
 * 4. Runs the brief prompt to produce `brief.md`.
 * 5. Iterates up to `SWARM_MAX_ITERATIONS` times:
 *    - The fixer agent applies changes to the artifact.
 *    - Automated checks validate the artifact.
 *    - Failed checks go straight into the next fixer pass.
 *    - Reviewers vote only after checks pass.
 *    - The orchestrator issues a decision (`accept` / `continue` / `stop_with_risks`).
 *    - The loop breaks early on `accept` or `stop_with_risks`.
 * 6. A local deterministic report writer creates `report.md` and `report.html`.
 * 7. A local HTTP preview server starts and the final artifact is served.
 *
 * @param profile - Domain-specific profile that supplies all prompt templates and validation logic.
 * @param input - URL or identifier passed to `profile.scan()` (e.g. a webpage URL).
 * @param rootDir - Absolute path to the project root; all run artifacts are written beneath it.
 *
 * @returns Resolves when the run completes (report written, server listening). Does NOT await
 *   the HTTP server to close — the process must stay alive for the preview to remain accessible.
 *
 * @throws If `profile.scan()` throws, or if any agent prompt times out, or if the opencode
 *   server fails to start. The `finally` block closes a locally-spawned opencode server.
 *
 * @example
 * ```typescript
 * import { runSwarm } from "./core.js";
 * import { myProfile } from "./profiles/my-profile.js";
 *
 * await runSwarm(myProfile, "https://example.com", process.cwd());
 * ```
 */
export async function runSwarm(
  profile: SwarmProfile,
  input: string,
  rootDir: string,
  options: RunSwarmOptions = {},
) {
  const run = prepareRun(profile, input, rootDir, options.reporter);

  try {
    // Keep runSwarm as the table of contents: source capture, agent loop,
    // final report, preview, cleanup. Phase helpers own the operational detail.
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
  } catch (error) {
    emit(run, { type: "error", message: describe(error) });
    throw error;
  } finally {
    closeHarness(run);
  }
}

/**
 * Creates the one state object for this run.
 *
 * runSwarm calls this first so every later helper writes to the same run
 * directory, log file, and timestamp base without relying on module globals.
 */
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
    console.log(
      `Orchestrator model: ${modelName(orchestratorModel)} (variant=${orchestratorModel.variant})`,
    );
  if (
    modelName(fixerModel) !== modelName(model) ||
    fixerModel.variant !== model.variant
  )
    console.log(
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

/**
 * Captures the source evidence before opening any agent sessions.
 *
 * If scanning fails, there is no useful swarm job to run, so runSwarm stops
 * here. On success, the expected source artifacts are logged for operators who
 * inspect runs/<timestamp>/ by hand.
 */
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

/**
 * Asks the orchestrator for the shared brief.
 *
 * runSwarm does this once after scanning so reviewers and the fixer start from
 * the same task framing instead of each agent independently interpreting raw
 * source evidence.
 */
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

/**
 * Creates the filesystem contract for one iteration.
 *
 * Example: iteration 1 gets `iterations/001/`. Prompt helpers create their own
 * subdirectories as needed, so the loop only needs this one stable root.
 */
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

/**
 * Runs one complete improvement cycle.
 *
 * This is the core loop body used by runSwarm. Keep the hot path simple: fix,
 * check, then ask humans only if checks passed. Failed checks already mean the
 * iteration cannot be accepted, so reviewer votes would be wasted.
 */
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

/**
 * Runs deterministic validation after the fixer writes the candidate artifact.
 *
 * The resulting checks.json becomes evidence for both reviewer votes and the
 * orchestrator decision, so it must happen after fixing and before voting.
 */
async function runChecks(run: RunState, iter: IterationPaths): Promise<CheckResult> {
  const checkStarted = Date.now();
  log(run, "check", "start", { iteration: iter.iteration });
  emit(run, { type: "check", iteration: iter.iteration, status: "start" });
  progress(run, "check", `start iteration=${iter.iteration}`);
  let checks: CheckResult;
  try {
    checks = await run.profile.check(run, iter.iteration);
  } catch (error) {
    log(run, "check", "failed", {
      iteration: iter.iteration,
      elapsedMs: Date.now() - checkStarted,
      error: describe(error),
    });
    emit(run, {
      type: "check",
      iteration: iter.iteration,
      status: "failed",
      error: describe(error),
    });
    throw error;
  }
  const checksFile = join(iter.iterDir, "checks.json");
  writeFileSync(checksFile, JSON.stringify(checks, null, 2));
  log(run, "check", checks.passed ? "passed" : "failed", {
    iteration: iter.iteration,
    elapsedMs: Date.now() - checkStarted,
    failures: checks.failures.length,
    output: fileState(run.rootDir, checksFile),
  });
  emit(run, {
    type: "check",
    iteration: iter.iteration,
    status: checks.passed ? "passed" : "failed",
    passed: checks.passed,
    failures: checks.failures.length,
    axeViolations: axeViolationCount(checks),
    output: fileState(run.rootDir, checksFile),
  });
  progress(
    run,
    "check",
    `${checks.passed ? "passed" : "failed"} ${duration(checkStarted)} failures=${checks.failures.length}`,
  );
  for (const failure of checks.failures.slice(0, 3))
    progress(run, "check", `failure: ${failure}`);
  if (checks.failures.length > 3)
    progress(
      run,
      "check",
      `...${checks.failures.length - 3} more failures in checks.json`,
    );
  return checks;
}

/**
 * Collects reviewer votes after automated checks are available.
 *
 * Each reviewer can judge the passing candidate independently with the
 * transformed artifact, solver result, and checks.json evidence.
 */
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

/**
 * Produces and normalizes the iteration decision.
 *
 * runSwarm uses this return value to either break the loop or continue. The
 * helper also caps a final `continue` as `stop_with_risks` so the run always
 * ends with a terminal decision in decision.json.
 */
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

/**
 * Failed deterministic checks already decide the iteration. Save the decision
 * locally instead of asking reviewers to vote on a candidate they cannot accept.
 */
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

/**
 * Writes the human-facing report after the loop has a final decision.
 *
 * Report generation is deterministic and local so the accepted artifact is not
 * held behind one more model call. The report deliberately summarizes only
 * compact artifacts that the workflow already produced.
 */
function writeFinalReport(run: RunState, decision?: Decision) {
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
  const briefPath = join(run.runDir, "brief.md");
  const briefText = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : undefined;
  const report = {
    latest,
    decision,
    checks,
    solver,
    votes,
    originalAxe,
    briefText,
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
  briefText?: string;
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
      summary: briefHighlight(report.briefText),
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

function briefHighlight(briefText: string | undefined): string {
  const fallback =
    "Wrote the run brief: page purpose, content to preserve, and reviewer focus.";
  if (!briefText) return fallback;
  const para = briefText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("-") && p.length > 30);
  return para ? excerpt(para, 220) : fallback;
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

/**
 * Releases only the opencode server owned by this run.
 *
 * External servers are deliberately left running; locally-created servers are
 * closed from runSwarm's finally block even when an earlier phase throws.
 */
function closeHarness(run: RunState) {
  const harness = run.harness;
  if (harness?.close)
    log(run, "opencode", "closing server", { url: harness.url });
  else if (harness)
    log(run, "opencode", "leaving external server open", {
      url: harness.url,
    });
  harness?.close?.();
  run.harness = undefined;
}

/**
 * Returns the active {@link AgentHarness}, creating one if none exists.
 *
 * Precedence:
 * 1. Reuse the current run's harness if already initialized.
 * 2. Connect to an externally-managed server via `SWARM_OPENCODE_SERVER_URL`
 *    (or the legacy alias `TINY_OPENCODE_SERVER_URL`).
 * 3. Spawn a new in-process opencode server on an OS-assigned port.
 *
 * @param run - Current run state; stores the initialized harness.
 * @returns The initialized harness with a live SDK client.
 * @throws If `createOpencode` fails to start the embedded server.
 */
async function ensureHarness(run: RunState): Promise<AgentHarness> {
  if (run.harness) {
    log(run, "opencode", "reusing harness", {
      url: run.harness.url,
      sessions: Object.keys(run.harness.sessions).length,
    });
    return run.harness;
  }
  const url =
    process.env.SWARM_OPENCODE_SERVER_URL ||
    process.env.TINY_OPENCODE_SERVER_URL;
  if (url) {
    run.harness = {
      client: createOpencodeClient({ baseUrl: url }),
      url,
      sessions: {},
    };
    log(run, "opencode", "using existing server", { url });
    await validateConfiguredModels(run, run.harness);
    return run.harness;
  }
  const serverStarted = Date.now();
  log(run, "opencode", "starting server", {
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30000,
    permission: "allow",
  });
  const startedServer = await createOpencode({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30000,
    config: { permission: "allow" },
  }).catch((error: unknown) => {
    log(run, "opencode", "start threw", {
      elapsedMs: Date.now() - serverStarted,
      error: describe(error),
    });
    throw error;
  });
  run.harness = {
    client: startedServer.client,
    url: startedServer.server.url,
    close: startedServer.server.close,
    sessions: {},
  };
  log(run, "opencode", "started server", {
    url: run.harness.url,
    permission: "allow",
    run: shown(run.rootDir, run.runDir),
    elapsedMs: Date.now() - serverStarted,
  });
  await validateConfiguredModels(run, run.harness);
  return run.harness;
}

/**
 * Fails fast when SWARM_MODEL points at a provider/model that opencode cannot use.
 *
 * opencode accepts `promptAsync` before model execution begins; without this preflight,
 * a provider/model error can surface only in opencode's own logs while runSwarm keeps
 * polling for output files that will never be written.
 */
async function validateConfiguredModels(run: RunState, harness: AgentHarness) {
  if (harness.modelsValidated) return;
  const started = Date.now();
  const specs = [
    { key: "default", model: modelSpec() },
    { key: "orchestrator", model: modelSpec("orchestrator") },
    { key: "fixer", model: modelSpec("fixer") },
  ];
  const uniqueSpecs = Array.from(
    new Map(specs.map((spec) => [modelName(spec.model), spec])).values(),
  );
  log(run, "opencode", "model preflight start", {
    models: uniqueSpecs.map((spec) => ({
      key: spec.key,
      model: modelName(spec.model),
      variant: spec.model.variant,
    })),
  });
  const result = await harness.client.config
    .providers({ directory: run.rootDir })
    .catch((error: unknown) => {
      log(run, "opencode", "model preflight threw", {
        elapsedMs: Date.now() - started,
        error: describe(error),
      });
      throw error;
    });
  if (result.error) {
    log(run, "opencode", "model preflight error", {
      elapsedMs: Date.now() - started,
      error: describe(result.error),
    });
    throw new Error(`opencode provider preflight failed: ${describe(result.error)}`);
  }

  const providers = result.data?.providers || [];
  const providerIDs = providers.map((provider) => provider.id).sort();
  for (const spec of uniqueSpecs) {
    const provider = providers.find(
      (candidate) => candidate.id === spec.model.providerID,
    );
    const modelIDs = Object.keys(provider?.models || {});
    if (provider && modelIDs.includes(spec.model.modelID)) continue;

    log(run, "opencode", "model unavailable", {
      key: spec.key,
      requested: modelName(spec.model),
      availableProviders: providerIDs,
      availableModelsForProvider: modelIDs,
    });
    throw new Error(
      [
        `opencode model unavailable: ${modelName(spec.model)}`,
        provider
          ? `Available models for provider "${provider.id}": ${modelIDs.join(", ") || "(none)"}`
          : `Available providers: ${providerIDs.join(", ") || "(none)"}`,
        `If using LLM Providers, set api key in ${shown(run.rootDir, join(run.rootDir, ".env"))} or export it before starting an external opencode server.`,
      ].join(". "),
    );
  }

  harness.modelsValidated = true;
  log(run, "opencode", "model preflight done", {
    elapsedMs: Date.now() - started,
    models: uniqueSpecs.map((spec) => modelName(spec.model)),
    providers: providerIDs,
  });
}

/**
 * Returns the opencode session ID for the given logical agent key,
 * creating a new session if one does not yet exist for this run.
 *
 * Session IDs are persisted to `sessions.json` in the run directory so
 * that progress can be inspected externally while the swarm is running.
 *
 * @param harness - The live harness holding the SDK client and session registry.
 * @param run - Current run state for display paths and logging.
 * @param key - Logical agent name (e.g. `"orchestrator"`, `"fixer"`, reviewer ID).
 * @returns The opencode session ID string.
 * @throws If the SDK call returns an error response.
 */
async function sessionFor(
  harness: AgentHarness,
  run: RunState,
  key: string,
) {
  if (harness.sessions[key]) {
    log(run, "session", "reuse", { key, id: harness.sessions[key] });
    return harness.sessions[key];
  }
  const model = modelSpec(key);
  const agent = process.env.SWARM_AGENT || "build";
  const title = `swarm ${key} ${relative(run.rootDir, run.runDir)}`;
  const sessionStarted = Date.now();
  log(run, "session", "create start", {
    key,
    title,
    agent,
    model: modelName(model),
    variant: model.variant,
    permission: "allow-all",
  });
  const result = await harness.client.session
    .create({
      directory: run.rootDir,
      title,
      agent,
      model: {
        providerID: model.providerID,
        id: model.modelID,
        variant: model.variant,
      },
      permission: allowAll,
    })
    .catch((error: unknown) => {
      log(run, "session", "create threw", {
        key,
        elapsedMs: Date.now() - sessionStarted,
        error: describe(error),
      });
      throw error;
    });
  if (result.error) {
    log(run, "session", "create error", {
      key,
      elapsedMs: Date.now() - sessionStarted,
      error: describe(result.error),
    });
    throw new Error(`session create failed: ${describe(result.error)}`);
  }
  harness.sessions[key] = result.data.id;
  writeFileSync(
    join(run.runDir, "sessions.json"),
    JSON.stringify(harness.sessions, null, 2),
  );
  log(run, "session", "created", {
    key,
    id: result.data.id,
    elapsedMs: Date.now() - sessionStarted,
    sessionsFile: fileState(run.rootDir, join(run.runDir, "sessions.json")),
  });
  return result.data.id;
}

/**
 * Submits a prompt to an agent session and blocks until all expected output
 * files exist and have changed on disk.
 *
 * The prompt text is persisted to `promptFile` before submission so that the
 * exact instruction sent to each agent is reproducible from the run directory.
 * Output detection is file-system based: the function polls for each path in
 * `outputs` and considers it done when the file exists with a newer `mtimeMs`
 * than before the prompt was submitted. In normal runs, that means the agent
 * wrote the file; the code deliberately checks the file state instead of trying
 * to prove which process wrote it.
 *
 * @param harness - Live harness with the SDK client.
 * @param run - Current run state for display paths, session directory, and logging.
 * @param key - Logical agent name (matches a session key in `harness.sessions`).
 * @param phase - Display label used in progress output (e.g. `"fix"`, `"vote"`).
 * @param promptFile - Absolute path where the prompt markdown will be saved.
 * @param outputs - Absolute paths of files expected to exist and change before this resolves.
 * @param text - The full prompt text to send.
 * @throws If the SDK rejects the prompt or if outputs are not ready before `SWARM_AGENT_TIMEOUT_MS`.
 */
async function promptAgent(
  harness: AgentHarness,
  run: RunState,
  key: string,
  phase: string,
  promptFile: string,
  outputs: string[],
  text: string,
) {
  const sessionID = await sessionFor(harness, run, key);
  const model = modelSpec(key);
  const agent = process.env.SWARM_AGENT || "build";
  const before = outputTimes(outputs);
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, text);
  const promptStarted = Date.now();
  emit(run, {
    type: "prompt",
    phase,
    agent: key,
    status: "start",
    sessionID: shortID(sessionID),
    promptFile: shown(run.rootDir, promptFile),
    promptBytes: Buffer.byteLength(text, "utf8"),
    outputs: outputs.map((path) => shown(run.rootDir, path)),
  });
  progress(
    run,
    phase,
    `${key} session=${shortID(sessionID)} outputs=${outputs.map(outputName).join(",")} prompt=${formatBytes(Buffer.byteLength(text, "utf8"))}`,
  );
  log(run, "prompt", "start", {
    key,
    sessionID,
    method: "promptAsync",
    agent,
    model: modelName(model),
    variant: model.variant,
    promptFile: shown(run.rootDir, promptFile),
    promptBytes: Buffer.byteLength(text, "utf8"),
    outputs: outputStates(run.rootDir, outputs, before),
  });
  const result = await harness.client.session
    .promptAsync({
      sessionID,
      directory: run.rootDir,
      agent,
      model: { providerID: model.providerID, modelID: model.modelID },
      variant: model.variant,
      parts: [{ type: "text", text }],
    })
    .catch((error: unknown) => {
      log(run, "prompt", "submit threw", {
        key,
        sessionID,
        elapsedMs: Date.now() - promptStarted,
        error: describe(error),
      });
      emit(run, {
        type: "prompt",
        phase,
        agent: key,
        status: "failed",
        sessionID: shortID(sessionID),
        error: describe(error),
      });
      throw error;
    });
  if (result.error) {
    log(run, "prompt", "submit error", {
      key,
      sessionID,
      elapsedMs: Date.now() - promptStarted,
      error: describe(result.error),
    });
    emit(run, {
      type: "prompt",
      phase,
      agent: key,
      status: "failed",
      sessionID: shortID(sessionID),
      error: describe(result.error),
    });
    throw new Error(
      `session prompt failed for ${key}: ${describe(result.error)}`,
    );
  }
  log(run, "prompt", "accepted", {
    key,
    sessionID,
    elapsedMs: Date.now() - promptStarted,
    response: summarizeData(result.data),
  });
  emit(run, {
    type: "prompt",
    phase,
    agent: key,
    status: "accepted",
    sessionID: shortID(sessionID),
  });
  const finalOutputs = await waitForOutputs(run, outputs, before, {
    key,
    phase,
    sessionID,
  });
  log(run, "prompt", "done", {
    key,
    sessionID,
    elapsedMs: Date.now() - promptStarted,
    outputs: finalOutputs,
  });
  emit(run, {
    type: "prompt",
    phase,
    agent: key,
    status: "done",
    sessionID: shortID(sessionID),
    outputs: finalOutputs,
  });
  const outputEvent = promptOutputEvent(key, phase, outputs);
  if (outputEvent) emit(run, outputEvent);
  progress(
    run,
    phase,
    `${key} done ${duration(promptStarted)} ${formatStates(finalOutputs)}`,
  );
}

/**
 * Snapshots the current `mtimeMs` of each output path before a prompt is submitted.
 * Returns 0 for files that do not yet exist, so any creation is treated as a change.
 *
 * @param outputs - Absolute file paths to snapshot.
 * @returns Map from path to `mtimeMs` (0 if not present).
 */
function outputTimes(outputs: string[]) {
  return new Map(
    outputs.map((path) => [
      path,
      existsSync(path) ? statSync(path).mtimeMs : 0,
    ]),
  );
}

/**
 * Builds an array of {@link FileOutputState} objects that compare current disk state
 * against the pre-prompt baseline captured by {@link outputTimes}.
 *
 * @param rootDir - Project root for display paths.
 * @param outputs - Absolute file paths to inspect.
 * @param before - Baseline mtime map from {@link outputTimes}.
 */
function outputStates(
  rootDir: string,
  outputs: string[],
  before: Map<string, number>,
): FileOutputState[] {
  return outputs.map((path) => {
    const previousMtimeMs = before.get(path) || 0;
    const state = fileState(rootDir, path);
    return {
      ...state,
      previousMtimeMs,
      changed: state.exists && (state.mtimeMs || 0) > previousMtimeMs,
    };
  });
}

/**
 * Returns a lightweight snapshot of a single file's existence and size.
 *
 * @param rootDir - Used to produce a relative display path.
 * @param path - Absolute path to the file.
 */
function fileState(rootDir: string, path: string) {
  if (!existsSync(path)) return { path: shown(rootDir, path), exists: false };
  const stat = statSync(path);
  return {
    path: shown(rootDir, path),
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Polls the filesystem until all `outputs` exist and have been modified since
 * the `before` baseline, or until the configured timeout elapses.
 *
 * Uses a 500 ms sleep between polls to avoid hot-spinning while outputs are being written.
 * Periodic wait snapshots are written to `swarm.log`, not stdout. Console output
 * stays event-driven so long-running agents do not spam the terminal.
 *
 * @param run - Current run state for display paths and logging.
 * @param outputs - Absolute paths that must exist and have newer mtimes.
 * @param before - Pre-prompt mtime baseline from {@link outputTimes}.
 * @param details - Context included in every log line (key, phase, sessionID).
 * @returns Resolves with the final {@link FileOutputState} array once all outputs are ready.
 * @throws `Error` if `SWARM_AGENT_TIMEOUT_MS` elapses before all outputs are ready.
 */
async function waitForOutputs(
  run: RunState,
  outputs: string[],
  before: Map<string, number>,
  details: { key: string; phase: string; sessionID: string },
): Promise<FileOutputState[]> {
  const timeoutMs = Number(process.env.SWARM_AGENT_TIMEOUT_MS || 900000);
  const logIntervalMs = Math.max(
    1000,
    Number(process.env.SWARM_WAIT_LOG_INTERVAL_MS || 10000),
  );
  const startedAt = Date.now();
  let nextLogAt = startedAt + logIntervalMs;
  log(run, "prompt", "wait start", {
    ...details,
    timeoutMs,
    logIntervalMs,
    outputs: outputStates(run.rootDir, outputs, before),
  });
  while (Date.now() - startedAt < timeoutMs) {
    const states = outputStates(run.rootDir, outputs, before);
    if (states.every((state) => state.exists && state.changed)) return states;
    if (Date.now() >= nextLogAt) {
      log(run, "prompt", "wait", {
        ...details,
        elapsedMs: Date.now() - startedAt,
        outputs: states,
      });
      nextLogAt = Date.now() + logIntervalMs;
    }
    await sleep(500);
  }
  log(run, "prompt", "wait timeout", {
    ...details,
    elapsedMs: Date.now() - startedAt,
    outputs: outputStates(run.rootDir, outputs, before),
  });
  throw new Error(
    `timed out waiting for ${outputs.map((path) => shown(run.rootDir, path)).join(", ")}`,
  );
}

/**
 * Reads and strictly validates a `decision.json` file written by the orchestrator.
 * Throws descriptive errors for every required field that is missing or of the wrong type,
 * rather than silently producing an invalid {@link Decision}.
 *
 * @param file - Absolute path to the decision JSON file.
 * @returns A fully-typed and validated {@link Decision}.
 * @throws If the file is not valid JSON or any required field fails its type check.
 */
function readDecision(file: string): Decision {
  const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Decision>;
  const outcome = data.outcome;
  if (
    outcome !== "accept" &&
    outcome !== "continue" &&
    outcome !== "stop_with_risks"
  )
    throw new Error(`invalid decision outcome: ${file}`);
  if (typeof data.reason !== "string")
    throw new Error(`invalid decision reason: ${file}`);
  if (typeof data.checksPass !== "boolean")
    throw new Error(`invalid decision checksPass: ${file}`);
  if (typeof data.accepts !== "number")
    throw new Error(`invalid decision accepts: ${file}`);
  if (typeof data.blocks !== "number")
    throw new Error(`invalid decision blocks: ${file}`);
  return {
    outcome,
    reason: data.reason,
    checksPass: data.checksPass,
    accepts: data.accepts,
    blocks: data.blocks,
  };
}

/**
 * Starts a local HTTP server that serves run artifacts from `runDir`.
 *
 * Provides semantic routes so consumers can always use stable URLs regardless of
 * the profile's artifact name:
 * - `/` → the artifact (if it exists) or `report.html`
 * - `/report.html`, `/report.md`, `/brief.md` → direct file routes
 * - `/checks.json` → the checks from the most recent iteration
 *
 * Any other path is resolved relative to `runDir` after a path-traversal guard.
 * Tries port 5177 first; falls back to an OS-assigned port if that port is taken.
 *
 * @param run - Current run state whose directory will be served.
 * @param artifact - Profile artifact filename (e.g. `"fixed.html"`), used for the `/` route.
 * @param preferredPort - Port to try first; defaults to `5177`.
 * @returns Object with the live `server` instance and the actual bound `port`.
 */
async function serve(run: RunState, artifact: string, preferredPort = 5177) {
  const { runDir } = run;
  const root = resolve(runDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(
      new URL(req.url || "/", "http://local").pathname,
    );
    const latest = latestIteration(runDir);
    const routes: Record<string, string> = {
      "/": existsSync(join(runDir, artifact)) ? artifact : "report.html",
      "/report.html": "report.html",
      "/report.md": "report.md",
      "/brief.md": "brief.md",
      "/checks.json": latest
        ? join("iterations", latest, "checks.json")
        : "checks.json",
    };
    const routed = routes[path];
    const file = routed ? join(runDir, routed) : resolve(root, `.${path}`);
    // Reject requests that escape the run directory or point to non-files.
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
  const port = await listen(server, preferredPort).catch(
    (e: NodeJS.ErrnoException) =>
      e.code === "EADDRINUSE" ? listen(server, 0) : Promise.reject(e),
  );
  log(run, "serve", "listening", { port });
  emit(run, { type: "serve", port, localUrl: `http://localhost:${port}` });
  return { server, port };
}

/**
 * Scans iteration folders `099` down to `001` and returns the newest one that
 * contains `checks.json`.
 *
 * @param runDir - Current run directory.
 * @returns Zero-padded folder name (e.g. `"002"`) or `""` if no checks file is found.
 */
function latestIteration(runDir: string) {
  for (let i = 99; i >= 1; i--)
    if (existsSync(join(runDir, "iterations", pad(i), "checks.json")))
      return pad(i);
  return "";
}

/**
 * Wraps `server.listen` in a promise, resolving with the actual bound port.
 *
 * @param server - Node.js HTTP server to start.
 * @param port - Requested port; 0 lets the OS pick an available port.
 * @returns Resolves with the bound port number.
 * @throws Any error emitted by the server during startup.
 */
function listen(server: Server, port: number) {
  return new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen((server.address() as { port: number }).port);
    });
  });
}

/**
 * Parses `SWARM_MODEL` into its constituent parts.
 * `SWARM_ORCHESTRATOR_MODEL` and `SWARM_FIXER_MODEL` override it for those sessions.
 * Reviewer sessions are intentionally hard-coded to low reasoning while the
 * orchestrator and fixer stay at max.
 * Expected format: `<providerID>/<modelID>` (e.g. `"deepseek/deepseek-v4-flash"`).
 *
 * @returns Object with `providerID`, `modelID`, and `variant`.
 */
function modelSpec(key?: string) {
  let model = process.env.SWARM_MODEL || "deepseek/deepseek-v4-flash";
  if (key === "orchestrator")
    model = process.env.SWARM_ORCHESTRATOR_MODEL || model;
  if (key === "fixer") model = process.env.SWARM_FIXER_MODEL || model;
  const [providerID, ...rest] = model.split("/");
  return {
    providerID,
    modelID: rest.join("/"),
    variant: key === "orchestrator" || key === "fixer" ? "max" : "low",
  };
}

/**
 * Formats a model spec object as the canonical `provider/model` string.
 *
 * @param model - Object with `providerID` and `modelID`.
 */
function modelName(model: { providerID: string; modelID: string }) {
  return `${model.providerID}/${model.modelID}`;
}

/**
 * Appends a structured log line to the run's `swarm.log` file.
 *
 * @param run - Current run state containing the log file and start time.
 * @param step - High-level phase label (e.g. `"scan"`, `"prompt"`, `"decision"`).
 * @param message - Short event description (e.g. `"starting"`, `"done"`, `"timeout"`).
 * @param data - Optional structured data serialized as JSON on the same line.
 */
function log(run: RunState, step: string, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${serialize(data)}`;
  const line = `${new Date().toISOString()} +${Date.now() - run.started}ms ${step} ${message}${suffix}\n`;
  appendFileSync(run.logFile, line);
}

function line(run: RunState, text: string) {
  lineReporter(run.reporter, text);
}

function emit(run: RunState, event: SwarmEvent) {
  emitReporter(run.reporter, run.started, event);
}

/**
 * Prints a bracketed progress line to stdout for real-time operator visibility.
 *
 * @param run - Current run state with presentation hooks.
 * @param phase - Current workflow phase (e.g. `"scan"`, `"check"`, `"iteration 2/3"`).
 * @param message - Event detail appended after the phase label.
 */
function progress(run: RunState, phase: string, message: string) {
  progressReporter(run.reporter, run.started, phase, message);
}

/**
 * Returns a human-readable elapsed duration since `startedAt`.
 * Sub-second values render as `"NNNms"`; longer values as `"N.Ns"` or `"NNs"`.
 *
 * @param startedAt - Epoch ms timestamp to measure from.
 */
function duration(startedAt: number) {
  const ms = Date.now() - startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/**
 * Builds a compact file-size summary string for a list of expected artefact paths.
 * Used in the scan-complete progress line.
 *
 * @param rootDir - Project root for display paths.
 * @param paths - Absolute paths to the artefact files.
 */
function artifactSummary(rootDir: string, paths: string[]) {
  return paths
    .map((path) => {
      const state = fileState(rootDir, path);
      return state.exists
        ? `${outputName(path)}=${formatBytes(state.size)}`
        : `${outputName(path)}=missing`;
    })
    .join(" ");
}

/**
 * Formats an array of {@link FileOutputState} objects as a compact `name=size` string.
 *
 * @param states - Output states to format.
 */
function formatStates(states: FileOutputState[]) {
  return states
    .map((state) =>
      state.exists
        ? `${outputName(state.path)}=${formatBytes(state.size)}`
        : `${outputName(state.path)}=missing`,
    )
    .join(" ");
}

/**
 * Extracts the basename of a path for compact display in progress and log lines.
 *
 * @param path - Any file path (absolute, relative, or display form).
 */
function outputName(path: string) {
  return basename(path);
}

/**
 * Formats a byte count as a human-readable string (`"NB"` or `"NKB"`).
 * Returns `"?B"` for undefined values (e.g. when a file does not exist).
 *
 * @param bytes - Number of bytes, or `undefined`.
 */
function formatBytes(bytes?: number) {
  if (bytes === undefined) return "?B";
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round(bytes / 1024)}KB`;
}

/**
 * Truncates a long ID to `first8...last4` form for readable progress output.
 *
 * @param id - Full identifier string (e.g. a UUID session ID).
 */
function shortID(id: string) {
  return id.length <= 16 ? id : `${id.slice(0, 8)}...${id.slice(-4)}`;
}

/**
 * Collapses whitespace in `text`, then JSON-serializes and truncates to 160 characters.
 * Produces a safely-quoted single-line string for embedding in log lines.
 *
 * @param text - Arbitrary text to quote.
 */
function quote(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(
    clean.length > 160 ? `${clean.slice(0, 157)}...` : clean,
  );
}

/**
 * Calls `JSON.stringify` for log data. If serialization throws, such as for
 * circular objects or BigInts, returns a small JSON object with the error detail.
 *
 * @param data - Value to serialize.
 */
function serialize(data: unknown) {
  try {
    return JSON.stringify(data);
  } catch (error) {
    return JSON.stringify({ unserializable: describe(error) });
  }
}

/**
 * Reduces an arbitrary response object to a small summary suitable for log lines,
 * avoiding the cost of serializing large agent payloads in full.
 *
 * Arrays are summarized by length. Objects keep their first keys plus selected
 * scalar fields (`id`, `sessionID`, `role`, etc.), discarding the rest.
 *
 * @param data - Raw value returned by the opencode SDK.
 */
function summarizeData(data: unknown) {
  if (data === null || data === undefined || typeof data !== "object")
    return data;
  if (Array.isArray(data)) return { type: "array", length: data.length };
  const obj = data as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    keys: Object.keys(obj).slice(0, 20),
  };
  for (const key of [
    "id",
    "sessionID",
    "messageID",
    "role",
    "type",
    "status",
  ]) {
    if (key in obj) summary[key] = obj[key];
  }
  if ("time" in obj) summary.time = obj.time;
  return summary;
}

/**
 * Returns `path` relative to `rootDir` for compact display.
 *
 * @param rootDir - Absolute base directory.
 * @param path - Absolute path to make relative.
 */
function shown(rootDir: string, path: string) {
  return relative(rootDir, path);
}

/**
 * Zero-pads a number to three digits (e.g. `1` → `"001"`, `12` → `"012"`).
 * Used to create lexicographically-sortable iteration directory names.
 *
 * @param n - Non-negative integer to pad.
 */
function pad(n: number) {
  return String(n).padStart(3, "0");
}

/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 */
function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Maps a file extension to its MIME type for HTTP responses.
 * Returns `"application/octet-stream"` for unknown extensions.
 *
 * @param file - Absolute or relative file path; only the extension is examined.
 */
function contentType(file: string) {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
      } as Record<string, string>
    )[extname(file).toLowerCase()] || "application/octet-stream"
  );
}

/**
 * Converts thrown values to readable text for log lines.
 *
 * Handles `Error` instances (including chained `.cause`) and plain objects with
 * `code`/`message`/`cause` fields, which are common in Node.js SDK errors.
 * For other values, it returns `JSON.stringify(error)`; some JavaScript values,
 * such as `undefined`, stringify to `undefined`.
 *
 * @param error - The caught value (may be any type).
 */
function describe(error: unknown): string {
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
