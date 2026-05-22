import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "core-runner.mjs");
const repoRoot = join(here, "..");
const rawArtifactSentinels = [
  "RAW_ORIGINAL_SENTINEL_DO_NOT_PROMPT",
  "RAW_AXE_FULL_SENTINEL_DO_NOT_PROMPT",
  "RAW_CHECKS_FULL_SENTINEL_DO_NOT_PROMPT",
];

test("runSwarm completes a one-iteration accepted run and writes the full artifact contract", async () => {
  const result = await runScenario("accept-first");

  assert.equal(result.error, undefined);
  assert.equal(result.sessionCount, 5);
  assert.equal(result.promptCount, 6);
  assert.deepEqual(phases(result), [
    "brief",
    "fix",
    "vote",
    "vote",
    "vote",
    "decision",
  ]);
  assert.deepEqual(result.profileEvents.map((event) => event.type), ["scan", "check"]);
  assert.deepEqual(result.profileEvents.filter((event) => event.type === "check").map((event) => event.iteration), [1]);

  await assertFiles(result.runDir, [
    "swarm.log",
    "sessions.json",
    "original.html",
    "facts.json",
    "axe.json",
    "screenshots/original.png",
    "brief.md",
    "prompts/brief.md",
    "artifact.html",
    "report.md",
    "report.html",
    "iterations/001/prompts/fix.md",
    "iterations/001/solver-result.json",
    "iterations/001/checks.json",
    "iterations/001/prompts/alpha-vote.md",
    "iterations/001/prompts/beta-vote.md",
    "iterations/001/prompts/gamma-vote.md",
    "iterations/001/votes/alpha.json",
    "iterations/001/votes/beta.json",
    "iterations/001/votes/gamma.json",
    "iterations/001/prompts/decision.md",
    "iterations/001/decision.json",
  ]);

  assert.equal((await readJson(result.runDir, "iterations/001/checks.json")).passed, true);
  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).outcome, "accept");
  assert.deepEqual(await readJson(result.runDir, "sessions.json"), {
    orchestrator: "session-1",
    fixer: "session-2",
    alpha: "session-3",
    beta: "session-4",
    gamma: "session-5",
  });

  assert.equal(result.preview["/"].status, 200);
  assert.match(result.preview["/"].body, /Artifact 1/);
  assert.equal(result.preview["/artifact.html"].status, 200);
  assert.match(result.preview["/artifact.html"].body, /Artifact 1/);
  assert.equal(result.preview["/artifact.html?download=1"].status, 200);
  assert.match(result.preview["/artifact.html?download=1"].body, /Artifact 1/);
  assert.equal(result.preview["/report.html"].status, 200);
  assert.match(result.preview["/report.html"].body, /Swarm report/);
  assert.match(result.preview["/report.html"].body, /class="utility-bar"/);
  assert.match(result.preview["/report.html"].body, /id="accessibility-statement"/);
  assert.match(result.preview["/report.html"].body, /--color-primary: #003580/);
  assert.doesNotMatch(result.preview["/report.html"].body, /<pre>/);
  assert.equal(result.preview["/report.html?cache=1"].status, 200);
  assert.equal(result.preview["/report.md"].contentType, "text/markdown; charset=utf-8");
  assert.equal(result.preview["/brief.md"].status, 200);
  assert.equal(JSON.parse(result.preview["/checks.json"].body).iteration, 1);
  assert.equal(JSON.parse(result.preview["/iterations/001/checks.json"].body).iteration, 1);
  assert.equal(result.preview["/iterations/001/"].status, 404);
  assert.equal(result.preview["/missing"].status, 404);
  assert.equal(result.preview["/%2e%2e/package.json"].status, 404);

  const log = await readText(result.runDir, "swarm.log");
  assert.match(log, /run starting/);
  assert.match(log, /scan done/);
  assert.match(log, /opencode using existing server/);
  assert.match(log, /decision accept/);
  assert.match(log, /run completed/);
  assert.match(log, /opencode leaving external server open/);
});

test("runSwarm waits for stale pre-existing outputs to be rewritten", async () => {
  const result = await runScenario("preexisting-brief");

  assert.equal(result.error, undefined);
  assertPhaseOrder(result, ["brief", "fix"]);
  assert.equal(await readText(result.runDir, "brief.md"), "# Brief\n\nScenario preexisting-brief\n");
  assert.match(await readText(result.runDir, "prompts/brief.md"), /PHASE: brief/);
});

test("runSwarm keeps prompt payloads path-only when artifacts are large", async () => {
  const result = await runScenario("large-artifacts");

  assert.equal(result.error, undefined);
  assert.equal(result.promptCount, 6);
  // The mock profile lists full sidecar paths in prompts. This proves paths are
  // allowed while raw file contents stay out of the opencode payload.
  assert.equal(
    result.promptRequests.some(({ text }) => text.includes("axe-full.json")),
    true,
  );
  assert.equal(
    result.promptRequests.some(({ text }) => text.includes("checks-full.json")),
    true,
  );

  for (const { phase, text } of result.promptRequests) {
    // A small ceiling catches accidental prompt-content injection early. The
    // sentinel checks below identify exactly which raw artifact leaked.
    assert.ok(text.length < 2500, `${phase} prompt too large: ${text.length}`);
    for (const sentinel of rawArtifactSentinels) {
      assert.equal(
        text.includes(sentinel),
        false,
        `${phase} prompt included raw artifact content: ${sentinel}`,
      );
    }
  }
});

test("runSwarm supports profiles with no reviewers", async () => {
  const result = await runScenario("no-reviewers");

  assert.equal(result.error, undefined);
  assert.equal(result.sessionCount, 2);
  assertPhaseOrder(result, ["brief", "fix"]);
  assert.equal(phaseCount(result, "findings"), 0);
  assert.equal(phaseCount(result, "vote"), 0);
  assert.equal(phaseCount(result, "decision"), 0);
  assert.deepEqual(await readJson(result.runDir, "sessions.json"), {
    orchestrator: "session-1",
    fixer: "session-2",
  });
  assert.equal(existsSync(join(result.runDir, "iterations/001/findings")), false);
  assert.equal(existsSync(join(result.runDir, "iterations/001/votes")), false);
  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).accepts, 0);
});

test("runSwarm continues, reuses sessions, overwrites the artifact, and accepts on a later iteration", async () => {
  const result = await runScenario("continue-then-accept");

  assert.equal(result.error, undefined);
  assert.equal(result.sessionCount, 5);
  assert.equal(result.promptCount, 7);
  assert.equal(result.maxActiveByPhase.findings, undefined);
  assert.equal(result.maxActiveByPhase.vote, 3);
  assert.deepEqual(result.profileEvents.filter((event) => event.type === "check").map((event) => event.iteration), [1, 2]);

  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).outcome, "continue");
  assert.equal((await readJson(result.runDir, "iterations/002/decision.json")).outcome, "accept");
  assert.equal(existsSync(join(result.runDir, "iterations/003")), false);
  assert.match(await readText(result.runDir, "artifact.html"), /Artifact 2/);
  assert.equal(JSON.parse(result.preview["/checks.json"].body).iteration, 2);

  const sessionIDsByPhase = groupSessionIDsByPhase(result);
  assert.equal(sessionIDsByPhase.findings, undefined);
  assert.deepEqual(sessionIDsByPhase.vote, ["session-3", "session-4", "session-5"]);
  assert.equal(sessionIDsByPhase.aggregate, undefined);
  assert.deepEqual(sessionIDsByPhase.decision, ["session-1"]);
  assert.deepEqual(sessionIDsByPhase.fix, ["session-2"]);
});

test("runSwarm converts a final continue decision into stop_with_risks at the iteration cap", async () => {
  const result = await runScenario("max-iterations-stop");

  assert.equal(result.error, undefined);
  assert.deepEqual(result.profileEvents.filter((event) => event.type === "check").map((event) => event.iteration), [1, 2]);
  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).outcome, "continue");
  const finalDecision = await readJson(result.runDir, "iterations/002/decision.json");
  assert.equal(finalDecision.outcome, "stop_with_risks");
  assert.match(finalDecision.reason, /^max iterations reached: automated checks failed/);
  assert.equal(existsSync(join(result.runDir, "iterations/003")), false);

  assert.match(await readText(result.runDir, "report.md"), /stop_with_risks/);
});

test("runSwarm treats SWARM_MAX_ITERATIONS=0 as one iteration", async () => {
  const result = await runScenario("zero-max-iterations");

  assert.equal(result.error, undefined);
  assert.deepEqual(result.profileEvents.filter((event) => event.type === "check").map((event) => event.iteration), [1]);
  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).outcome, "stop_with_risks");
  assert.equal(existsSync(join(result.runDir, "iterations/002")), false);
});

test("runSwarm stops immediately on stop_with_risks and still writes the final report", async () => {
  const result = await runScenario("stop-with-risks");

  assert.equal(result.error, undefined);
  assert.deepEqual(result.profileEvents.filter((event) => event.type === "check").map((event) => event.iteration), [1]);
  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).outcome, "stop_with_risks");
  assert.equal(existsSync(join(result.runDir, "iterations/002")), false);
  await assertFiles(result.runDir, ["report.md", "report.html"]);
});

test("runSwarm logs scan failure and never opens agent sessions", async () => {
  const result = await runScenario("scan-failure");

  assert.match(result.error, /scan exploded/);
  assert.equal(result.sessionCount, 0);
  assert.equal(result.promptCount, 0);
  assert.deepEqual(result.profileEvents.map((event) => event.type), ["scan"]);
  assert.equal(existsSync(join(result.runDir, "sessions.json")), false);
  assert.equal(existsSync(join(result.runDir, "brief.md")), false);
  assert.equal(result.localUrl, undefined);

  const log = await readText(result.runDir, "swarm.log");
  assert.match(log, /scan failed/);
  assert.doesNotMatch(log, /opencode using existing server/);
});

test("runSwarm propagates check exceptions and does not vote, decide, report, or serve", async () => {
  const result = await runScenario("check-throws");

  assert.match(result.error, /check exploded at 1/);
  assertPhaseOrder(result, ["brief", "fix"]);
  assertNoPhases(result, ["vote", "decision", "report"]);
  assert.equal(existsSync(join(result.runDir, "iterations/001/checks.json")), false);
  assert.equal(existsSync(join(result.runDir, "iterations/001/votes")), false);
  assert.equal(existsSync(join(result.runDir, "iterations/001/decision.json")), false);
  assert.equal(existsSync(join(result.runDir, "report.md")), false);
  assert.equal(result.localUrl, undefined);

  const log = await readText(result.runDir, "swarm.log");
  assert.match(log, /check failed/);
});

test("runSwarm characterizes malformed check results before voting or reporting", async () => {
  const result = await runScenario("check-missing-failures");

  assert.match(result.error, /Cannot read.*length|undefined/);
  assertPhaseOrder(result, ["brief", "fix"]);
  assertNoPhases(result, ["vote", "decision", "report"]);
  assert.equal(existsSync(join(result.runDir, "iterations/001/checks.json")), true);
  assert.deepEqual(await readJson(result.runDir, "iterations/001/checks.json"), {
    passed: true,
    iteration: 1,
  });
  assert.equal(result.localUrl, undefined);
});

test("runSwarm validates decision.json and fails before reporting invalid orchestrator output", async () => {
  const result = await runScenario("invalid-decision");

  assert.match(result.error, /invalid decision outcome/);
  assertPhaseOrder(result, ["brief", "fix", "vote", "decision"]);
  assert.equal(phaseCount(result, "vote"), 3);
  assertNoPhases(result, ["report"]);
  assert.equal(existsSync(join(result.runDir, "iterations/001/decision.json")), true);
  assert.equal(existsSync(join(result.runDir, "report.md")), false);
  assert.equal(result.localUrl, undefined);
});

for (const [scenario, message] of [
  ["invalid-decision-reason", /invalid decision reason/],
  ["invalid-decision-checks-pass", /invalid decision checksPass/],
  ["invalid-decision-accepts", /invalid decision accepts/],
  ["invalid-decision-blocks", /invalid decision blocks/],
  ["malformed-decision-json", /JSON|Expected property name|Unexpected token/],
]) {
  test(`runSwarm rejects malformed decision output: ${scenario}`, async () => {
    const result = await runScenario(scenario);

    assert.match(result.error, message);
    assert.equal(existsSync(join(result.runDir, "iterations/001/decision.json")), true);
    assert.equal(existsSync(join(result.runDir, "report.md")), false);
    assert.equal(result.localUrl, undefined);
  });
}

test("runSwarm times out when an accepted prompt does not produce its expected output", async () => {
  const result = await runScenario("prompt-timeout");

  assert.match(result.error, /timed out waiting for .*brief\.md/);
  assert.equal(phaseCount(result, "brief"), 1);
  assertNoPhases(result, ["findings", "aggregate", "fix", "vote", "decision", "report"]);
  assert.equal(existsSync(join(result.runDir, "prompts/brief.md")), true);
  assert.equal(existsSync(join(result.runDir, "brief.md")), false);
  assert.equal(existsSync(join(result.runDir, "iterations")), false);
  assert.equal(result.localUrl, undefined);

  const log = await readText(result.runDir, "swarm.log");
  assert.match(log, /prompt wait timeout/);
});

test("runSwarm propagates opencode session creation failures", async () => {
  const result = await runScenario("session-create-error");

  assert.match(result.error, /session create|create unavailable|ResponseStatusError|500/);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.sessionRequests[0].failed, true);
  assert.equal(phases(result).length, 0);
  assert.equal(existsSync(join(result.runDir, "sessions.json")), false);
  assert.equal(existsSync(join(result.runDir, "prompts/brief.md")), false);
  assert.equal(result.localUrl, undefined);
});

test("runSwarm propagates reviewer session creation failures during voting", async () => {
  const result = await runScenario("reviewer-session-create-error");

  assert.match(result.error, /session create|session create unavailable|ResponseStatusError|500/);
  assert.equal(result.sessionRequests.some((request) => request.key === "alpha" && request.failed), true);
  assert.equal((await readJson(result.runDir, "sessions.json")).orchestrator, "session-1");
  assert.equal(phaseCount(result, "brief"), 1);
  assertPhaseOrder(result, ["brief", "fix"]);
  assertNoPhases(result, ["decision", "report"]);
  assert.equal(result.localUrl, undefined);
});

test("runSwarm no longer runs a reviewer findings phase", async () => {
  const result = await runScenario("findings-prompt-error");

  assert.equal(result.error, undefined);
  assert.equal(phaseCount(result, "findings"), 0);
  assert.equal(phaseCount(result, "vote"), 3);
  assert.equal((await readJson(result.runDir, "iterations/001/decision.json")).outcome, "accept");
});

test("runSwarm propagates partial reviewer vote prompt failures", async () => {
  const result = await runScenario("vote-prompt-error");

  assert.match(result.error, /session prompt|prompt unavailable|ResponseStatusError|500/);
  assertPhaseOrder(result, ["brief", "fix", "vote"]);
  assert.equal(phaseCount(result, "vote"), 3);
  assertNoPhases(result, ["decision", "report"]);
  assert.equal(existsSync(join(result.runDir, "iterations/001/checks.json")), true);
  assert.equal(existsSync(join(result.runDir, "iterations/001/prompts/alpha-vote.md")), true);
  assert.equal(existsSync(join(result.runDir, "iterations/001/votes/alpha.json")), false);
  assert.equal(existsSync(join(result.runDir, "iterations/001/votes/beta.json")), true);
  assert.equal(existsSync(join(result.runDir, "iterations/001/votes/gamma.json")), true);
  assert.equal(existsSync(join(result.runDir, "iterations/001/decision.json")), false);
  assert.equal(result.localUrl, undefined);
});

test("runSwarm propagates opencode prompt submission failures after saving the prompt", async () => {
  const result = await runScenario("prompt-submit-error");

  assert.match(result.error, /session prompt|prompt unavailable|ResponseStatusError|500/);
  assert.equal(result.sessionCount, 1);
  assert.equal(phaseCount(result, "brief"), 1);
  assertNoPhases(result, ["findings", "aggregate", "fix", "vote", "decision", "report"]);
  assert.equal(existsSync(join(result.runDir, "prompts/brief.md")), true);
  assert.equal(existsSync(join(result.runDir, "brief.md")), false);
  assert.equal(result.localUrl, undefined);
});

test("runSwarm falls back from the preferred preview port when 5177 is occupied", async () => {
  const result = await runScenario("port-fallback");

  assert.equal(result.error, undefined);
  assert.ok(["bound", "already-in-use"].includes(result.portBlockerState));
  assert.notEqual(result.localPort, 5177);
  assert.equal(result.preview["/"].status, 200);
});

test("runSwarm passes configured agent, model, role variant, title, and permissions to opencode", async () => {
  const result = await runScenario("model-env");

  assert.equal(result.error, undefined);
  assert.equal(result.sessionCount, 5);
  for (const { key, request } of result.sessionRequests) {
    const isMax = key === "orchestrator" || key === "fixer";
    assert.match(request.title, /^swarm (orchestrator|alpha|beta|gamma|fixer) runs\//);
    assert.equal(request.agent, "architect-test-agent");
    assert.deepEqual(request.model, {
      providerID: "test-provider",
      id: "model/family",
      variant: isMax ? "max" : "low",
    });
    assert.deepEqual(request.permission, [
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  }
  for (const { phase, request, text } of result.promptRequests) {
    const isMax = !["findings", "vote"].includes(phase);
    assert.match(text, new RegExp(`RUN_DIR: ${escapeRegExp(result.runDir)}`));
    assert.equal(request.agent, "architect-test-agent");
    assert.deepEqual(request.model, {
      providerID: "test-provider",
      modelID: "model/family",
    });
    assert.equal(request.variant, isMax ? "max" : "low");
  }
});

test("runSwarm can use pro model for orchestrator and fixer only", async () => {
  const result = await runScenario("orchestrator-fixer-model-env");

  assert.equal(result.error, undefined);
  for (const { key, request } of result.sessionRequests) {
    const isPro = key === "orchestrator" || key === "fixer";
    assert.deepEqual(request.model, {
      providerID: isPro ? "pro-provider" : "flash-provider",
      id: isPro ? "pro-model" : "flash-model",
      variant: isPro ? "max" : "low",
    });
  }
  for (const { phase, request } of result.promptRequests) {
    const isPro = !["findings", "vote"].includes(phase);
    assert.deepEqual(request.model, {
      providerID: isPro ? "pro-provider" : "flash-provider",
      modelID: isPro ? "pro-model" : "flash-model",
    });
    assert.equal(request.variant, isPro ? "max" : "low");
  }
});

async function runScenario(name) {
  const distCore = join(repoRoot, "dist/core.js");
  const srcCore = join(repoRoot, "src/core.ts");
  assert.equal(existsSync(distCore), true, "dist/core.js missing; run npm run build before tests");
  const [distCoreStat, srcCoreStat] = await Promise.all([stat(distCore), stat(srcCore)]);
  assert.ok(
    distCoreStat.mtimeMs >= srcCoreStat.mtimeMs,
    "dist/core.js is older than src/core.ts; run npm run build before tests",
  );
  const rootDir = await mkdtemp(join(tmpdir(), `tiny-rewrite-core-${name}-`));
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

  const exit = await waitForExit(child, 20000);
  const marker = stdout
    .split("\n")
    .find((line) => line.startsWith("@@CORE_TEST_RESULT@@"));
  if (!marker) {
    assert.fail(`missing scenario result for ${name}\nexit=${exit.code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const result = JSON.parse(marker.slice("@@CORE_TEST_RESULT@@".length));
  if (exit.code !== 0) {
    assert.fail(
      `scenario ${name} failed: ${result.error || "unknown"}\nstdout:\n${stdout}\nstderr:\n${stderr}\nstack:\n${result.stack || ""}`,
    );
  }
  assert.equal(result.unexpectedRequests.length, 0, `unexpected opencode requests: ${JSON.stringify(result.unexpectedRequests)}`);
  assert.ok(result.runDir || result.error, "scenario should have a runDir unless it failed before run creation");
  return result;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function phases(result) {
  return result.promptRequests.map((request) => request.phase);
}

function phaseCount(result, phase) {
  return phases(result).filter((value) => value === phase).length;
}

function assertNoPhases(result, denied) {
  for (const phase of denied) {
    assert.equal(phaseCount(result, phase), 0, `unexpected ${phase} phase`);
  }
}

function assertPhaseOrder(result, expected) {
  const actual = phases(result);
  let cursor = -1;
  for (const phase of expected) {
    const index = actual.indexOf(phase, cursor + 1);
    assert.notEqual(index, -1, `missing phase ${phase} after ${actual[cursor] || "start"}; actual=${actual.join(",")}`);
    cursor = index;
  }
}

function groupSessionIDsByPhase(result) {
  const grouped = {};
  for (const prompt of result.promptRequests) {
    grouped[prompt.phase] ||= [];
    if (!grouped[prompt.phase].includes(prompt.sessionID)) grouped[prompt.phase].push(prompt.sessionID);
  }
  return grouped;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertFiles(root, paths) {
  for (const path of paths) {
    const absolute = join(root, path);
    assert.equal(existsSync(absolute), true, `missing ${path}`);
    assert.equal((await stat(absolute)).isFile(), true, `${path} is not a file`);
  }
}

async function readJson(root, path) {
  return JSON.parse(await readText(root, path));
}

async function readText(root, path) {
  return readFile(join(root, path), "utf8");
}
