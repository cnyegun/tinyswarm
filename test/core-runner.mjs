import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runSwarm } from "../dist/core.js";

const [scenarioName, rootDir] = process.argv.slice(2);

if (!scenarioName || !rootDir) {
  console.error("usage: node test/core-runner.mjs <scenario> <rootDir>");
  process.exit(2);
}

const defaultReviewers = [
  { id: "alpha", name: "Alpha Reviewer" },
  { id: "beta", name: "Beta Reviewer" },
  { id: "gamma", name: "Gamma Reviewer" },
];

const rawArtifactSentinels = {
  original: "RAW_ORIGINAL_SENTINEL_DO_NOT_PROMPT",
  axeFull: "RAW_AXE_FULL_SENTINEL_DO_NOT_PROMPT",
  checksFull: "RAW_CHECKS_FULL_SENTINEL_DO_NOT_PROMPT",
};

const scenarios = {
  "accept-first": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
  },
  "preexisting-brief": {
    maxIterations: "1",
    checks: [true],
    decisions: ["accept"],
    preexistingBrief: true,
  },
  "large-artifacts": {
    maxIterations: "1",
    checks: [true],
    decisions: ["accept"],
    // Writes huge artifacts containing sentinel strings. The paired core test
    // asserts prompts mention only their paths, never their contents.
    largeArtifacts: true,
  },
  "no-reviewers": {
    maxIterations: "1",
    checks: [true],
    decisions: ["accept"],
    noReviewers: true,
  },
  "continue-then-accept": {
    maxIterations: "3",
    checks: [false, true],
    decisions: ["continue", "accept"],
    delayParallelMs: 150,
  },
  "max-iterations-stop": {
    maxIterations: "2",
    checks: [false, false],
    decisions: ["continue", "continue"],
  },
  "zero-max-iterations": {
    maxIterations: "0",
    checks: [false],
    decisions: ["continue"],
  },
  "stop-with-risks": {
    maxIterations: "3",
    checks: [false],
    decisions: ["stop_with_risks"],
  },
  "scan-failure": {
    maxIterations: "3",
    scanThrows: true,
    expectError: /scan exploded/,
  },
  "check-throws": {
    maxIterations: "3",
    checks: [false],
    checkThrowsAt: 1,
    expectError: /check exploded at 1/,
  },
  "check-missing-failures": {
    maxIterations: "3",
    checks: [true],
    malformedCheck: "missingFailures",
    expectError: /Cannot read.*failures|Cannot read.*length|undefined/,
  },
  "invalid-decision": {
    maxIterations: "3",
    checks: [true],
    invalidDecisionAt: 1,
    invalidDecisionShape: "outcome",
    expectError: /invalid decision outcome/,
  },
  "invalid-decision-reason": {
    maxIterations: "3",
    checks: [true],
    invalidDecisionAt: 1,
    invalidDecisionShape: "reason",
    expectError: /invalid decision reason/,
  },
  "invalid-decision-checks-pass": {
    maxIterations: "3",
    checks: [true],
    invalidDecisionAt: 1,
    invalidDecisionShape: "checksPass",
    expectError: /invalid decision checksPass/,
  },
  "invalid-decision-accepts": {
    maxIterations: "3",
    checks: [true],
    invalidDecisionAt: 1,
    invalidDecisionShape: "accepts",
    expectError: /invalid decision accepts/,
  },
  "invalid-decision-blocks": {
    maxIterations: "3",
    checks: [true],
    invalidDecisionAt: 1,
    invalidDecisionShape: "blocks",
    expectError: /invalid decision blocks/,
  },
  "malformed-decision-json": {
    maxIterations: "3",
    checks: [true],
    invalidDecisionAt: 1,
    invalidDecisionShape: "malformed",
    expectError: /JSON|Expected property name|Unexpected token/,
  },
  "prompt-timeout": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
    omitOutputsForPhase: "brief",
    timeoutMs: "100",
    expectError: /timed out waiting for/,
  },
  "session-create-error": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
    sessionCreateFailsAt: 1,
    expectError: /session create|create unavailable|ResponseStatusError|500/,
  },
  "prompt-submit-error": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
    promptFailsForPhase: "brief",
    expectError: /session prompt|prompt unavailable|ResponseStatusError|500/,
  },
  "reviewer-session-create-error": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
    sessionCreateFailsForKey: "alpha",
    sessionFailureDelayMs: 100,
    expectError: /session create|session create unavailable|ResponseStatusError|500/,
  },
  "findings-prompt-error": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
    promptFailsForPhase: "findings",
    promptFailsForReviewer: "alpha",
    promptFailureDelayMs: 100,
    expectError: /session prompt|prompt unavailable|ResponseStatusError|500/,
  },
  "vote-prompt-error": {
    maxIterations: "3",
    checks: [true],
    decisions: ["accept"],
    promptFailsForPhase: "vote",
    promptFailsForReviewer: "alpha",
    promptFailureDelayMs: 100,
    expectError: /session prompt|prompt unavailable|ResponseStatusError|500/,
  },
  "port-fallback": {
    maxIterations: "1",
    checks: [true],
    decisions: ["accept"],
    occupyPort5177: true,
  },
  "model-env": {
    maxIterations: "1",
    checks: [true],
    decisions: ["accept"],
    agent: "architect-test-agent",
    model: "test-provider/model/family",
    variant: "nightly",
  },
  "orchestrator-fixer-model-env": {
    maxIterations: "1",
    checks: [true],
    decisions: ["accept"],
    model: "flash-provider/flash-model",
    variant: "max",
    orchestratorModel: "pro-provider/pro-model",
    fixerModel: "pro-provider/pro-model",
  },
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`unknown scenario: ${scenarioName}`);
  process.exit(2);
}
const activeReviewers = scenario.noReviewers ? [] : defaultReviewers;

let opencode;
let portBlocker;
let portBlockerState = "not-requested";
const consoleLines = [];
const originalConsoleLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(" ");
  consoleLines.push(line);
  originalConsoleLog(...args);
};

const state = {
  profileEvents: [],
  sessionRequests: [],
  promptRequests: [],
  sessions: new Map(),
  activeByPhase: {},
  maxActiveByPhase: {},
  unexpectedRequests: [],
  touchCounter: 0,
};

try {
  rmSync(join(rootDir, "runs"), { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });

  if (scenario.occupyPort5177) {
    portBlocker = createServer((_req, res) => res.end("blocked"));
    try {
      await listen(portBlocker, 5177);
      portBlockerState = "bound";
    } catch (error) {
      portBlocker = undefined;
      if (error?.code === "EADDRINUSE") portBlockerState = "already-in-use";
      else throw error;
    }
  }

  opencode = await startOpencodeServer();
  process.env.SWARM_OPENCODE_SERVER_URL = `http://127.0.0.1:${port(opencode)}`;
  process.env.SWARM_MAX_ITERATIONS = scenario.maxIterations;
  process.env.SWARM_AGENT_TIMEOUT_MS = scenario.timeoutMs || "10000";
  process.env.SWARM_WAIT_LOG_INTERVAL_MS = "1000";
  process.env.SWARM_AGENT = scenario.agent || "test-agent";
  process.env.SWARM_MODEL = scenario.model || "fake-provider/fake-model";
  process.env.SWARM_VARIANT = scenario.variant || "test-variant";
  if (scenario.orchestratorModel) process.env.SWARM_ORCHESTRATOR_MODEL = scenario.orchestratorModel;
  else delete process.env.SWARM_ORCHESTRATOR_MODEL;
  if (scenario.fixerModel) process.env.SWARM_FIXER_MODEL = scenario.fixerModel;
  else delete process.env.SWARM_FIXER_MODEL;

  const profile = createProfile();
  let caught;
  try {
    await runSwarm(profile, `input-for-${scenarioName}`, rootDir);
  } catch (error) {
    caught = error;
  }

  if (scenario.expectError) {
    const message = describeError(caught);
    if (!caught || !scenario.expectError.test(message)) {
      throw new Error(
        `expected ${scenario.expectError}, got ${message || "no error"}`,
      );
    }
  } else if (caught) {
    throw caught;
  }

  const runDir = latestRunDir(rootDir);
  const localUrl = consoleLines
    .find((line) => line.startsWith("Local: "))
    ?.slice("Local: ".length);
  const preview = localUrl ? await fetchPreview(localUrl) : undefined;
  const result = {
    scenario: scenarioName,
    rootDir,
    runDir,
    error: caught ? describeError(caught) : undefined,
    localUrl,
    localPort: localUrl ? Number(new URL(localUrl).port) : undefined,
    portBlockerState,
    consoleLines,
    preview,
    profileEvents: state.profileEvents,
    sessionRequests: state.sessionRequests,
    promptRequests: state.promptRequests,
    sessionCount: state.sessionRequests.length,
    promptCount: state.promptRequests.length,
    maxActiveByPhase: state.maxActiveByPhase,
    unexpectedRequests: state.unexpectedRequests,
    runTree: runDir ? tree(runDir) : [],
  };
  await close(opencode);
  await close(portBlocker);
  await printResultAndExit(0, result);
} catch (error) {
  const result = {
    scenario: scenarioName,
    rootDir,
    error: describeError(error),
    stack: error?.stack,
    consoleLines,
    profileEvents: state.profileEvents,
    sessionRequests: state.sessionRequests,
    promptRequests: state.promptRequests,
    sessionCount: state.sessionRequests.length,
    promptCount: state.promptRequests.length,
    maxActiveByPhase: state.maxActiveByPhase,
    unexpectedRequests: state.unexpectedRequests,
  };
  await close(opencode);
  await close(portBlocker);
  await printResultAndExit(1, result);
}

function createProfile() {
  return {
    id: `fake-${scenarioName}`,
    artifact: "artifact.html",
    reviewers: activeReviewers,
    async scan(input, ctx) {
      state.profileEvents.push({ type: "scan", input, runDir: ctx.runDir });
      if (scenario.scanThrows) throw new Error("scan exploded");
      mkdirSync(join(ctx.runDir, "screenshots"), { recursive: true });
      writeTouched(
        join(ctx.runDir, "original.html"),
        scenario.largeArtifacts
          ? largeArtifact(rawArtifactSentinels.original)
          : `<main>${input}</main>`,
      );
      writeTouched(
        join(ctx.runDir, "facts.json"),
        JSON.stringify({ input, url: "https://example.test/source" }, null, 2),
      );
      writeTouched(join(ctx.runDir, "axe.json"), JSON.stringify({ violations: [] }));
      if (scenario.largeArtifacts) {
        // These full sidecars are intentionally huge. The core guard test fails
        // if runSwarm ever inlines their contents into an opencode prompt.
        writeTouched(
          join(ctx.runDir, "axe-full.json"),
          largeArtifact(rawArtifactSentinels.axeFull),
        );
      }
      writeTouched(join(ctx.runDir, "screenshots", "original.png"), "png");
      if (scenario.preexistingBrief)
        writeTouched(join(ctx.runDir, "brief.md"), "stale brief");
    },
    async check(ctx, iteration) {
      state.profileEvents.push({ type: "check", iteration, runDir: ctx.runDir });
      if (scenario.checkThrowsAt === iteration)
        throw new Error(`check exploded at ${iteration}`);
      if (scenario.malformedCheck === "missingFailures") {
        return { passed: true, iteration };
      }
      if (scenario.largeArtifacts) {
        writeTouched(
          join(
            ctx.runDir,
            "iterations",
            String(iteration).padStart(3, "0"),
            "checks-full.json",
          ),
          largeArtifact(rawArtifactSentinels.checksFull),
        );
      }
      const passed = scenario.checks?.[iteration - 1] ?? true;
      return {
        passed,
        failures: passed ? [] : [`failure at iteration ${iteration}`],
        iteration,
        checkedArtifactExists: existsSync(join(ctx.runDir, "artifact.html")),
      };
    },
    briefPrompt: ({ runDir }) => promptText("brief", { runDir }, [join(runDir, "brief.md")]),
    findingsPrompt: ({ runDir, iterDir, iteration }, reviewer) =>
      promptText(
        "findings",
        { runDir, iterDir, iteration, reviewer: reviewer.id },
        [join(iterDir, "findings", `${reviewer.id}.json`)],
      ),
    aggregatePrompt: ({ runDir, iterDir, iteration }) =>
      promptText("aggregate", { runDir, iterDir, iteration }, [
        join(iterDir, "aggregate-feedback.json"),
        join(iterDir, "solver-task.md"),
      ]),
    fixPrompt: ({ runDir, iterDir, iteration }) =>
      promptText("fix", { runDir, iterDir, iteration }, [
        join(runDir, "artifact.html"),
        join(iterDir, "solver-result.json"),
      ]),
    votePrompt: ({ runDir, iterDir, iteration }, reviewer) =>
      promptText(
        "vote",
        { runDir, iterDir, iteration, reviewer: reviewer.id },
        [join(iterDir, "votes", `${reviewer.id}.json`)],
      ),
    decisionPrompt: ({ runDir, iterDir, iteration }) =>
      promptText("decision", { runDir, iterDir, iteration }, [
        join(iterDir, "decision.json"),
      ]),
    reportPrompt: ({ runDir }, decision) =>
      promptText(
        "report",
        { runDir, finalDecision: JSON.stringify(decision || null) },
        [join(runDir, "report.md"), join(runDir, "report.html")],
      ),
  };
}

function promptText(phase, details, outputs) {
  // For the large-artifacts scenario, prompts list artifact paths just like a
  // real profile would. The sentinel contents stay on disk, not in prompt text.
  const availableFiles = scenario.largeArtifacts ? largeArtifactPaths(details) : [];
  const lines = [
    `PHASE: ${phase}`,
    details.iteration ? `ITERATION: ${details.iteration}` : undefined,
    details.reviewer ? `REVIEWER: ${details.reviewer}` : undefined,
    `RUN_DIR: ${details.runDir}`,
    details.iterDir ? `ITER_DIR: ${details.iterDir}` : undefined,
    details.finalDecision ? `FINAL_DECISION: ${details.finalDecision}` : undefined,
    availableFiles.length ? "AVAILABLE_FILES:" : undefined,
    ...availableFiles.map((path) => `* ${path}`),
    "OUTPUTS:",
    ...outputs.map((output) => `- ${output}`),
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

function largeArtifactPaths(details) {
  // Include both compact and full paths to make sure the prompt-budget guard does
  // not accidentally ban sidecar references, only raw sidecar contents.
  return [
    join(details.runDir, "original.html"),
    join(details.runDir, "axe.json"),
    join(details.runDir, "axe-full.json"),
    details.iterDir ? join(details.iterDir, "checks.json") : undefined,
    details.iterDir ? join(details.iterDir, "checks-full.json") : undefined,
  ].filter(Boolean);
}

function largeArtifact(sentinel) {
  // The repeated body makes accidental inlining obvious by size; the sentinel
  // makes the failure message identify which artifact leaked.
  return `${sentinel}\n${"x".repeat(12000)}`;
}

async function startOpencodeServer() {
  return start(async (req, res) => {
    if (req.method === "GET" && req.url === "/global/health") {
      json(res, { healthy: true, version: "fake" });
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/session?")) {
      const request = await readBody(req);
      const permission = request.permission || [];
      if (
        !permission.some(
          (rule) =>
            rule.permission === "*" &&
            rule.pattern === "*" &&
            rule.action === "allow",
        )
      ) {
        res.writeHead(400).end(JSON.stringify({ error: "missing allow-all" }));
        return;
      }
      const sessionKey = sessionKeyFromTitle(request.title || "");
      const shouldFailSession =
        scenario.sessionCreateFailsAt === state.sessionRequests.length + 1 ||
        (scenario.sessionCreateFailsForKey &&
          scenario.sessionCreateFailsForKey === sessionKey);
      if (shouldFailSession) {
        if (scenario.sessionFailureDelayMs) await sleep(scenario.sessionFailureDelayMs);
        state.sessionRequests.push({ id: undefined, key: sessionKey, request, failed: true });
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({ message: "session create unavailable" }),
        );
        return;
      }
      const id = `session-${state.sessionRequests.length + 1}`;
      state.sessions.set(id, request.title || id);
      state.sessionRequests.push({ id, key: sessionKey, request });
      json(res, {
        id,
        title: request.title || id,
        time: { created: Date.now(), updated: Date.now() },
        directory: request.directory,
        projectID: "fake-project",
        version: "fake",
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/config/providers?")) {
      json(res, mockProviders());
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/session/status?")) {
      json(
        res,
        Object.fromEntries([...state.sessions.keys()].map((id) => [id, { type: "idle" }])),
      );
      return;
    }
    if (req.method === "GET" && req.url.includes("/message")) {
      json(res, []);
      return;
    }
    const promptMatch =
      req.method === "POST" &&
      req.url.match(/^\/session\/([^/]+)\/(?:message|prompt_async)\?/);
    if (promptMatch) {
      const request = await readBody(req);
      const text = request.parts?.[0]?.text || "";
      const phase = field(text, "PHASE") || "unknown";
      const iteration = Number(field(text, "ITERATION") || 0) || undefined;
      const reviewer = field(text, "REVIEWER") || undefined;
      const outputs = outputPaths(text);
      state.promptRequests.push({
        sessionID: promptMatch[1],
        phase,
        iteration,
        reviewer,
        outputs,
        request: withoutLargeText(request),
        text,
      });
      state.activeByPhase[phase] = (state.activeByPhase[phase] || 0) + 1;
      state.maxActiveByPhase[phase] = Math.max(
        state.maxActiveByPhase[phase] || 0,
        state.activeByPhase[phase],
      );
      try {
        const shouldFailPrompt =
          scenario.promptFailsForPhase === phase &&
          (!scenario.promptFailsForReviewer ||
            scenario.promptFailsForReviewer === reviewer);
        if (shouldFailPrompt) {
          if (scenario.promptFailureDelayMs) await sleep(scenario.promptFailureDelayMs);
          res.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({ message: "prompt unavailable" }),
          );
          return;
        }
        if (scenario.delayParallelMs && (phase === "findings" || phase === "vote"))
          await sleep(scenario.delayParallelMs);
        if (scenario.omitOutputsForPhase !== phase) writePromptOutputs(phase, text, outputs);
        json(res, {
          id: `message-${state.promptRequests.length}`,
          sessionID: promptMatch[1],
          role: "assistant",
          parts: [],
          time: { created: Date.now() },
        });
      } finally {
        state.activeByPhase[phase] -= 1;
      }
      return;
    }
    state.unexpectedRequests.push({ method: req.method, url: req.url });
    res.writeHead(404).end("not found");
  });
}

function mockProviders() {
  const specs = [
    process.env.SWARM_MODEL || "fake-provider/fake-model",
    process.env.SWARM_ORCHESTRATOR_MODEL,
    process.env.SWARM_FIXER_MODEL,
  ].filter(Boolean);
  const providers = new Map();
  for (const spec of specs) {
    const [providerID, ...rest] = spec.split("/");
    const modelID = rest.join("/");
    if (!providers.has(providerID)) providers.set(providerID, {});
    providers.get(providerID)[modelID] = {
      id: modelID,
      providerID,
      variants: { [process.env.SWARM_VARIANT || "test-variant"]: {} },
    };
  }
  return {
    providers: [...providers].map(([id, models]) => ({ id, models })),
    default: {},
  };
}

function writePromptOutputs(phase, text, outputs) {
  const iteration = Number(field(text, "ITERATION") || 0) || 1;
  const reviewer = field(text, "REVIEWER") || "reviewer";
  if (phase === "brief") {
    writeTouched(outputs[0], `# Brief\n\nScenario ${scenarioName}\n`);
    return;
  }
  if (phase === "findings") {
    writeTouched(
      outputs[0],
      JSON.stringify(
        { role: reviewer, findings: [`${reviewer} finding ${iteration}`], risk: "low" },
        null,
        2,
      ),
    );
    return;
  }
  if (phase === "aggregate") {
    writeTouched(
      outputs.find((output) => output.endsWith("aggregate-feedback.json")),
      JSON.stringify({ summary: `aggregate ${iteration}`, priorities: [], risks: [] }, null, 2),
    );
    writeTouched(
      outputs.find((output) => output.endsWith("solver-task.md")),
      `# Solver task ${iteration}\n`,
    );
    return;
  }
  if (phase === "fix") {
    writeTouched(
      outputs.find((output) => output.endsWith("artifact.html")),
      `<!doctype html><html><head><title>Artifact ${iteration}</title></head><body><main><h1>Artifact ${iteration}</h1><p>${scenarioName}</p></main></body></html>`,
    );
    writeTouched(
      outputs.find((output) => output.endsWith("solver-result.json")),
      JSON.stringify({ changed: true, iteration }, null, 2),
    );
    return;
  }
  if (phase === "vote") {
    const passed = scenario.checks?.[iteration - 1] ?? true;
    writeTouched(
      outputs[0],
      JSON.stringify(
        {
          vote: passed ? "accept" : "revise",
          score: passed ? 96 : 45,
          reason: `${reviewer} vote ${iteration}`,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (phase === "decision") {
    if (scenario.invalidDecisionAt === iteration) {
      writeTouched(outputs[0], invalidDecisionContent(scenario.invalidDecisionShape));
      return;
    }
    const outcome = scenario.decisions?.[iteration - 1] || "accept";
    const checksPass = scenario.checks?.[iteration - 1] ?? outcome === "accept";
    writeTouched(
      outputs[0],
      JSON.stringify(
        {
          outcome,
          reason: `${outcome} at iteration ${iteration}`,
          checksPass,
          accepts: outcome === "accept" ? activeReviewers.length : 0,
          blocks: outcome === "accept" ? 0 : 1,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (phase === "report") {
    const finalDecision = field(text, "FINAL_DECISION") || "null";
    writeTouched(outputs.find((output) => output.endsWith("report.md")), `# Report\n\n${finalDecision}\n`);
    writeTouched(
      outputs.find((output) => output.endsWith("report.html")),
      `<!doctype html><html><head><title>Report</title></head><body><main><h1>Report</h1><pre>${escapeHtml(finalDecision)}</pre></main></body></html>`,
    );
  }
}

function invalidDecisionContent(shape) {
  if (shape === "malformed") return "{ not json";
  const valid = {
    outcome: "accept",
    reason: "valid reason",
    checksPass: true,
    accepts: activeReviewers.length,
    blocks: 0,
  };
  if (shape === "outcome") valid.outcome = "bogus";
  if (shape === "reason") valid.reason = 42;
  if (shape === "checksPass") valid.checksPass = "yes";
  if (shape === "accepts") valid.accepts = "3";
  if (shape === "blocks") valid.blocks = "0";
  return JSON.stringify(valid, null, 2);
}

function outputPaths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(\/.*)$/)?.[1])
    .filter(Boolean);
}

function field(text, name) {
  return text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
}

function sessionKeyFromTitle(title) {
  return title.match(/^swarm ([^ ]+) /)?.[1] || "";
}

function writeTouched(path, content) {
  if (!path) throw new Error("missing output path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const time = new Date(Date.now() + ++state.touchCounter * 1000);
  utimesSync(path, time, time);
}

function withoutLargeText(request) {
  return {
    ...request,
    parts: request.parts?.map((part) =>
      part.type === "text" ? { ...part, text: `[${part.text.length} chars]` } : part,
    ),
  };
}

async function fetchPreview(localUrl) {
  const routes = [
    "/",
    "/artifact.html",
    "/artifact.html?download=1",
    "/report.html",
    "/report.html?cache=1",
    "/report.md",
    "/brief.md",
    "/checks.json",
    "/iterations/001/checks.json",
    "/iterations/001/",
    "/missing",
    "/%2e%2e/package.json",
  ];
  const responses = {};
  for (const route of routes) {
    const response = await fetch(`${localUrl}${route}`);
    responses[route] = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  }
  return responses;
}

function latestRunDir(root) {
  const runsRoot = join(root, "runs");
  if (!existsSync(runsRoot)) return undefined;
  const runs = readdirSync(runsRoot).sort();
  return runs.length ? join(runsRoot, runs.at(-1)) : undefined;
}

function tree(root) {
  const entries = [];
  walk(root, "", entries);
  return entries.sort();
}

function walk(root, prefix, entries) {
  for (const name of readdirSync(join(root, prefix))) {
    const relative = prefix ? join(prefix, name) : name;
    const absolute = join(root, relative);
    entries.push(statSync(absolute).isDirectory() ? `${relative}/` : relative);
    if (statSync(absolute).isDirectory()) walk(root, relative, entries);
  }
}

function start(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function listen(server, requestedPort) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server) return undefined;
  return new Promise((resolve) => server.close(resolve));
}

function port(server) {
  return server.address().port;
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => resolve(text ? JSON.parse(text) : {}));
  });
}

function json(res, data) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  if (!error) return "";
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function printResultAndExit(code, result) {
  await new Promise((resolve) => {
    process.stdout.write(`@@CORE_TEST_RESULT@@${JSON.stringify(result)}\n`, resolve);
  });
  process.exit(code);
}
