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

/**
 * Identifies a reviewer agent participating in the swarm evaluation loop.
 * Each reviewer runs independently in its own opencode session and produces
 * structured findings and votes per iteration.
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
 * a single iteration (findings, fix, vote, decision).
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
 * `scan → briefPrompt → [findingsPrompt → aggregatePrompt → fixPrompt →
 * check → votePrompt → decisionPrompt]* → reportPrompt`
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
   * fed into the vote and decision prompts.
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
   * Returns the prompt for a reviewer agent to produce its `findings/<id>.json`
   * for the current iteration.
   */
  findingsPrompt(ctx: IterationPaths, reviewer: Reviewer): string;

  /**
   * Returns the prompt that instructs the orchestrator to merge all reviewer
   * findings into `aggregate-feedback.json` and a `solver-task.md` work order.
   */
  aggregatePrompt(ctx: IterationPaths): string;

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

  /**
   * Returns the prompt that instructs the orchestrator to produce `report.md`
   * and `report.html` summarizing the entire run.
   * @param decision - Final decision from the last completed iteration, if one exists.
   */
  reportPrompt(ctx: RunPaths, decision?: Decision): string;
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
 *    - All reviewers produce findings concurrently.
 *    - The orchestrator aggregates findings into a solver task.
 *    - The fixer agent applies changes to the artifact.
 *    - Automated checks validate the artifact.
 *    - All reviewers cast votes concurrently.
 *    - The orchestrator issues a decision (`accept` / `continue` / `stop_with_risks`).
 *    - The loop breaks early on `accept` or `stop_with_risks`.
 * 6. The orchestrator writes `report.md` and `report.html`.
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
) {
  const run = prepareRun(profile, input, rootDir);

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

    await writeFinalReport(run, harness, lastDecision);
    const served = await serve(run, run.profile.artifact);
    log(run, "run", "completed", {
      decision: lastDecision,
      artifact: fileState(run.rootDir, join(run.runDir, run.profile.artifact)),
      report: fileState(run.rootDir, join(run.runDir, "report.html")),
    });
    console.log(`Run: ${shown(run.rootDir, run.runDir)}`);
    console.log(`Brief: ${shown(run.rootDir, join(run.runDir, "brief.md"))}`);
    console.log(`Report: ${shown(run.rootDir, join(run.runDir, "report.html"))}`);
    console.log(
      `Transformed: ${shown(run.rootDir, join(run.runDir, run.profile.artifact))}`,
    );
    console.log(`Log: ${shown(run.rootDir, run.logFile)}`);
    console.log(`Local: http://localhost:${served.port}`);
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
  };
  const model = modelSpec();
  const orchestratorModel = modelSpec("orchestrator");
  const fixerModel = modelSpec("fixer");

  console.log(`Run: ${shown(rootDir, runDir)}`);
  console.log(`Log: ${shown(rootDir, run.logFile)}`);
  console.log(
    `Model: ${modelName(model)} (variant=${model.variant}), agent=${process.env.SWARM_AGENT || "build"}, maxIterations=${maxIterations}`,
  );
  if (modelName(orchestratorModel) !== modelName(model))
    console.log(`Orchestrator model: ${modelName(orchestratorModel)} (variant=${orchestratorModel.variant})`);
  if (modelName(fixerModel) !== modelName(model))
    console.log(`Fixer model: ${modelName(fixerModel)} (variant=${fixerModel.variant})`);

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
    fixerModel: modelName(fixerModel),
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
  progress("scan", `start url=${input}`);
  try {
    await profile.scan(input, run);
    const scanArtifacts = [
      "original.html",
      "facts.json",
      "axe.json",
      join("screenshots", "original.png"),
    ];
    progress(
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
  } catch (error) {
    log(run, "scan", "failed", {
      elapsedMs: Date.now() - scanStarted,
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
 * Example: iteration 1 gets `iterations/001/findings/` and
 * `iterations/001/votes/`. runIteration uses this context for every prompt in
 * the cycle so all agent outputs land under the same iteration directory.
 */
function prepareIteration(run: RunState, iteration: number): IterationPaths {
  const iterDir = join(run.runDir, "iterations", pad(iteration));
  const iter: IterationPaths = {
    rootDir: run.rootDir,
    runDir: run.runDir,
    iterDir,
    iteration,
  };
  mkdirSync(join(iterDir, "findings"), { recursive: true });
  mkdirSync(join(iterDir, "votes"), { recursive: true });
  log(run, "iteration", "start", {
    iteration,
    iterDir: shown(run.rootDir, iterDir),
  });
  progress(`iteration ${iteration}/${run.maxIterations}`, "start");
  return iter;
}

/**
 * Runs one complete improvement cycle.
 *
 * This is the core loop body used by runSwarm. The order is the contract:
 * reviewers find issues, the orchestrator turns them into a task, the fixer
 * writes the artifact, automated checks run, reviewers vote, then the
 * orchestrator decides whether to stop or continue.
 */
async function runIteration(
  run: RunState,
  harness: AgentHarness,
  iteration: number,
): Promise<Decision> {
  const iter = prepareIteration(run, iteration);
  await collectFindings(run, harness, iter);
  await promptAgent(
    harness,
    run,
    "orchestrator",
    "aggregate",
    join(iter.iterDir, "prompts", "aggregate.md"),
    [
      join(iter.iterDir, "aggregate-feedback.json"),
      join(iter.iterDir, "solver-task.md"),
    ],
    run.profile.aggregatePrompt(iter),
  );
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
  await runChecks(run, iter);
  await collectVotes(run, harness, iter);
  return decideIteration(run, harness, iter);
}

/**
 * Collects reviewer findings for the current artifact state.
 *
 * Reviewers are independent specialists, so running them in parallel preserves
 * the same contract while avoiding unnecessary wall-clock delay.
 */
async function collectFindings(
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
        "findings",
        join(iter.iterDir, "prompts", `${reviewer.id}-findings.md`),
        [join(iter.iterDir, "findings", `${reviewer.id}.json`)],
        run.profile.findingsPrompt(iter, reviewer),
      ),
    ),
  );
}

/**
 * Runs deterministic validation after the fixer writes the candidate artifact.
 *
 * The resulting checks.json becomes evidence for both reviewer votes and the
 * orchestrator decision, so it must happen after fixing and before voting.
 */
async function runChecks(run: RunState, iter: IterationPaths) {
  const checkStarted = Date.now();
  log(run, "check", "start", { iteration: iter.iteration });
  progress("check", `start iteration=${iter.iteration}`);
  let checks: CheckResult;
  try {
    checks = await run.profile.check(run, iter.iteration);
  } catch (error) {
    log(run, "check", "failed", {
      iteration: iter.iteration,
      elapsedMs: Date.now() - checkStarted,
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
  progress(
    "check",
    `${checks.passed ? "passed" : "failed"} ${duration(checkStarted)} failures=${checks.failures.length}`,
  );
  for (const failure of checks.failures.slice(0, 3))
    progress("check", `failure: ${failure}`);
  if (checks.failures.length > 3)
    progress(
      "check",
      `...${checks.failures.length - 3} more failures in checks.json`,
    );
}

/**
 * Collects reviewer votes after automated checks are available.
 *
 * Votes mirror findings: each reviewer can judge the candidate independently,
 * but now with transformed artifact, solver result, and checks.json evidence.
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
    writeFileSync(decisionFile, JSON.stringify(decision, null, 2));
  }
  log(run, "decision", decision.outcome, decision);
  progress(
    "decision",
    `outcome=${decision.outcome} checksPass=${decision.checksPass} accepts=${decision.accepts} blocks=${decision.blocks} reason=${quote(decision.reason)}`,
  );
  return decision;
}

/**
 * Writes the human-facing report after the loop has a final decision.
 *
 * This stays separate from serving so report generation remains an agent file
 * contract, while preview serving remains a local runtime concern.
 */
async function writeFinalReport(
  run: RunState,
  harness: AgentHarness,
  decision?: Decision,
) {
  await promptAgent(
    harness,
    run,
    "orchestrator",
    "report",
    join(run.runDir, "prompts", "report.md"),
    [join(run.runDir, "report.md"), join(run.runDir, "report.html")],
    run.profile.reportPrompt(run, decision),
  );
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
  return run.harness;
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
 * @param phase - Display label used in progress output (e.g. `"findings"`, `"fix"`).
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
  progress(
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
      throw error;
    });
  if (result.error) {
    log(run, "prompt", "submit error", {
      key,
      sessionID,
      elapsedMs: Date.now() - promptStarted,
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
  progress(phase, `${key} accepted in ${duration(promptStarted)}`);
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
  progress(
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
 * Logs progress at `SWARM_WAIT_LOG_INTERVAL_MS` intervals (default 10 s).
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
      progress(
        details.phase,
        `${details.key} ${waitSummary(states, startedAt)}`,
      );
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
 * Expected format: `<providerID>/<modelID>` (e.g. `"deepseek/deepseek-v4-flash"`).
 *
 * @returns Object with `providerID`, `modelID`, and `variant`.
 */
function modelSpec(key?: string) {
  let model = process.env.SWARM_MODEL || "deepseek/deepseek-v4-flash";
  if (key === "orchestrator") model = process.env.SWARM_ORCHESTRATOR_MODEL || model;
  if (key === "fixer") model = process.env.SWARM_FIXER_MODEL || model;
  const [providerID, ...rest] = model.split("/");
  return {
    providerID,
    modelID: rest.join("/"),
    variant: process.env.SWARM_VARIANT || "max",
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

/**
 * Prints a bracketed progress line to stdout for real-time operator visibility.
 *
 * @param phase - Current workflow phase (e.g. `"scan"`, `"check"`, `"iteration 2/3"`).
 * @param message - Event detail appended after the phase label.
 */
function progress(phase: string, message: string) {
  console.log(`[${phase}] ${message}`);
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
 * Produces a human-readable wait status summary for the progress line emitted
 * while polling for agent outputs.
 *
 * @param states - Current output states from {@link outputStates}.
 * @param startedAt - Epoch ms when the wait loop started.
 */
function waitSummary(states: FileOutputState[], startedAt: number) {
  const done = states
    .filter((state) => state.exists && state.changed)
    .map((state) => outputName(state.path));
  const missing = states
    .filter((state) => !(state.exists && state.changed))
    .map((state) => outputName(state.path));
  const parts = [
    `${done.length ? "partial" : "waiting"} ${duration(startedAt)}`,
  ];
  if (done.length) parts.push(`done=${done.join(",")}`);
  if (missing.length) parts.push(`missing=${missing.join(",")}`);
  return parts.join(" ");
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
