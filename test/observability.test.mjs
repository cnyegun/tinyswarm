import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These tests lock in the runSwarm observability surface — events, progress
// callbacks, line callbacks, and swarm.log content — so refactors that touch
// the log+emit+progress triplet cannot silently change what consumers see.
//
// Three categories of assertion:
//   1. Event ordering & shape — what the JSON event stream looks like.
//   2. Progress callbacks — what the TUI consumes.
//   3. Log file content — what swarm.log records on disk.

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "core-runner.mjs");
const repoRoot = join(here, "..");

test("captures the full accept-first event stream with stable shapes", async () => {
  const result = await runScenario("accept-first");
  assert.equal(result.error, undefined);

  // The event-type/phase/status sequence is the contract the TUI watches.
  // We split it into a sequential prefix (single-agent phases — strict order)
  // and a parallel vote block (reviewers race; only per-reviewer ordering is
  // guaranteed). Pinning cross-reviewer interleaving makes the test brittle
  // against any extra await inside promptAgent (e.g. token-usage fetch).
  const sequence = result.capturedEvents
    .filter((event) => event.type !== "progress")
    .map(eventDiscriminator);

  // Locate the boundaries of the parallel vote block.
  const voteStart = sequence.indexOf("check:1:passed") + 1;
  const decisionStart = sequence.indexOf("prompt:decision:orchestrator:start");
  assert.ok(voteStart > 0 && decisionStart > voteStart);

  // Sequential prefix: everything up through check:1:passed is strictly ordered.
  assert.deepEqual(sequence.slice(0, voteStart), [
    "run_start",
    "phase:scan:start",
    "phase:scan:completed",
    "prompt:brief:orchestrator:start",
    "prompt:brief:orchestrator:accepted",
    "prompt:brief:orchestrator:done",
    "iteration:1:active",
    "prompt:fix:fixer:start",
    "prompt:fix:fixer:accepted",
    "prompt:fix:fixer:done",
    "check:1:start",
    "check:1:passed",
  ]);

  // Sequential suffix: decision, iteration close, report, serve, run_complete.
  assert.deepEqual(sequence.slice(decisionStart), [
    "prompt:decision:orchestrator:start",
    "prompt:decision:orchestrator:accepted",
    "prompt:decision:orchestrator:done",
    "decision:1:accept",
    "iteration:1:completed",
    "prompt:report:local:start",
    "prompt:report:local:done",
    "serve",
    "run_complete",
  ]);

  // Parallel block: same set of events regardless of interleaving, and each
  // reviewer's own events appear in start → accepted → done → reviewer order.
  const voteBlock = sequence.slice(voteStart, decisionStart);
  const expectedPerReviewer = (id) => [
    `prompt:vote:${id}:start`,
    `prompt:vote:${id}:accepted`,
    `prompt:vote:${id}:done`,
    `reviewer:${id}:accept`,
  ];
  for (const id of ["alpha", "beta", "gamma"]) {
    const own = voteBlock.filter((entry) => entry.includes(`:${id}:`));
    assert.deepEqual(own, expectedPerReviewer(id), `out-of-order events for ${id}`);
  }
  assert.equal(
    voteBlock.length,
    12,
    `parallel block should be 3 reviewers × 4 events: got ${voteBlock.length}`,
  );
});

test("run_start event carries the run metadata consumers need", async () => {
  const result = await runScenario("accept-first");
  const runStart = result.capturedEvents.find((event) => event.type === "run_start");
  assert.ok(runStart, "run_start event missing");

  // These fields are the public contract for any frontend (TUI, web UI, JSON
  // consumers). Drop or rename any of them and dashboards break.
  for (const field of [
    "profile",
    "input",
    "rootDir",
    "runDir",
    "runDirAbsolute",
    "logFile",
    "logFileAbsolute",
    "artifact",
    "reviewers",
    "maxIterations",
    "agent",
    "model",
    "variant",
    "timestamp",
    "elapsedMs",
  ]) {
    assert.ok(field in runStart, `run_start missing ${field}`);
  }
  assert.equal(runStart.profile, "fake-accept-first");
  assert.equal(runStart.artifact, "artifact.html");
  assert.equal(runStart.maxIterations, 3);
  assert.equal(Array.isArray(runStart.reviewers), true);
});

test("prompt events carry short sessionID, phase, agent, and status", async () => {
  const result = await runScenario("accept-first");
  const prompts = result.capturedEvents.filter((event) => event.type === "prompt");
  assert.ok(prompts.length > 0);

  for (const event of prompts) {
    assert.equal(typeof event.phase, "string");
    assert.equal(typeof event.agent, "string");
    assert.ok(["start", "accepted", "done", "failed"].includes(event.status));
    // sessionID is shortened for the event stream; the full ID stays in
    // swarm.log only. "local" agents (e.g. the report writer) skip sessions.
    if (event.agent !== "local") {
      assert.equal(typeof event.sessionID, "string");
      assert.ok(event.sessionID.length <= 16);
    }
  }
});

test("reviewer events summarize each vote with vote+score+summary", async () => {
  const result = await runScenario("accept-first");
  const reviewers = result.capturedEvents.filter((event) => event.type === "reviewer");
  assert.equal(reviewers.length, 3);
  for (const event of reviewers) {
    assert.equal(event.phase, "vote");
    assert.equal(event.status, "done");
    assert.ok(["accept", "revise", "block", "unknown"].includes(event.vote));
    assert.equal(typeof event.score, "number");
    assert.equal(typeof event.summary, "string");
    assert.ok(["alpha", "beta", "gamma"].includes(event.id));
  }
});

test("decision event carries the full Decision shape", async () => {
  const result = await runScenario("accept-first");
  const decision = result.capturedEvents.find((event) => event.type === "decision");
  assert.ok(decision);
  assert.equal(decision.iteration, 1);
  assert.equal(decision.outcome, "accept");
  assert.equal(decision.checksPass, true);
  assert.equal(typeof decision.accepts, "number");
  assert.equal(typeof decision.blocks, "number");
  assert.equal(typeof decision.reason, "string");
});

test("run_complete event carries final paths and the served URL", async () => {
  const result = await runScenario("accept-first");
  const complete = result.capturedEvents.find((event) => event.type === "run_complete");
  assert.ok(complete);
  assert.equal(complete.decision.outcome, "accept");
  assert.equal(typeof complete.runDir, "string");
  assert.equal(typeof complete.artifact, "string");
  assert.equal(typeof complete.report, "string");
  assert.equal(typeof complete.logFile, "string");
  assert.match(complete.localUrl, /^http:\/\/localhost:\d+$/);
});

test("every prompt:done event carries usage with cost+token fields", async () => {
  const result = await runScenario("accept-first");
  // The mock returns a constant cost=0.001 and tokens={in:100, out:50, ...}
  // per prompt so we can assert deterministic shape AND non-zero values.
  // accept-first issues 6 prompts: brief, fix, vote×3, decision.
  const done = result.capturedEvents.filter(
    (event) => event.type === "prompt" && event.status === "done" && event.agent !== "local",
  );
  assert.equal(done.length, 6, `expected 6 prompt:done events, got ${done.length}`);

  for (const event of done) {
    assert.ok(event.usage, `prompt:done for ${event.agent} missing usage`);
    assert.equal(event.usage.cost, 0.001);
    assert.equal(event.usage.tokensIn, 100);
    assert.equal(event.usage.tokensOut, 50);
    assert.equal(event.usage.tokensReasoning, 0);
    assert.equal(event.usage.tokensCacheRead, 0);
    assert.equal(event.usage.tokensCacheWrite, 0);
  }
});

test("run_complete event carries usage totals and per-agent breakdown", async () => {
  const result = await runScenario("accept-first");
  const complete = result.capturedEvents.find((event) => event.type === "run_complete");
  assert.ok(complete);
  assert.ok(complete.usage, "run_complete missing usage roll-up");

  // 6 prompts × 0.001 cost = 0.006; 6 × 100 in = 600; 6 × 50 out = 300.
  // Floating-point cost sums to a number close to 0.006 — use approximate
  // equality so we don't bind the test to a specific rounding artifact.
  assert.ok(
    Math.abs(complete.usage.total.cost - 0.006) < 1e-9,
    `total cost: ${complete.usage.total.cost}`,
  );
  assert.equal(complete.usage.total.tokensIn, 600);
  assert.equal(complete.usage.total.tokensOut, 300);

  // Per-agent: orchestrator runs brief + decision (2 prompts); fixer runs
  // fix (1); each reviewer runs one vote (1 each). Totals must match.
  const orchestrator = complete.usage.byAgent.orchestrator;
  assert.equal(orchestrator.tokensIn, 200, "orchestrator handled brief+decision");
  assert.equal(orchestrator.tokensOut, 100);

  assert.equal(complete.usage.byAgent.fixer.tokensIn, 100);
  assert.equal(complete.usage.byAgent.alpha.tokensIn, 100);
  assert.equal(complete.usage.byAgent.beta.tokensIn, 100);
  assert.equal(complete.usage.byAgent.gamma.tokensIn, 100);
});

test("usage summary line appears in the CLI summary block", async () => {
  const result = await runScenario("accept-first");
  // One final summary line lists totals so a CLI user sees the cost without
  // parsing JSON. Skipped silently if no usage was collected (e.g. provider
  // omits it, or every prompt's usage fetch failed).
  const summary = result.capturedLines.find((line) => line.startsWith("Tokens:"));
  assert.ok(summary, `missing usage summary line: ${JSON.stringify(result.capturedLines)}`);
  assert.match(summary, /in=600 out=300/);
  assert.match(summary, /cost=\$0\.0060/);
});

test("every event carries timestamp and elapsedMs", async () => {
  const result = await runScenario("accept-first");
  // Every event from reporter.emit must be enriched with timestamp+elapsedMs.
  // This is the only guarantee dashboards can rely on for ordering events
  // across multiple sessions.
  for (const event of result.capturedEvents) {
    assert.equal(typeof event.timestamp, "string");
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof event.elapsedMs, "number");
    assert.ok(event.elapsedMs >= 0);
  }
});

test("progress callbacks cover scan, brief, iteration, fix, check, vote, decision, report", async () => {
  const result = await runScenario("accept-first");
  // The TUI uses progress as the primary "what's happening now" signal. The
  // phase names must remain stable so its phase routing keeps working.
  const phases = new Set(result.capturedProgress.map((p) => p.phase));
  for (const phase of [
    "scan",
    "brief",
    "fix",
    "check",
    "vote",
    "decision",
    "report",
    "iteration 1/3",
  ]) {
    assert.ok(phases.has(phase), `missing progress phase: ${phase}`);
  }

  // Each phase has a recognizable "start" form and a "done <duration> ..." form.
  const scanProgress = result.capturedProgress.filter((p) => p.phase === "scan");
  assert.match(scanProgress[0].message, /^start url=/);
  assert.match(scanProgress.at(-1).message, /^done \d+m?s/);

  const checkProgress = result.capturedProgress.filter((p) => p.phase === "check");
  assert.match(checkProgress[0].message, /^start iteration=1$/);
  assert.match(checkProgress[1].message, /^passed \d+m?s failures=0$/);

  const decisionProgress = result.capturedProgress.filter((p) => p.phase === "decision");
  assert.match(
    decisionProgress.at(-1).message,
    /^outcome=accept checksPass=true accepts=3 blocks=0 reason=/,
  );
});

test("each progress callback is also mirrored as a {type:progress} event", async () => {
  const result = await runScenario("accept-first");
  // progress() in reporter.ts both calls reporter.progress AND emits an event.
  // Web/TUI consumers that only read the event stream still see every progress
  // update. This invariant must survive refactoring.
  const progressEvents = result.capturedEvents.filter((event) => event.type === "progress");
  assert.equal(progressEvents.length, result.capturedProgress.length);
  for (let i = 0; i < progressEvents.length; i++) {
    assert.equal(progressEvents[i].phase, result.capturedProgress[i].phase);
    assert.equal(progressEvents[i].message, result.capturedProgress[i].message);
  }
});

test("line callbacks deliver the CLI summary block at run completion", async () => {
  const result = await runScenario("accept-first");
  // Six summary lines are printed at the start and end of the run; they are
  // the only thing the default CLI shows after the run is over.
  const lines = result.capturedLines;
  assert.ok(lines.some((line) => line.startsWith("Run: ")));
  assert.ok(lines.some((line) => line.startsWith("Log: ")));
  assert.ok(lines.some((line) => line.startsWith("Model: ")));
  assert.ok(lines.some((line) => line.startsWith("Brief: ")));
  assert.ok(lines.some((line) => line.startsWith("Report: ")));
  assert.ok(lines.some((line) => line.startsWith("Transformed: ")));
  assert.ok(lines.some((line) => line.startsWith("Local: ")));
});

test("no-reviewers omits vote and reviewer events but keeps iteration/check/decision", async () => {
  const result = await runScenario("no-reviewers");
  assert.equal(result.error, undefined);
  const types = result.capturedEvents.map((event) => event.type);
  assert.equal(types.includes("reviewer"), false);
  for (const event of result.capturedEvents) {
    if (event.type === "prompt") assert.notEqual(event.phase, "vote");
  }
  // The no-reviewers profile still goes through check and decision, just with
  // accepts=0, blocks=0.
  assert.equal(result.capturedEvents.some((event) => event.type === "check" && event.status === "passed"), true);
  const decision = result.capturedEvents.find((event) => event.type === "decision");
  assert.equal(decision.outcome, "accept");
  assert.equal(decision.accepts, 0);
  assert.equal(decision.blocks, 0);
});

test("scan-failure emits phase scan failed and an error event, then stops", async () => {
  const result = await runScenario("scan-failure");
  assert.match(result.error, /scan exploded/);

  const types = result.capturedEvents.map((event) => event.type);
  // No prompt or iteration activity should be visible if scan fails.
  assert.equal(types.includes("prompt"), false);
  assert.equal(types.includes("iteration"), false);
  assert.equal(types.includes("run_complete"), false);

  const scanStart = result.capturedEvents.find(
    (event) => event.type === "phase" && event.phase === "scan" && event.status === "start",
  );
  const scanFailed = result.capturedEvents.find(
    (event) => event.type === "phase" && event.phase === "scan" && event.status === "failed",
  );
  assert.ok(scanStart);
  assert.ok(scanFailed);
  assert.match(scanFailed.error, /scan exploded/);

  const error = result.capturedEvents.find((event) => event.type === "error");
  assert.ok(error);
  assert.match(error.message, /scan exploded/);
});

test("prompt-timeout reports prompt accepted, then bubbles the timeout as an error event", async () => {
  const result = await runScenario("prompt-timeout");
  assert.match(result.error, /timed out waiting for/);

  const brief = result.capturedEvents.filter(
    (event) => event.type === "prompt" && event.phase === "brief",
  );
  assert.deepEqual(
    brief.map((event) => event.status),
    ["start", "accepted"],
  );

  const error = result.capturedEvents.find((event) => event.type === "error");
  assert.ok(error);
  assert.match(error.message, /timed out waiting for/);

  // Nothing past the brief phase should have run.
  for (const event of result.capturedEvents) {
    if (event.type === "prompt") assert.equal(event.phase, "brief");
    assert.notEqual(event.type, "iteration");
    assert.notEqual(event.type, "decision");
    assert.notEqual(event.type, "run_complete");
  }
});

test("continue-then-accept emits two iteration cycles with the right decisions", async () => {
  const result = await runScenario("continue-then-accept");
  assert.equal(result.error, undefined);

  const iterations = result.capturedEvents.filter((event) => event.type === "iteration");
  // Iteration 1 fails checks, so the orchestrator skips voting and the
  // iteration:completed event is never emitted for it. Iteration 2 passes,
  // votes happen, and the completed:accept event ends the loop. This gap is
  // current behavior; if it changes, dashboards relying on iteration:completed
  // need to learn the new shape too.
  assert.deepEqual(
    iterations.map((event) => `${event.iteration}:${event.status}${event.outcome ? `:${event.outcome}` : ""}`),
    ["1:active", "2:active", "2:completed:accept"],
  );

  const decisions = result.capturedEvents.filter((event) => event.type === "decision");
  assert.deepEqual(
    decisions.map((event) => ({ iteration: event.iteration, outcome: event.outcome })),
    [
      { iteration: 1, outcome: "continue" },
      { iteration: 2, outcome: "accept" },
    ],
  );

  // Failed checks in iteration 1 trigger a "failed" check event with the
  // failures count. The Rust TUI and web UI both rely on this to render the
  // failed status badge.
  const checks = result.capturedEvents.filter((event) => event.type === "check");
  const iter1Failed = checks.find((event) => event.iteration === 1 && event.status === "failed");
  assert.ok(iter1Failed);
  assert.equal(iter1Failed.passed, false);
  assert.equal(iter1Failed.failures, 1);
});

test("swarm.log records start/done/failed lines for each phase", async () => {
  const result = await runScenario("accept-first");
  const log = await readFile(join(result.runDir, "swarm.log"), "utf8");

  // The phase patterns below are stable substrings that frontend tooling
  // (e.g. grep, custom log viewers) relies on. Use exact textual patterns so
  // any reword forces an intentional re-evaluation.
  // Log format is "<ts> +<elapsed>ms <step> <message> <json-data>". The phase
  // lives in the JSON data, not the step+message text. These patterns are the
  // stable substrings that frontend tooling and humans grep for; any rewording
  // forces an intentional re-evaluation.
  for (const pattern of [
    /\brun starting\b/,
    /\bscan starting\b/,
    /\bscan done\b/,
    /\bopencode using existing server\b/,
    /\bopencode model preflight done\b/,
    /\bsession create start\b.*"key":"orchestrator"/,
    /\bsession created\b.*"key":"orchestrator"/,
    /\bsession created\b.*"key":"fixer"/,
    /\bsession created\b.*"key":"alpha"/,
    /\bprompt start\b.*"key":"orchestrator"/,
    /\bprompt accepted\b.*"key":"orchestrator"/,
    /\bprompt done\b.*"key":"orchestrator"/,
    /\bprompt start\b.*"key":"fixer"/,
    /\bcheck start\b/,
    /\bcheck passed\b/,
    /\bprompt start\b.*"key":"alpha"/,
    /\bdecision accept\b/,
    /\breport start\b/,
    /\breport written\b/,
    /\bserve listening\b/,
    /\brun completed\b/,
    /\bopencode leaving external server open\b/,
  ]) {
    assert.match(log, pattern, `swarm.log missing pattern ${pattern}`);
  }
});

test("swarm.log records scan failed lines and never opens sessions", async () => {
  const result = await runScenario("scan-failure");
  const log = await readFile(join(result.runDir, "swarm.log"), "utf8");
  assert.match(log, /\bscan failed\b/);
  assert.doesNotMatch(log, /\bopencode using existing server\b/);
  assert.doesNotMatch(log, /\bsession created\b/);
});

test("swarm.log records the wait timeout with the elapsed time", async () => {
  const result = await runScenario("prompt-timeout");
  const log = await readFile(join(result.runDir, "swarm.log"), "utf8");
  assert.match(log, /\bprompt wait start\b/);
  assert.match(log, /\bprompt wait timeout\b/);
});

function eventDiscriminator(event) {
  switch (event.type) {
    case "prompt":
      return `prompt:${event.phase}:${event.agent}:${event.status}`;
    case "phase":
      return `phase:${event.phase}:${event.status}`;
    case "iteration":
      return `iteration:${event.iteration}:${event.status}`;
    case "check":
      return `check:${event.iteration}:${event.status}`;
    case "decision":
      return `decision:${event.iteration}:${event.outcome}`;
    case "reviewer":
      return `reviewer:${event.id}:${event.vote}`;
    default:
      return event.type;
  }
}

async function runScenario(name) {
  const rootDir = await mkdtemp(join(tmpdir(), `tiny-rewrite-obs-${name}-`));
  const child = spawn(process.execPath, [runner, name, rootDir], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after 20000ms`));
    }, 20000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const marker = stdout
    .split("\n")
    .find((line) => line.startsWith("@@CORE_TEST_RESULT@@"));
  if (!marker) {
    assert.fail(`missing scenario result for ${name}\nexit=${exit.code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(marker.slice("@@CORE_TEST_RESULT@@".length));
}
