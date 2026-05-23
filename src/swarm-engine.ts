/**
 * Single-file swarm engine.
 *
 * A generic, domain-agnostic orchestrator for multi-agent code/text/page
 * remediation runs. Drives a fixed pipeline:
 *
 *   scan → brief → (fix → check → vote? → decide)* → report → serve
 *
 * The pipeline itself knows nothing about the task category. Domain logic
 * lives entirely in a {@link SwarmProfile} that the caller supplies.
 *
 * Requirements:
 *   - Node.js 20+
 *   - @opencode-ai/sdk (for the agent client)
 *
 * Usage:
 *   import { runSwarm, type SwarmProfile } from "./swarm-engine";
 *
 *   const profile: SwarmProfile = {
 *     id: "my-task",
 *     artifact: "result.txt",
 *     reviewers: [{ id: "alice", name: "Alice" }],
 *     async scan(input, ctx)          { ... write inputs into ctx.runDir },
 *     async check(ctx, iteration)     { ... return { passed, failures } },
 *     briefPrompt(ctx)                { return "..." },
 *     fixPrompt(ctx)                  { return "..." },
 *     votePrompt(ctx, reviewer)       { return "..." },
 *     decisionPrompt(ctx)             { return "..." },
 *   };
 *
 *   await runSwarm(profile, "some input", process.cwd());
 *
 * Environment variables:
 *   SWARM_MODEL                  — default "deepseek/deepseek-v4-flash"
 *   SWARM_ORCHESTRATOR_MODEL     — overrides SWARM_MODEL for the orchestrator
 *   SWARM_FIXER_MODEL            — overrides SWARM_MODEL for the fixer
 *   SWARM_AGENT                  — opencode agent name (default "build")
 *   SWARM_MAX_ITERATIONS         — max iterations per run (default 3)
 *   SWARM_AGENT_TIMEOUT_MS       — per-prompt timeout (default 900000)
 *   SWARM_WAIT_LOG_INTERVAL_MS   — wait-for-output log heartbeat (default 10000)
 *   SWARM_OPENCODE_SERVER_URL    — attach to existing opencode server instead of spawning
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Server, type ServerResponse, createServer } from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type PermissionRuleset,
} from "@opencode-ai/sdk/v2";

/* ================================================================== *
 *  Types                                                              *
 * ================================================================== */

/** A reviewer agent: stable `id` (used as session key and filename prefix) plus a human label. */
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
 * Domain-specific logic for one task category. Plug your task in by providing
 * these methods; the engine itself stays domain-agnostic.
 *
 * Call order: `scan` → `briefPrompt` → (`fixPrompt` → `check` → `votePrompt` → `decisionPrompt`)* → optional `writeReport`.
 */
export type SwarmProfile = {
  /** Stable profile ID — logged and emitted on `run_start`. */
  id: string;
  /** Filename (relative to `runDir`) of the primary artifact the fixer produces. */
  artifact: string;
  /** Reviewer roster. Empty array skips voting and auto-accepts when checks pass. */
  reviewers: Reviewer[];
  /**
   * Paths (relative to `runDir`) that `scan` is expected to produce. Used only
   * for the post-scan progress summary; missing files are reported as such.
   */
  scanArtifacts?: string[];

  scan(input: string, ctx: RunPaths): Promise<void>;
  check(ctx: RunPaths, iteration: number): Promise<CheckResult>;

  briefPrompt(ctx: RunPaths): string;
  fixPrompt(ctx: IterationPaths): string;
  votePrompt(ctx: IterationPaths, reviewer: Reviewer): string;
  decisionPrompt(ctx: IterationPaths): string;

  /**
   * Optional final-report writer. Called once after the last iteration before
   * the preview server starts. Typically writes `report.html` / `report.md`
   * into `run.runDir`. If omitted, the engine writes a minimal generic
   * `report.html` so the preview server always has something to serve.
   */
  writeReport?(run: RunState, decision?: Decision): void;
};

export type RunState = RunPaths & {
  profile: SwarmProfile;
  input: string;
  maxIterations: number;
  logFile: string;
  started: number;
  reporter: SwarmReporter;
  harness?: AgentHarness;
  /**
   * Accumulated cost+tokens across every prompt this run. Populated lazily by
   * the harness on the first successful prompt:done. Best-effort: a provider
   * that does not report usage leaves these counters at zero.
   */
  usage?: { total: PromptUsage; byAgent: Record<string, PromptUsage> };
};

/** Holds the live opencode server connection and the session ID registry for one run. */
export type AgentHarness = {
  client: OpencodeClient;
  url: string;
  /** When present, releases a locally-spawned opencode server. Absent for external servers. */
  close?: () => void;
  /** Maps logical agent keys (`"orchestrator"`, `"fixer"`, reviewer IDs) to opencode session IDs. */
  sessions: Record<string, string>;
  modelsValidated?: boolean;
};

/** Per-prompt token + cost usage. `cost` is in USD; all values default to 0 when omitted. */
export type PromptUsage = {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
};

/** Machine-readable lifecycle event emitted for dashboards and other frontends. */
export type SwarmEvent = {
  type: string;
  timestamp?: string;
  elapsedMs?: number;
  [key: string]: unknown;
};

/** Presentation hooks. Keeps UI state out of the engine. */
export type SwarmReporter = {
  line?(text: string): void;
  progress?(phase: string, message: string): void;
  event?(event: SwarmEvent): void;
};

export type RunSwarmOptions = {
  reporter?: SwarmReporter;
};

type FileOutputState = {
  path: string;
  exists: boolean;
  changed: boolean;
  previousMtimeMs: number;
  mtimeMs?: number;
  size?: number;
};

/* ================================================================== *
 *  Reporter                                                           *
 * ================================================================== */

export const consoleReporter: SwarmReporter = {
  line: (text) => console.log(text),
  progress: (phase, message) => console.log(`[${phase}] ${message}`),
};

function reporterLine(reporter: SwarmReporter, text: string) {
  reporter.line?.(text);
}

function reporterEmit(reporter: SwarmReporter, started: number, event: SwarmEvent) {
  reporter.event?.({
    ...event,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  });
}

function reporterProgress(
  reporter: SwarmReporter,
  started: number,
  phase: string,
  message: string,
) {
  reporter.progress?.(phase, message);
  reporterEmit(reporter, started, { type: "progress", phase, message });
}

function promptOutputEvent(
  key: string,
  phase: string,
  outputs: string[],
): SwarmEvent | undefined {
  if (phase === "vote") {
    const data = readJsonObject(outputs[0]);
    return {
      type: "reviewer",
      id: key,
      phase: "vote",
      status: "done",
      vote: stringValue(data?.vote) || "unknown",
      score: numberValue(data?.score),
      summary: summarizeReviewerText(stringValue(data?.reason) || "vote saved"),
    };
  }
  return undefined;
}

/* ================================================================== *
 *  Engine                                                             *
 * ================================================================== */

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

    writeReport(run, lastDecision);
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
  progress(run, "scan", `start input=${input}`);
  try {
    await profile.scan(input, run);
    const scanArtifacts = profile.scanArtifacts ?? [];
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

/**
 * Calls the profile's report writer if provided; otherwise writes a minimal
 * generic `report.html` so the preview server always has something to serve.
 */
function writeReport(run: RunState, decision?: Decision) {
  if (run.profile.writeReport) {
    run.profile.writeReport(run, decision);
    return;
  }
  const reportFile = join(run.runDir, "report.html");
  const body = decision
    ? `<p><strong>Outcome:</strong> ${escapeHtml(decision.outcome)}</p>` +
      `<p><strong>Reason:</strong> ${escapeHtml(decision.reason)}</p>` +
      `<p>Checks pass: ${decision.checksPass} · accepts: ${decision.accepts} · blocks: ${decision.blocks}</p>`
    : `<p>Run finished without a recorded decision.</p>`;
  writeFileSync(
    reportFile,
    `<!doctype html><meta charset="utf-8"><title>Swarm report</title>` +
      `<h1>Swarm report</h1>` +
      `<p>Profile: ${escapeHtml(run.profile.id)} · Input: ${escapeHtml(run.input)}</p>` +
      body,
  );
}

/* ================================================================== *
 *  Harness (opencode SDK)                                             *
 * ================================================================== */

const allowAll: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
];

/** Releases only the opencode server owned by this run. External servers are left running. */
export function closeHarness(run: RunState) {
  const harness = run.harness;
  if (harness?.close)
    log(run, "opencode", "closing server", { url: harness.url });
  else if (harness)
    log(run, "opencode", "leaving external server open", { url: harness.url });
  harness?.close?.();
  run.harness = undefined;
}

/**
 * Returns the active {@link AgentHarness}, creating one if none exists.
 *
 * Precedence:
 *   1. Reuse the current run's harness if already initialized.
 *   2. Connect to an externally-managed server via `SWARM_OPENCODE_SERVER_URL`.
 *   3. Spawn a new in-process opencode server on an OS-assigned port.
 */
export async function ensureHarness(run: RunState): Promise<AgentHarness> {
  if (run.harness) {
    log(run, "opencode", "reusing harness", {
      url: run.harness.url,
      sessions: Object.keys(run.harness.sessions).length,
    });
    return run.harness;
  }
  const url = process.env.SWARM_OPENCODE_SERVER_URL;
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
 * Fails fast when the configured model points at a provider/model opencode
 * cannot use. Without this preflight a provider error can surface only in
 * opencode's logs while runSwarm keeps polling for files that will never appear.
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
        `If using LLM providers, set the API key in ${shown(run.rootDir, join(run.rootDir, ".env"))} or export it before starting an external opencode server.`,
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
 * Returns the opencode session ID for the given logical agent key, creating a
 * new session if one does not yet exist for this run. Session IDs are persisted
 * to `sessions.json` so progress can be inspected externally during a run.
 */
async function sessionFor(harness: AgentHarness, run: RunState, key: string) {
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
 * files exist and have changed on disk. The prompt text is persisted to
 * `promptFile` before submission so the exact instruction sent to each agent
 * is reproducible from the run directory.
 */
export async function promptAgent(
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
      reportPromptFailed(run, phase, key, sessionID, promptStarted, "submit threw", error);
      throw error;
    });
  if (result.error) {
    reportPromptFailed(
      run,
      phase,
      key,
      sessionID,
      promptStarted,
      "submit error",
      result.error,
    );
    throw new Error(
      `session prompt failed for ${key}: ${describe(result.error)}`,
    );
  }
  log(run, "prompt", "accepted", {
    key,
    sessionID,
    elapsedMs: Date.now() - promptStarted,
    response: summarizeResponse(result.data),
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
  // Best-effort: provider/SDK errors here must never break a finished run.
  // The assistant message ID was returned by promptAsync; messages() is the
  // only endpoint that exposes the final cost+token counts.
  const messageID = (result.data as { id?: string } | undefined)?.id;
  const usage = messageID
    ? await readPromptUsage(harness, sessionID, messageID)
    : undefined;
  if (usage) accumulateUsage(run, key, usage);
  log(run, "prompt", "done", {
    key,
    sessionID,
    elapsedMs: Date.now() - promptStarted,
    outputs: finalOutputs,
    usage,
  });
  emit(run, {
    type: "prompt",
    phase,
    agent: key,
    status: "done",
    sessionID: shortID(sessionID),
    outputs: finalOutputs,
    usage,
  });
  const outputEvent = promptOutputEvent(key, phase, outputs);
  if (outputEvent) emit(run, outputEvent);
  progress(
    run,
    phase,
    `${key} done ${duration(promptStarted)} ${formatStates(finalOutputs)}${usage ? ` tokens=${usage.tokensIn}/${usage.tokensOut}` : ""}`,
  );
}

// Adds one prompt's usage to the running totals on RunState. The per-agent map
// buckets reviewers by their `key` so the roll-up shows orchestrator vs fixer
// vs each reviewer cost individually.
function accumulateUsage(run: RunState, key: string, delta: PromptUsage) {
  run.usage ??= { total: zeroUsage(), byAgent: {} };
  addInto(run.usage.total, delta);
  run.usage.byAgent[key] ??= zeroUsage();
  addInto(run.usage.byAgent[key], delta);
}

function zeroUsage(): PromptUsage {
  return {
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
  };
}

function addInto(target: PromptUsage, delta: PromptUsage) {
  target.cost += delta.cost;
  target.tokensIn += delta.tokensIn;
  target.tokensOut += delta.tokensOut;
  target.tokensReasoning += delta.tokensReasoning;
  target.tokensCacheRead += delta.tokensCacheRead;
  target.tokensCacheWrite += delta.tokensCacheWrite;
}

function outputTimes(outputs: string[]) {
  return new Map(
    outputs.map((path) => [
      path,
      existsSync(path) ? statSync(path).mtimeMs : 0,
    ]),
  );
}

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

function formatStates(states: FileOutputState[]) {
  return states
    .map((state) =>
      state.exists
        ? `${outputName(state.path)}=${formatBytes(state.size)}`
        : `${outputName(state.path)}=missing`,
    )
    .join(" ");
}

/** Polls the filesystem until every `outputs` path has a newer mtime than `before`, or times out. */
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

/** Reads `decision.json` and throws a descriptive error for each missing or wrong-typed field. */
export function readDecision(file: string): Decision {
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
 * Resolves the model spec for one agent key. Orchestrator/fixer use the `max`
 * reasoning variant; reviewers and everything else use `low`. Per-role env
 * overrides: SWARM_ORCHESTRATOR_MODEL, SWARM_FIXER_MODEL.
 */
export function modelSpec(key?: string) {
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

export function modelName(model: { providerID: string; modelID: string }) {
  return `${model.providerID}/${model.modelID}`;
}

/**
 * Fetches the assistant message for the just-completed prompt and returns its
 * cost+tokens. Returns undefined on any failure — usage telemetry is
 * best-effort and never blocks a run.
 */
async function readPromptUsage(
  harness: AgentHarness,
  sessionID: string,
  messageID: string,
): Promise<PromptUsage | undefined> {
  const result = await harness.client.session
    .messages({ sessionID, directory: undefined, limit: 20 })
    .catch(() => undefined);
  if (!result || result.error || !Array.isArray(result.data)) return undefined;
  const entry = result.data.find(
    (item: { info?: { id?: string; role?: string } }) =>
      item?.info?.id === messageID && item.info.role === "assistant",
  );
  if (!entry) return undefined;
  const info = entry.info as {
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  return {
    cost: info.cost ?? 0,
    tokensIn: info.tokens?.input ?? 0,
    tokensOut: info.tokens?.output ?? 0,
    tokensReasoning: info.tokens?.reasoning ?? 0,
    tokensCacheRead: info.tokens?.cache?.read ?? 0,
    tokensCacheWrite: info.tokens?.cache?.write ?? 0,
  };
}

// Keeps the "prompt accepted" log line bounded: the SDK returns a message
// object whose `parts` array can be huge after a long agent run.
function summarizeResponse(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  return {
    id: obj.id,
    sessionID: obj.sessionID,
    role: obj.role,
    time: obj.time,
  };
}

// Shared shape for both "submit threw" (SDK rejection) and "submit error"
// (SDK returned a 2xx with an error body). Two log messages, one event shape.
function reportPromptFailed(
  run: RunState,
  phase: string,
  key: string,
  sessionID: string,
  startedAt: number,
  logMessage: string,
  error: unknown,
) {
  const message = describe(error);
  log(run, "prompt", logMessage, {
    key,
    sessionID,
    elapsedMs: Date.now() - startedAt,
    error: message,
  });
  emit(run, {
    type: "prompt",
    phase,
    agent: key,
    status: "failed",
    sessionID: shortID(sessionID),
    error: message,
  });
}

/* ================================================================== *
 *  Preview server                                                     *
 * ================================================================== */

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Starts a local HTTP server that serves run artifacts from `runDir`.
 * Tries port 5177 first, then falls back to an OS-assigned port.
 */
export async function serve(run: RunState, artifact: string, preferredPort = 5177) {
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
    if (!sendStaticFile(root, file, res)) {
      res.writeHead(404).end("Not found");
      return;
    }
  });
  const port = await listen(server, preferredPort).catch(
    (e: NodeJS.ErrnoException) =>
      e.code === "EADDRINUSE" ? listen(server, 0) : Promise.reject(e),
  );
  log(run, "serve", "listening", { port });
  emit(run, { type: "serve", port, localUrl: `http://localhost:${port}` });
  return { server, port };
}

function sendStaticFile(root: string, file: string, res: ServerResponse) {
  const safe = safeFile(root, file);
  if (!safe) return false;
  res.setHeader("Content-Type", contentType(safe));
  res.end(readFileSync(safe));
  return true;
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

function safeFile(root: string, file: string) {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(file);
  if (!(resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}/`)))
    return undefined;
  return existsSync(resolvedFile) && statSync(resolvedFile).isFile()
    ? resolvedFile
    : undefined;
}

function contentType(file: string) {
  return MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream";
}

/* ================================================================== *
 *  Utilities                                                          *
 * ================================================================== */

export function log(run: RunState, step: string, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${serialize(data)}`;
  const text = `${new Date().toISOString()} +${Date.now() - run.started}ms ${step} ${message}${suffix}\n`;
  appendFileSync(run.logFile, text);
}

export function line(run: RunState, text: string) {
  reporterLine(run.reporter, text);
}

export function emit(run: RunState, event: SwarmEvent) {
  reporterEmit(run.reporter, run.started, event);
}

export function progress(run: RunState, phase: string, message: string) {
  reporterProgress(run.reporter, run.started, phase, message);
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

// One-line human summary of total tokens + cost. Per-agent breakdown lives in
// run_complete.usage.byAgent for machine consumers.
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

function readJsonObject(file?: string) {
  if (!file) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function summarizeReviewerText(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 96 ? `${clean.slice(0, 93)}...` : clean;
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}
