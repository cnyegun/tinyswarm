import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type PermissionRuleset,
} from "@opencode-ai/sdk/v2";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { aggregate, writeAggregate, type ScoredFinding } from "./aggregate.js";
import { decide, writeDecision } from "./decide.js";
import {
  EnergyMeter,
  extractTokens,
  type LLMCall,
  type ManualBaseline,
} from "./energy.js";
import {
  AuditTrail,
  hashInputFiles,
  hashText,
  type ActionType,
} from "./audit-trail.js";
import { callLLM } from "./llm-client.js";
import {
  applyPatches,
  type PatchBlock,
  FIX_PATCH_SCHEMA,
  type FixPatchResult,
} from "./patch-applier.js";
import { z } from "zod";
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
 * `scan → briefPrompt → [findingsPrompt → (aggregate deterministic) → fixPrompt →
 * check → votePrompt → (decide deterministic)]* → reportPrompt`
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
 *   OPTIONAL: deterministic baseline for energy/cost comparison.
 *   If present, the energy report includes percent-reduction figures.
 *   manualBaseline?: () => ManualBaseline;
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
   * Returns system + user prompt parts for the brief LLM call.
   * `system` is static (role, output format). `user` is dynamic (run paths, file list).
   */
  briefPrompt(ctx: RunPaths): { system: string; user: string };

  /**
   * Returns system + user prompt parts for a reviewer findings LLM call.
   * `system` is static per reviewer role (criteria, output schema).
   * `user` is dynamic per iteration (file list, state delta).
   */
  findingsPrompt(ctx: IterationPaths, reviewer: Reviewer): { system: string; user: string };


  /**
   * Returns system + user prompt parts for the fixer LLM.
   *
   * `system` is static and cacheable (role, format, constraints, 1-shot example).
   * `user` is dynamic per call (findings chunk + targeted HTML snippets).
   *
   * When `chunk` is provided the user prompt covers exactly those findings and
   * their HTML excerpts, enabling the chunked direct-LLM loop in T2.3+.
   * When omitted the profile falls back to loading all findings and taking the
   * top-priority slice.
   */
  fixPrompt(ctx: IterationPaths, chunk?: ScoredFinding[]): { system: string; user: string };

  /**
   * Returns system + user prompt parts for a reviewer vote LLM call.
   * `system` is static per reviewer role (criteria, output schema, hard constraints).
   * `user` is dynamic per iteration (file list, prior finding IDs for regressionChecklist).
   */
  votePrompt(ctx: IterationPaths, reviewer: Reviewer): { system: string; user: string };


  /**
   * Returns system + user prompt parts for the report LLM call.
   * `system` is static (role, report structure). `user` is dynamic (decision, artifact paths).
   */
  reportPrompt(ctx: RunPaths, decision?: Decision): { system: string; user: string };
  manualBaseline?: () => ManualBaseline;
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
  profile: SwarmProfile;
  input: string;
  maxIterations: number;
  logFile: string;
  started: number;
  harness?: AgentHarness;
  /** Energy + carbon meter for this run. */
  energy?: EnergyMeter;
  /** EU AI Act-aligned audit trail with hash chain. */
  audit?: AuditTrail;
  /** Map iteration → record id of the aggregate step (for parent linkage). */
  lastAggregateRecordId?: string;
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

// T1.4 NOTE: Restricted fixer permissions were implemented but caused the opencode agent
// to silently stall (the agent needs workspace root list/read to orient itself).
// Using allowAll until post-hackathon; re-investigate with opencode SDK permission docs.
const fixerPermissions: PermissionRuleset = [
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
    // Flush energy report (with manual baseline if profile provides one)
    if (run.energy) {
      const baseline = run.profile.manualBaseline?.();
      const energyReport = run.energy.flush(baseline);
      log(run, "energy", "report written", {
        callCount: energyReport.callCount,
        totalTokens: energyReport.totalTokens,
        kWh: energyReport.estimatedEnergyKWh.toFixed(6),
        co2g_FI: energyReport.estimatedCO2gFinland.toFixed(3),
        costUSD: energyReport.estimatedCostUSD.toFixed(4),
        comparison: energyReport.comparison,
      });
      console.log(
        `Energy: ${energyReport.estimatedEnergyKWh.toFixed(4)} kWh, ` +
        `CO2 (Finland grid): ${energyReport.estimatedCO2gFinland.toFixed(2)}g, ` +
        `Cost: $${energyReport.estimatedCostUSD.toFixed(3)}`,
      );
      if (energyReport.comparison) {
        console.log(
          `vs. manual baseline: ${energyReport.comparison.energyReductionPct.toFixed(1)}% less energy, ` +
          `${energyReport.comparison.costReductionPct.toFixed(1)}% less cost, ` +
          `${energyReport.comparison.timeReductionPct.toFixed(1)}% less time`,
        );
      }
    }

    // Flush audit trail and verify chain
    if (run.audit) {
      run.audit.flush();
      const verification = run.audit.verify();
      log(run, "audit", "chain verification", verification);
      if (!verification.valid) {
        console.warn(
          `⚠ Audit chain broken at ${verification.brokenAt}: ${verification.error}`,
        );
      }
    }

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
  const demoMode = process.env.SWARM_DEMO === "1";
  const maxIterations = demoMode
    ? 1
    : Math.max(1, Number(process.env.SWARM_MAX_ITERATIONS || 3));
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

  console.log(`Run: ${shown(rootDir, runDir)}`);
  console.log(`Log: ${shown(rootDir, run.logFile)}`);
  console.log(
    `Model: ${modelName(model)} (variant=${model.variant}), agent=${process.env.SWARM_AGENT || "build"}, maxIterations=${maxIterations}${demoMode ? " [DEMO]" : ""}`,
  );

  log(run, "run", "starting", {
    profile: profile.id,
    input,
    rootDir,
    run: shown(rootDir, runDir),
    maxIterations,
    agent: process.env.SWARM_AGENT || "build",
    model: modelName(model),
    variant: model.variant,
    timeoutMs: Number(process.env.SWARM_AGENT_TIMEOUT_MS || 900000),
    pid: process.pid,
    node: process.version,
  });

  const runId = basename(runDir);
  run.energy = new EnergyMeter({
    runDir,
    runId,
    startedAt: run.started,
  });
  run.audit = new AuditTrail({ runDir, runId });

  log(run, "instrumentation", "initialized", {
    energy: "energy-log.jsonl + energy-report.json",
    audit: "evidence-trail/ with SHA-256 hash chain",
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
async function writeBrief(run: RunState, _harness: AgentHarness) {
  const model = modelForAgent("orchestrator");
  const profilePrompt = run.profile.briefPrompt(run);
  const fileSection = embedFiles(filesToEmbedForBrief(run.runDir), run.runDir);
  const userPrompt = fileSection
    ? `${profilePrompt.user}\n\n=== FILE CONTENTS ===\n${fileSection}`
    : profilePrompt.user;

  const promptFile = join(run.runDir, "prompts", "brief.md");
  const outputFile = join(run.runDir, "brief.md");
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, userPrompt);

  const started = Date.now();
  progress("brief", `direct model=${modelName(model)} prompt=${formatBytes(Buffer.byteLength(userPrompt, "utf8"))}`);
  log(run, "prompt", "direct start", { key: "orchestrator", phase: "brief", model: modelName(model) });

  const result = await callLLM({
    model: modelName(model),
    systemPrompt: profilePrompt.system,
    userPrompt,
    outputSchema: MarkdownResponseSchema,
    maxTokens: 4000,
    temperature: 0,
  });

  writeFileSync(outputFile, result.data.markdown);

  if (run.energy) {
    run.energy.record({
      timestamp: new Date().toISOString(),
      model: modelName(model),
      variant: model.variant,
      agentKey: "orchestrator",
      phase: "brief",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      elapsedMs: result.elapsedMs,
    });
  }

  if (run.audit) {
    run.audit.record({
      runId: basename(run.runDir),
      actionType: "brief",
      agentKey: "orchestrator",
      agentRole: "orchestrator brief phase",
      executor: "llm",
      modelProvider: model.providerID,
      modelId: model.modelID,
      modelVariant: model.variant,
      promptHash: hashText(userPrompt),
      promptPath: promptFile,
      outputPaths: [outputFile],
      outputSummary: `brief.md written (${result.data.markdown.length} chars)`,
      elapsedMs: result.elapsedMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  log(run, "prompt", "direct done", {
    key: "orchestrator", phase: "brief",
    elapsedMs: result.elapsedMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    outputChars: result.data.markdown.length,
  });
  progress("brief", `done ${duration(started)} tokens=${result.usage.inputTokens}+${result.usage.outputTokens}`);
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
  const iterSpan = undefined;
  try {
    await collectFindings(run, harness, iter, iterSpan);

        // Deterministic aggregation — no LLM
        const aggregateStarted = Date.now();
        const previousIterDir =
          iter.iteration > 1
            ? join(run.runDir, "iterations", pad(iter.iteration - 1))
            : undefined;
        const aggregateResult = aggregate({
          iterDir: iter.iterDir,
          runDir: run.runDir,
          reviewers: run.profile.reviewers,
          iteration: iter.iteration,
          previousIterDir,
        });
        const { aggregatePath, solverTaskPath } = writeAggregate(
          {
            iterDir: iter.iterDir,
            runDir: run.runDir,
            reviewers: run.profile.reviewers,
            iteration: iter.iteration,
            previousIterDir,
          },
          aggregateResult,
        );
        log(run, "aggregate", "done (deterministic)", {
          iteration: iter.iteration,
          elapsedMs: Date.now() - aggregateStarted,
          totalFindings: aggregateResult.scoredFindings.length,
          introducedFindings: aggregateResult.introducedFindings.length,
          priorities: aggregateResult.priorities.length,
          warnings: aggregateResult.warnings.length,
        });
        if (aggregateResult.warnings.length > 0) {
          for (const w of aggregateResult.warnings) {
            log(run, "aggregate", "warning", { warning: w });
          }
        }
        progress(
          "aggregate",
          `deterministic ${duration(aggregateStarted)} findings=${aggregateResult.scoredFindings.length} introduced=${aggregateResult.introducedFindings.length}`,
        );

        // Audit trail record
        if (run.audit) {
          const findingsPaths = run.profile.reviewers.map((r) =>
            join(iter.iterDir, "findings", `${r.id}.json`),
          );
          const aggregateRecord = run.audit.record({
            runId: basename(run.runDir),
            iteration: iter.iteration,
            actionType: "aggregate",
            agentKey: "orchestrator",
            agentRole: "deterministic aggregation step",
            executor: "deterministic",
            inputFilesHashes: hashInputFiles(findingsPaths),
            outputPaths: [aggregatePath, solverTaskPath],
            outputSummary: aggregateResult.warnings.length > 0
              ? `${aggregateResult.summary} WARNINGS(${aggregateResult.warnings.length}): ${aggregateResult.warnings.join("; ")}`
              : aggregateResult.summary,
            elapsedMs: Date.now() - aggregateStarted,
          });
          run.lastAggregateRecordId = aggregateRecord.recordId;
        }
    // Snapshot artifact before patching so T2.4 rollback can revert on regression
    const artifactPath = join(run.runDir, run.profile.artifact);
    const snapshotPath = join(iter.iterDir, "transformed-snapshot.html");
    if (existsSync(artifactPath)) {
      copyFileSync(artifactPath, snapshotPath);
    }
    // Chunked direct-LLM fixer (replaces opencode promptAgent call)
    await runChunkedFixer(run, iter, aggregateResult.scoredFindings);
    await runChecks(run, iter);
    await collectVotes(run, harness, iter, iterSpan);
    // T3.2: refine introduced-findings count using reviewer regressionChecklists
    const introduced = refineIntroducedFindings(
      iter.iterDir,
      aggregateResult.introducedFindings,
      run.profile.reviewers,
    );
    // Deterministic decision — no LLM
    const decideStarted = Date.now();
    let decision = decide({
      iterDir: iter.iterDir,
      iteration: iter.iteration,
      maxIterations: run.maxIterations,
      reviewers: run.profile.reviewers,
      introducedFindings: introduced.length,
      introducedFindingsBySeverity: {
        high: introduced.filter((f) => f.severity === "high").length,
        medium: introduced.filter((f) => f.severity === "medium").length,
        low: introduced.filter((f) => f.severity === "low").length,
      },
    });
    // Score-based rollback: revert if this iteration worsened accessibility
    decision = checkRegressionAndMaybeRevert(run, iter, decision, snapshotPath, artifactPath);
    writeDecision(iter.iterDir, decision);
    log(run, "decide", "done (deterministic)", {
      ...decision,
      elapsedMs: Date.now() - decideStarted,
    });
    progress(
      "decide",
      `deterministic ${duration(decideStarted)} outcome=${decision.outcome} accepts=${decision.accepts}/${decision.totalVotes ?? "?"} blocks=${decision.blocks} introduced=${decision.introducedFindings ?? 0}`,
    );

    // Audit
    if (run.audit) {
      const votePaths = run.profile.reviewers.map((r) =>
        join(iter.iterDir, "votes", `${r.id}.json`),
      );
      run.audit.record({
        runId: basename(run.runDir),
        iteration: iter.iteration,
        actionType: "decide",
        agentKey: "orchestrator",
        agentRole: "deterministic decision step",
        executor: "deterministic",
        parentRecordId: run.lastAggregateRecordId,
        inputFilesHashes: hashInputFiles([
          ...votePaths,
          join(iter.iterDir, "checks.json"),
        ]),
        outputPaths: [join(iter.iterDir, "decision.json")],
        outputSummary: `${decision.outcome}: ${decision.reason}`,
        elapsedMs: Date.now() - decideStarted,
      });
    }
    return decision;
  } finally {
    // iterSpan removed (tracing.ts deleted)
  }
}

// ---------- Chunked fixer helpers ----------

function locationsOverlap(a: ScoredFinding, b: ScoredFinding): boolean {
  const la = (a.location ?? "").toLowerCase().trim();
  const lb = (b.location ?? "").toLowerCase().trim();
  if (!la || !lb) return false;
  return la === lb || la.includes(lb) || lb.includes(la);
}

/**
 * Partition `findings` into chunks of at most `maxPerChunk`.
 *
 * Sort order: high severity first, then by score descending.
 * Overlap rule: if two findings share a location substring, pull them into the
 * same chunk so their patches don't step on each other.
 */
export function chunkFindings(
  findings: ScoredFinding[],
  opts: { maxPerChunk: number; prioritizeBy: "severity" },
): ScoredFinding[][] {
  const { maxPerChunk } = opts;
  if (findings.length === 0) return [];

  const SW: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const sorted = [...findings].sort((a, b) => {
    const sev = (SW[b.severity ?? "low"] ?? 0) - (SW[a.severity ?? "low"] ?? 0);
    return sev !== 0 ? sev : b.score - a.score;
  });

  const chunks: ScoredFinding[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const chunk: ScoredFinding[] = [sorted[i]];
    used.add(i);

    // Transitively pull in every finding that overlaps with any finding already
    // in this chunk (union-find via repeated passes until stable).
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < sorted.length; j++) {
        if (used.has(j)) continue;
        if (chunk.some((c) => locationsOverlap(c, sorted[j]))) {
          chunk.push(sorted[j]);
          used.add(j);
          grew = true;
        }
      }
    }

    // Fill remaining slots with the next highest-priority unassigned findings.
    for (let j = 0; j < sorted.length && chunk.length < maxPerChunk; j++) {
      if (!used.has(j)) {
        chunk.push(sorted[j]);
        used.add(j);
      }
    }

    chunks.push(chunk);
  }

  return chunks;
}

function buildRetryUserPrompt(
  originalUser: string,
  previousResult: FixPatchResult,
  error: Extract<ReturnType<typeof applyPatches>, { ok: false }>,
): string {
  const failedSearch = error.failedBlock?.search.slice(0, 200) ?? "(unknown)";
  const hint =
    error.error === "no_match"
      ? "The search text was not found in the document. The `search` value must be a verbatim substring of the current HTML — check exact whitespace and attribute quoting."
      : "The search text appears more than once. Extend the `search` value by 1–3 surrounding context lines to make it unique.";

  const patchList = previousResult.patches
    .map((p: FixPatchResult["patches"][number]) => `  - ${p.findingId}: "${p.search.slice(0, 80).replace(/\n/g, "↵")}"`)
    .join("\n");

  return `${originalUser}

---
RETRY — patch application failed.

Error: ${error.error}
${hint}

Failed search string (first 200 chars):
\`\`\`
${failedSearch}
\`\`\`

Your previous patch list:
${patchList}

Respond with a corrected JSON object. You may reuse patches that would have succeeded; only revise the one(s) that caused the error.`;
}

/**
 * Post-vote refinement of the "introduced findings" list (T3.2).
 *
 * After reviewers submit votes, their regressionChecklist fields identify
 * prior-iteration findings that are `still_present`. Any current finding
 * sharing the same ID as a `still_present` entry was NOT newly introduced —
 * it persisted from the previous iteration. Filtering those out reduces
 * false-positive regression counts that would otherwise trigger R3.
 */
function refineIntroducedFindings(
  iterDir: string,
  candidateIntroduced: ScoredFinding[],
  reviewers: Array<{ id: string; name: string }>,
): ScoredFinding[] {
  const stillPresentIds = new Set<string>();
  for (const reviewer of reviewers) {
    const voteFile = join(iterDir, "votes", `${reviewer.id}.json`);
    if (!existsSync(voteFile)) continue;
    try {
      const vote = JSON.parse(readFileSync(voteFile, "utf8")) as {
        regressionChecklist?: Array<{ id?: unknown; status?: unknown }>;
      };
      for (const entry of vote.regressionChecklist ?? []) {
        if (typeof entry.id === "string" && entry.status === "still_present") {
          stillPresentIds.add(entry.id);
        }
      }
    } catch { /* malformed vote file — skip silently */ }
  }
  if (stillPresentIds.size === 0) return candidateIntroduced;
  return candidateIntroduced.filter((f) => !(f.id && stillPresentIds.has(f.id)));
}

function readHtmlForFix(runDir: string, targetPath: string): string {
  for (const p of [targetPath, join(runDir, "original.html")]) {
    if (existsSync(p)) { try { return readFileSync(p, "utf8"); } catch { /* ignore */ } }
  }
  return "";
}

function recordFixerEnergy(
  run: RunState,
  fixer: { providerID: string; modelID: string; variant: string },
  phase: string,
  usage: { inputTokens: number; outputTokens: number },
  elapsedMs: number,
): void {
  if (!run.energy) return;
  run.energy.record({
    timestamp: new Date().toISOString(),
    model: modelName(fixer),
    variant: fixer.variant,
    agentKey: "fixer",
    phase,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    elapsedMs,
  });
}

/**
 * Placeholder regression score — higher means more accessibility issues.
 * Sums axe impact weights (critical=4, serious=3, moderate=2, minor=1) ×
 * node count, plus 1 per structural failure. T4.2 replaces this with a
 * full weighted rubric.
 */
function regressionScore(checksPath: string): number {
  if (!existsSync(checksPath)) return 0;
  const IMPACT_WEIGHT: Record<string, number> = {
    critical: 4,
    serious: 3,
    moderate: 2,
    minor: 1,
  };
  try {
    const checks = JSON.parse(readFileSync(checksPath, "utf8")) as CheckResult & {
      axeViolations?: Array<{ impact?: string; nodes?: unknown[] }>;
    };
    let score = (checks.failures ?? []).filter((f) => !f.startsWith("axe ")).length;
    for (const v of checks.axeViolations ?? []) {
      const nodeCount = Array.isArray(v.nodes) ? v.nodes.length : 1;
      score += (IMPACT_WEIGHT[v.impact ?? ""] ?? 1) * nodeCount;
    }
    return score;
  } catch {
    return 0;
  }
}

/**
 * After checks and votes, compare regression scores to the previous iteration.
 * If the current score is worse (delta < 0), revert the artifact to its
 * pre-fixer snapshot and override the decision to `stop_with_risks`.
 * Iteration 1 is always a pass (no prior data to compare against).
 */
function checkRegressionAndMaybeRevert(
  run: RunState,
  iter: IterationPaths,
  decision: Decision,
  snapshotPath: string,
  artifactPath: string,
): Decision {
  if (iter.iteration <= 1) return decision;

  const prevChecksPath = join(
    run.runDir,
    "iterations",
    pad(iter.iteration - 1),
    "checks.json",
  );
  const currChecksPath = join(iter.iterDir, "checks.json");

  const priorScore = regressionScore(prevChecksPath);
  const currentScore = regressionScore(currChecksPath);
  const improvementDelta = priorScore - currentScore; // positive = improved

  log(run, "decide", "regression check", {
    iteration: iter.iteration,
    priorScore,
    currentScore,
    improvementDelta,
  });

  if (improvementDelta < 0) {
    if (existsSync(snapshotPath)) {
      copyFileSync(snapshotPath, artifactPath);
    }
    log(run, "decide", "regression detected — reverted to pre-fixer snapshot", {
      iteration: iter.iteration,
      delta: improvementDelta,
    });
    progress(
      "decide",
      `regression delta=${improvementDelta} (prior=${priorScore} current=${currentScore}) — reverted artifact, outcome=stop_with_risks`,
    );
    return {
      ...decision,
      outcome: "stop_with_risks",
      checksPass: false,
      reason: `Regression: score worsened by ${Math.abs(improvementDelta)} points (prior=${priorScore}, current=${currentScore}). Reverted to pre-fix snapshot.`,
    };
  }

  return decision;
}

async function runChunkedFixer(
  run: RunState,
  iter: IterationPaths,
  scoredFindings: ScoredFinding[],
): Promise<void> {
  const fixerStart = Date.now();
  const targetPath = join(run.runDir, run.profile.artifact);
  const fixer = modelForAgent("fixer");
  const fixerModelStr = modelName(fixer);

  const chunks = chunkFindings(scoredFindings, { maxPerChunk: 5, prioritizeBy: "severity" });

  log(run, "fix", "start", {
    iteration: iter.iteration,
    findings: scoredFindings.length,
    chunks: chunks.length,
    model: fixerModelStr,
  });
  progress("fix", `start iter=${iter.iteration} findings=${scoredFindings.length} chunks=${chunks.length}`);

  let currentHtml = readHtmlForFix(run.runDir, targetPath);
  const allFixes: string[] = [];
  const allUnfixed: string[] = [];
  let lastSummary = "";

  if (chunks.length > 0) {
    // System prompt is the same for every chunk — derive once.
    const systemPrompt = run.profile.fixPrompt(iter).system;

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const chunkStart = Date.now();
      const chunkLabel = `fix-chunk-${ci + 1}`;

      progress("fix", `chunk ${ci + 1}/${chunks.length} findings=${chunk.map((f) => f.id ?? "?").join(",")}`);

      const userPrompt = run.profile.fixPrompt(iter, chunk).user;

      // ── First attempt ──────────────────────────────────────────────────────
      let firstResult: Awaited<ReturnType<typeof callLLM<typeof FIX_PATCH_SCHEMA>>>;
      try {
        firstResult = await callLLM({
          model: fixerModelStr,
          systemPrompt,
          userPrompt,
          outputSchema: FIX_PATCH_SCHEMA,
          maxTokens: 8000,
          temperature: 0,
          jsonMode: true,
        });
      } catch (err) {
        log(run, "fix", "chunk LLM error", { chunk: ci + 1, error: describe(err) });
        for (const f of chunk) allUnfixed.push(`${f.id ?? "?"}: LLM call failed`);
        continue;
      }
      recordFixerEnergy(run, fixer, chunkLabel, firstResult.usage, firstResult.elapsedMs);

      let patches: PatchBlock[] = firstResult.data.patches.map((p: FixPatchResult["patches"][number]) => ({
        search: p.search,
        replace: p.replace,
      }));
      let patchResult = applyPatches(currentHtml, patches);

      // ── Retry once on patch failure ────────────────────────────────────────
      if (!patchResult.ok) {
        const retryUser = buildRetryUserPrompt(userPrompt, firstResult.data, patchResult);
        let retryResult: Awaited<ReturnType<typeof callLLM<typeof FIX_PATCH_SCHEMA>>>;
        try {
          retryResult = await callLLM({
            model: fixerModelStr,
            systemPrompt,
            userPrompt: retryUser,
            outputSchema: FIX_PATCH_SCHEMA,
            maxTokens: 8000,
            temperature: 0,
            jsonMode: true,
          });
        } catch (err) {
          log(run, "fix", "chunk retry LLM error", { chunk: ci + 1, error: describe(err) });
          for (const f of chunk) allUnfixed.push(`${f.id ?? "?"}: retry LLM call failed`);
          continue;
        }
        recordFixerEnergy(run, fixer, `${chunkLabel}-retry`, retryResult.usage, retryResult.elapsedMs);

        patches = retryResult.data.patches.map((p: FixPatchResult["patches"][number]) => ({ search: p.search, replace: p.replace }));
        patchResult = applyPatches(currentHtml, patches);

        if (!patchResult.ok) {
          log(run, "fix", "chunk skipped after retry", {
            chunk: ci + 1,
            error: patchResult.error,
            failedSearch: patchResult.failedBlock?.search.slice(0, 80),
            elapsedMs: Date.now() - chunkStart,
          });
          for (const f of chunk) allUnfixed.push(`${f.id ?? "?"}: patch ${patchResult.error} after retry`);
          lastSummary = retryResult.data.summary;
          if (retryResult.data.unfixed) allUnfixed.push(...retryResult.data.unfixed);
          continue;
        }

        lastSummary = retryResult.data.summary;
        for (const p of retryResult.data.patches) allFixes.push(`${p.findingId}: ${p.rationale}`);
        if (retryResult.data.unfixed) allUnfixed.push(...retryResult.data.unfixed);
      } else {
        lastSummary = firstResult.data.summary;
        for (const p of firstResult.data.patches) allFixes.push(`${p.findingId}: ${p.rationale}`);
        if (firstResult.data.unfixed) allUnfixed.push(...firstResult.data.unfixed);
      }

      if (patchResult.ok) {
        currentHtml = patchResult.updatedHtml;
        log(run, "fix", "chunk applied", {
          chunk: ci + 1,
          applied: patchResult.appliedCount,
          elapsedMs: Date.now() - chunkStart,
        });
      }
    }
  }

  writeFileSync(targetPath, currentHtml);

  const solverResult = {
    changed: allFixes.length > 0,
    summary:
      lastSummary ||
      `${chunks.length} chunk(s) processed, ${allFixes.length} patch(es) applied.`,
    accessibilityFixes: allFixes,
    preservationNotes: [] as string[],
    removedContent: [] as string[],
    residualRisks: allUnfixed,
  };
  writeFileSync(
    join(iter.iterDir, "solver-result.json"),
    JSON.stringify(solverResult, null, 2),
  );

  const elapsedMs = Date.now() - fixerStart;
  log(run, "fix", "done", {
    iteration: iter.iteration,
    chunks: chunks.length,
    applied: allFixes.length,
    unfixed: allUnfixed.length,
    elapsedMs,
  });
  progress(
    "fix",
    `done ${duration(fixerStart)} chunks=${chunks.length} applied=${allFixes.length} unfixed=${allUnfixed.length}`,
  );

  if (run.audit) {
    run.audit.record({
      runId: basename(run.runDir),
      iteration: iter.iteration,
      actionType: "fix",
      agentKey: "fixer",
      agentRole: "chunked direct-LLM fixer",
      executor: "llm",
      modelProvider: fixer.providerID,
      modelId: fixer.modelID,
      outputPaths: [targetPath, join(iter.iterDir, "solver-result.json")],
      outputSummary: solverResult.summary,
      elapsedMs,
      parentRecordId: run.lastAggregateRecordId,
    });
  }
}

// ---------- Structured output schemas for direct LLM reviewer calls ----------

const FindingsResponseSchema = z.object({
  role: z.string(),
  // Accept either pipe-delimited strings or structured objects; normalize to strings
  // so aggregate.ts (which parses "key=value | key=value" format) works unchanged.
  findings: z
    .array(z.any())
    .transform((items: unknown[]) =>
      items.map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null)
          return Object.entries(item as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v ?? "")}`)
            .join(" | ");
        return String(item);
      }),
    ),
  risk: z.enum(["low", "medium", "high"]),
});

const VoteResponseSchema = z.object({
  vote: z.enum(["accept", "revise", "block"]),
  score: z.number().min(0).max(100),
  reason: z.string(),
  regressionChecklist: z
    .array(z.object({ id: z.string(), status: z.enum(["fixed", "still_present", "unchanged"]) }))
    .optional(),
});

const MarkdownResponseSchema = z.object({
  markdown: z.string(),
});

// ---------- File-embedding helpers for brief and report ----------

function filesToEmbedForBrief(runDir: string): string[] {
  return [
    join(runDir, "facts.json"),
    join(runDir, "axe.json"),
    // original.html intentionally omitted — too large; facts + axe are sufficient
  ];
}

function filesToEmbedForReport(runDir: string): string[] {
  const latest = latestIteration(runDir); // hoisted function declaration
  const files: string[] = [join(runDir, "brief.md")];
  if (latest) {
    const latestDir = join(runDir, "iterations", latest);
    files.push(
      join(latestDir, "decision.json"),
      join(latestDir, "checks.json"),
      join(latestDir, "solver-result.json"),
      join(latestDir, "aggregate-feedback.json"),
    );
  }
  return files;
}

function generateReportHtml(markdown: string, runDir: string, artifact: string): string {
  const hasArtifact = existsSync(join(runDir, artifact));
  const escaped = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility Remediation Report</title>
<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}
nav{margin-bottom:1.5rem;padding-bottom:.75rem;border-bottom:1px solid #ddd}
nav a{margin-right:1rem;color:#0066cc}
pre{white-space:pre-wrap;word-wrap:break-word;background:#f6f8fa;padding:1.25rem;border-radius:6px;font-size:.9rem}
</style>
</head>
<body>
<nav>
${hasArtifact ? `<a href="${artifact}">View transformed page</a>` : ""}
<a href="report.md">report.md</a>
<a href="brief.md">brief.md</a>
</nav>
<pre>${escaped}</pre>
</body>
</html>`;
}

// ---------- File-embedding helpers ----------

const FILE_EMBED_LIMITS: Record<string, number> = {
  ".html": 30_000,
  ".json": 20_000,
  ".md": 15_000,
};

function embedFiles(paths: string[], runDir: string): string {
  return paths
    .filter((p) => existsSync(p))
    .map((p) => {
      try {
        const limit = FILE_EMBED_LIMITS[extname(p)] ?? 10_000;
        const raw = readFileSync(p, "utf8");
        const content =
          raw.length > limit
            ? raw.slice(0, limit) + `\n...[truncated, ${raw.length - limit}B omitted]`
            : raw;
        return `\n\n=== ${relative(runDir, p)} ===\n${content}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("");
}

function filesToEmbedForFindings(runDir: string, iteration: number): string[] {
  if (iteration === 1) {
    return [
      join(runDir, "brief.md"),
      join(runDir, "facts.json"),
      join(runDir, "axe.json"),
    ];
  }
  const prevDir = join(runDir, "iterations", pad(iteration - 1));
  return [
    join(runDir, "brief.md"),
    join(runDir, "transformed.html"),
    join(prevDir, "checks.json"),
    join(prevDir, "aggregate-feedback.json"),
  ];
}

function filesToEmbedForVote(runDir: string, iterDir: string): string[] {
  return [
    join(runDir, "transformed.html"),
    join(iterDir, "checks.json"),
    join(iterDir, "aggregate-feedback.json"),
    join(iterDir, "solver-task.md"),
    join(iterDir, "solver-result.json"),
  ];
}

// ---------- Direct LLM reviewer phase ----------

/** Runs a single reviewer for one phase (findings or vote) via direct LLM call. */
async function directLLMPhase(
  run: RunState,
  reviewer: Reviewer,
  phase: "findings" | "vote",
  iter: IterationPaths,
): Promise<void> {
  const model = modelForAgent(reviewer.id);
  const isFindings = phase === "findings";

  const outputFile = isFindings
    ? join(iter.iterDir, "findings", `${reviewer.id}.json`)
    : join(iter.iterDir, "votes", `${reviewer.id}.json`);
  const promptFile = join(iter.iterDir, "prompts", `${reviewer.id}-${phase}.md`);

  // T3.1: profile now returns { system, user } — system is static/cacheable per role
  const profilePrompt = isFindings
    ? run.profile.findingsPrompt(iter, reviewer)
    : run.profile.votePrompt(iter, reviewer);

  const filePaths = isFindings
    ? filesToEmbedForFindings(run.runDir, iter.iteration)
    : filesToEmbedForVote(run.runDir, iter.iterDir);
  const fileSection = embedFiles(filePaths, run.runDir);

  const schemaReminder = isFindings
    ? `\n\n## REMINDER: respond with ONLY the JSON object. role="${reviewer.id}", findings=array of pipe-delimited strings, risk=low|medium|high.`
    : `\n\n## REMINDER: respond with ONLY the JSON object. vote=accept|revise|block, score=0-100, reason=string.`;

  const userPrompt = `${profilePrompt.user}${fileSection ? `\n\n<files>\n${fileSection}</files>` : ""}${schemaReminder}`;

  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, userPrompt);

  const phaseStarted = Date.now();
  progress(
    phase,
    `${reviewer.id} direct model=${modelName(model)} prompt=${formatBytes(Buffer.byteLength(userPrompt, "utf8"))}`,
  );
  log(run, "prompt", "direct start", {
    key: reviewer.id,
    phase,
    model: modelName(model),
    promptBytes: Buffer.byteLength(userPrompt, "utf8"),
    output: shown(run.rootDir, outputFile),
  });

  const schema = isFindings ? FindingsResponseSchema : VoteResponseSchema;
  const result = await callLLM({
    model: modelName(model),
    systemPrompt: profilePrompt.system,
    userPrompt,
    outputSchema: schema,
    maxTokens: 2000,
    temperature: 0,
    jsonMode: true,
  });

  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(result.data, null, 2));

  if (run.energy) {
    run.energy.record({
      timestamp: new Date().toISOString(),
      model: modelName(model),
      variant: model.variant,
      agentKey: reviewer.id,
      phase,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      elapsedMs: result.elapsedMs,
    });
  }

  if (run.audit) {
    run.audit.record({
      runId: basename(run.runDir),
      iteration: iter.iteration,
      actionType: isFindings ? "findings" : "vote",
      agentKey: reviewer.id,
      agentRole: `${reviewer.name} in phase ${phase}`,
      executor: "llm",
      modelProvider: model.providerID,
      modelId: model.modelID,
      modelVariant: model.variant,
      promptHash: hashText(userPrompt),
      promptPath: promptFile,
      outputPaths: [outputFile],
      outputSummary: `${phase} completed via direct LLM call`,
      elapsedMs: result.elapsedMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  log(run, "prompt", "direct done", {
    key: reviewer.id,
    phase,
    elapsedMs: result.elapsedMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    output: fileState(run.rootDir, outputFile),
  });
  progress(
    phase,
    `${reviewer.id} done ${duration(phaseStarted)} tokens=${result.usage.inputTokens}+${result.usage.outputTokens}`,
  );
}

/**
 * Collects reviewer findings for the current artifact state.
 *
 * Reviewers run in parallel via direct LLM calls (no opencode session overhead).
 */
async function collectFindings(
  run: RunState,
  _harness: AgentHarness,
  iter: IterationPaths,
  _iterSpan?: unknown,
) {
  await Promise.all(
    run.profile.reviewers.map((reviewer) =>
      directLLMPhase(run, reviewer, "findings", iter),
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
 * Votes run in parallel via direct LLM calls (no opencode session overhead).
 */
async function collectVotes(
  run: RunState,
  _harness: AgentHarness,
  iter: IterationPaths,
  _iterSpan?: unknown,
) {
  await Promise.all(
    run.profile.reviewers.map((reviewer) =>
      directLLMPhase(run, reviewer, "vote", iter),
    ),
  );
}


/**
 * Writes the human-facing report after the loop has a final decision.
 *
 * This stays separate from serving so report generation remains an agent file
 * contract, while preview serving remains a local runtime concern.
 */
async function writeFinalReport(
  run: RunState,
  _harness: AgentHarness,
  decision?: Decision,
) {
  const model = modelForAgent("orchestrator");
  const profilePrompt = run.profile.reportPrompt(run, decision);
  const fileSection = embedFiles(filesToEmbedForReport(run.runDir), run.runDir);
  const userPrompt = fileSection
    ? `${profilePrompt.user}\n\n=== FILE CONTENTS ===\n${fileSection}`
    : profilePrompt.user;

  const promptFile = join(run.runDir, "prompts", "report.md");
  const mdFile = join(run.runDir, "report.md");
  const htmlFile = join(run.runDir, "report.html");
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, userPrompt);

  const started = Date.now();
  progress("report", `direct model=${modelName(model)} prompt=${formatBytes(Buffer.byteLength(userPrompt, "utf8"))}`);
  log(run, "prompt", "direct start", { key: "orchestrator", phase: "report", model: modelName(model) });

  const result = await callLLM({
    model: modelName(model),
    systemPrompt: profilePrompt.system,
    userPrompt,
    outputSchema: MarkdownResponseSchema,
    maxTokens: 4000,
    temperature: 0,
  });

  writeFileSync(mdFile, result.data.markdown);
  writeFileSync(htmlFile, generateReportHtml(result.data.markdown, run.runDir, run.profile.artifact));

  if (run.energy) {
    run.energy.record({
      timestamp: new Date().toISOString(),
      model: modelName(model),
      variant: model.variant,
      agentKey: "orchestrator",
      phase: "report",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      elapsedMs: result.elapsedMs,
    });
  }

  if (run.audit) {
    run.audit.record({
      runId: basename(run.runDir),
      actionType: "report",
      agentKey: "orchestrator",
      agentRole: "orchestrator report phase",
      executor: "llm",
      modelProvider: model.providerID,
      modelId: model.modelID,
      modelVariant: model.variant,
      promptHash: hashText(userPrompt),
      promptPath: promptFile,
      outputPaths: [mdFile, htmlFile],
      outputSummary: `report.md + report.html written`,
      elapsedMs: result.elapsedMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  log(run, "prompt", "direct done", {
    key: "orchestrator", phase: "report",
    elapsedMs: result.elapsedMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    outputChars: result.data.markdown.length,
  });
  progress("report", `done ${duration(started)} tokens=${result.usage.inputTokens}+${result.usage.outputTokens}`);
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
  const model = modelForAgent(key);
  const agent = process.env.SWARM_AGENT || "build";
  const title = `swarm ${key} ${relative(run.rootDir, run.runDir)}`;
  const sessionStarted = Date.now();
  log(run, "session", "create start", {
    key,
    title,
    agent,
    model: modelName(model),
    variant: model.variant,
    permission: "fixer-restricted",
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
      permission: fixerPermissions,
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
  _parent?: unknown,
) {
  const sessionID = await sessionFor(harness, run, key);
  const model = modelForAgent(key);
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

  // Energy meter recording
  if (run.energy) {
    const { input: inputTokens, output: outputTokens } = extractTokens(result.data);
    const call: LLMCall = {
      timestamp: new Date().toISOString(),
      model: modelName(model),
      variant: model.variant,
      agentKey: key,
      phase,
      inputTokens,
      outputTokens,
      elapsedMs: Date.now() - promptStarted,
    };
    run.energy.record(call);
  }

  // Audit trail recording
  if (run.audit) {
    run.audit.record({
      runId: basename(run.runDir),
      iteration: extractIterationFromPath(promptFile),
      actionType: phaseToActionType(phase),
      agentKey: key,
      agentRole: `${key} agent in phase ${phase}`,
      executor: "llm",
      modelProvider: model.providerID,
      modelId: model.modelID,
      modelVariant: model.variant,
      promptHash: hashText(text),
      promptPath: promptFile,
      outputPaths: outputs,
      outputSummary: `phase ${phase} produced ${outputs.length} file(s)`,
      elapsedMs: Date.now() - promptStarted,
      inputTokens: extractTokens(result.data).input || undefined,
      outputTokens: extractTokens(result.data).output || undefined,
    });
  }
}

function extractIterationFromPath(p: string): number | undefined {
  const match = p.match(/iterations[/\\](\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

function phaseToActionType(phase: string): ActionType {
  const map: Record<string, ActionType> = {
    brief: "brief",
    findings: "findings",
    aggregate: "aggregate",
    fix: "fix",
    vote: "vote",
    decision: "decide",
    report: "report",
    narrative: "narrative",
  };
  return map[phase] || "brief";
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
// waitForOutputs is called exclusively from promptAgent, which is only invoked
// for the fixer step. All other phases (findings, vote, brief, report) use
// directLLMPhase / writeBrief / writeFinalReport which write files synchronously.
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
 * Parsed representation of a model selection passed to the opencode SDK.
 */
type ModelSpec = { providerID: string; modelID: string; variant: string };

/**
 * Parses the `SWARM_MODEL` environment variable into its constituent parts.
 * Expected format: `<providerID>/<modelID>` (e.g. `"deepseek/deepseek-v4-flash"`).
 *
 * @returns Object with `providerID`, `modelID`, and `variant`.
 */
function modelSpec(): ModelSpec {
  const [providerID, ...rest] = (
    process.env.SWARM_MODEL || "deepseek/deepseek-v4-flash"
  ).split("/");
  return {
    providerID,
    modelID: rest.join("/"),
    variant: process.env.SWARM_VARIANT || "max",
  };
}

/**
 * Returns the model spec for the given logical agent key.
 *
 * The fixer agent defaults to a more capable model (`deepseek/deepseek-v4-pro`,
 * variant `max`) because it performs multi-file edits that benefit from higher
 * reasoning capacity. Override via `SWARM_FIXER_MODEL` / `SWARM_FIXER_VARIANT`.
 * All other agents use the global `SWARM_MODEL` / `SWARM_VARIANT` spec.
 *
 * @param key - Logical agent key (e.g. `"fixer"`, `"orchestrator"`, reviewer ID).
 */
function modelForAgent(key: string): ModelSpec {
  if (key === "fixer") {
    const raw =
      process.env.SWARM_FIXER_MODEL || "deepseek/deepseek-v4-pro";
    const [providerID, ...rest] = raw.split("/");
    return {
      providerID,
      modelID: rest.join("/"),
      variant: process.env.SWARM_FIXER_VARIANT || "max",
    };
  }
  return modelSpec();
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
