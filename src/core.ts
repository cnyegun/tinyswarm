import { createOpencode, createOpencodeClient, type OpencodeClient, type PermissionRuleset } from "@opencode-ai/sdk/v2";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export type Reviewer = { id: string; name: string };
export type Decision = { outcome: "accept" | "continue" | "stop_with_risks"; reason: string; checksPass: boolean; accepts: number; blocks: number };
export type CheckResult = { passed: boolean; failures: string[]; [key: string]: unknown };
export type RunContext = { rootDir: string; runDir: string };
export type IterationContext = RunContext & { iterDir: string; iteration: number };

export type SwarmProfile = {
  id: string;
  artifact: string;
  reviewers: Reviewer[];
  scan(input: string, ctx: RunContext): Promise<void>;
  check(ctx: RunContext, iteration: number): Promise<CheckResult>;
  briefPrompt(ctx: RunContext): string;
  findingsPrompt(ctx: IterationContext, reviewer: Reviewer): string;
  aggregatePrompt(ctx: IterationContext): string;
  fixPrompt(ctx: IterationContext): string;
  votePrompt(ctx: IterationContext, reviewer: Reviewer): string;
  decisionPrompt(ctx: IterationContext): string;
  reportPrompt(ctx: RunContext, decision?: Decision): string;
};

type Harness = { client: OpencodeClient; url: string; close?: () => void; sessions: Record<string, string> };
type OutputState = { path: string; exists: boolean; changed: boolean; previousMtimeMs: number; mtimeMs?: number; size?: number };

const allowAll: PermissionRuleset = [{ permission: "*", pattern: "*", action: "allow" }];
let harness: Harness | undefined;
let logFile = "";
let started = Date.now();

export async function runSwarm(profile: SwarmProfile, input: string, rootDir: string) {
  const maxIterations = Math.max(1, Number(process.env.SWARM_MAX_ITERATIONS || 3));
  const runDir = join(rootDir, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });
  logFile = join(runDir, "swarm.log");
  started = Date.now();
  const model = modelSpec();

  console.log(`Run: ${shown(rootDir, runDir)}`);
  console.log(`Log: ${shown(rootDir, logFile)}`);
  console.log(`Model: ${modelName(model)} (variant=${model.variant}), agent=${process.env.SWARM_AGENT || "build"}, maxIterations=${maxIterations}`);

  log("run", "starting", {
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
    node: process.version
  });

  try {
    const ctx = { rootDir, runDir };
    const scanStarted = Date.now();
    log("scan", "starting", { profile: profile.id, input });
    progress("scan", `start url=${input}`);
    try {
      await profile.scan(input, ctx);
      progress("scan", `done ${duration(scanStarted)} ${artifactSummary(rootDir, ["original.html", "facts.json", "axe.json", join("screenshots", "original.png")].map(path => join(runDir, path)))}`);
      log("scan", "done", {
        elapsedMs: Date.now() - scanStarted,
        artifacts: ["original.html", "facts.json", "axe.json", join("screenshots", "original.png")].map(path => fileState(rootDir, join(runDir, path)))
      });
    } catch (error) {
      log("scan", "failed", { elapsedMs: Date.now() - scanStarted, error: describe(error) });
      throw error;
    }

    const active = await ensureHarness(rootDir, runDir);
    await promptAgent(active, rootDir, "orchestrator", "brief", runDir, join(runDir, "prompts", "brief.md"), [join(runDir, "brief.md")], profile.briefPrompt(ctx));

    let lastDecision: Decision | undefined;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const iterDir = join(runDir, "iterations", pad(iteration));
      const iterCtx = { rootDir, runDir, iterDir, iteration };
      mkdirSync(join(iterDir, "findings"), { recursive: true });
      mkdirSync(join(iterDir, "votes"), { recursive: true });
      log("iteration", "start", { iteration, iterDir: shown(rootDir, iterDir) });
      progress(`iteration ${iteration}/${maxIterations}`, "start");

      await Promise.all(profile.reviewers.map(reviewer => promptAgent(
        active,
        rootDir,
        reviewer.id,
        "findings",
        runDir,
        join(iterDir, "prompts", `${reviewer.id}-findings.md`),
        [join(iterDir, "findings", `${reviewer.id}.json`)],
        profile.findingsPrompt(iterCtx, reviewer)
      )));

      await promptAgent(active, rootDir, "orchestrator", "aggregate", runDir, join(iterDir, "prompts", "aggregate.md"), [join(iterDir, "aggregate-feedback.json"), join(iterDir, "solver-task.md")], profile.aggregatePrompt(iterCtx));
      await promptAgent(active, rootDir, "fixer", "fix", runDir, join(iterDir, "prompts", "fix.md"), [join(runDir, profile.artifact), join(iterDir, "solver-result.json")], profile.fixPrompt(iterCtx));

      const checkStarted = Date.now();
      log("check", "start", { iteration });
      progress("check", `start iteration=${iteration}`);
      let checks: CheckResult;
      try {
        checks = await profile.check(ctx, iteration);
      } catch (error) {
        log("check", "failed", { iteration, elapsedMs: Date.now() - checkStarted, error: describe(error) });
        throw error;
      }
      writeFileSync(join(iterDir, "checks.json"), JSON.stringify(checks, null, 2));
      log("check", checks.passed ? "passed" : "failed", { iteration, elapsedMs: Date.now() - checkStarted, failures: checks.failures.length, output: fileState(rootDir, join(iterDir, "checks.json")) });
      progress("check", `${checks.passed ? "passed" : "failed"} ${duration(checkStarted)} failures=${checks.failures.length}`);
      for (const failure of checks.failures.slice(0, 3)) progress("check", `failure: ${failure}`);
      if (checks.failures.length > 3) progress("check", `...${checks.failures.length - 3} more failures in checks.json`);

      await Promise.all(profile.reviewers.map(reviewer => promptAgent(
        active,
        rootDir,
        reviewer.id,
        "vote",
        runDir,
        join(iterDir, "prompts", `${reviewer.id}-vote.md`),
        [join(iterDir, "votes", `${reviewer.id}.json`)],
        profile.votePrompt(iterCtx, reviewer)
      )));

      const decisionFile = join(iterDir, "decision.json");
      await promptAgent(active, rootDir, "orchestrator", "decision", runDir, join(iterDir, "prompts", "decision.md"), [decisionFile], profile.decisionPrompt(iterCtx));
      lastDecision = readDecision(decisionFile);
      if (lastDecision.outcome === "continue" && iteration === maxIterations) {
        lastDecision = { ...lastDecision, outcome: "stop_with_risks", reason: `max iterations reached: ${lastDecision.reason}` };
        writeFileSync(decisionFile, JSON.stringify(lastDecision, null, 2));
      }
      log("decision", lastDecision.outcome, lastDecision);
      progress("decision", `outcome=${lastDecision.outcome} checksPass=${lastDecision.checksPass} accepts=${lastDecision.accepts} blocks=${lastDecision.blocks} reason=${quote(lastDecision.reason)}`);
      if (lastDecision.outcome !== "continue") break;
    }

    await promptAgent(active, rootDir, "orchestrator", "report", runDir, join(runDir, "prompts", "report.md"), [join(runDir, "report.md"), join(runDir, "report.html")], profile.reportPrompt(ctx, lastDecision));
    const served = await serve(runDir, profile.artifact);
    log("run", "completed", { decision: lastDecision, artifact: fileState(rootDir, join(runDir, profile.artifact)), report: fileState(rootDir, join(runDir, "report.html")) });
    console.log(`Run: ${shown(rootDir, runDir)}`);
    console.log(`Brief: ${shown(rootDir, join(runDir, "brief.md"))}`);
    console.log(`Report: ${shown(rootDir, join(runDir, "report.html"))}`);
    console.log(`Transformed: ${shown(rootDir, join(runDir, profile.artifact))}`);
    console.log(`Log: ${shown(rootDir, logFile)}`);
    console.log(`Local: http://localhost:${served.port}`);
  } finally {
    if (harness?.close) log("opencode", "closing server", { url: harness.url });
    else if (harness) log("opencode", "leaving external server open", { url: harness.url });
    harness?.close?.();
    harness = undefined;
  }
}

async function ensureHarness(rootDir: string, runDir: string): Promise<Harness> {
  if (harness) {
    log("opencode", "reusing harness", { url: harness.url, sessions: Object.keys(harness.sessions).length });
    return harness;
  }
  const url = process.env.SWARM_OPENCODE_SERVER_URL || process.env.TINY_OPENCODE_SERVER_URL;
  if (url) {
    harness = { client: createOpencodeClient({ baseUrl: url }), url, sessions: {} };
    log("opencode", "using existing server", { url });
    return harness;
  }
  const serverStarted = Date.now();
  log("opencode", "starting server", { hostname: "127.0.0.1", port: 0, timeout: 30000, permission: "allow" });
  const startedServer = await createOpencode({ hostname: "127.0.0.1", port: 0, timeout: 30000, config: { permission: "allow" } }).catch((error: unknown) => {
    log("opencode", "start threw", { elapsedMs: Date.now() - serverStarted, error: describe(error) });
    throw error;
  });
  harness = { client: startedServer.client, url: startedServer.server.url, close: startedServer.server.close, sessions: {} };
  log("opencode", "started server", { url: harness.url, permission: "allow", run: shown(rootDir, runDir), elapsedMs: Date.now() - serverStarted });
  return harness;
}

async function sessionFor(active: Harness, rootDir: string, key: string, runDir: string) {
  if (active.sessions[key]) {
    log("session", "reuse", { key, id: active.sessions[key] });
    return active.sessions[key];
  }
  const model = modelSpec();
  const agent = process.env.SWARM_AGENT || "build";
  const title = `swarm ${key} ${relative(rootDir, runDir)}`;
  const sessionStarted = Date.now();
  log("session", "create start", { key, title, agent, model: modelName(model), variant: model.variant, permission: "allow-all" });
  const result = await active.client.session.create({
    directory: rootDir,
    title,
    agent,
    model: { providerID: model.providerID, id: model.modelID, variant: model.variant },
    permission: allowAll
  }).catch((error: unknown) => {
    log("session", "create threw", { key, elapsedMs: Date.now() - sessionStarted, error: describe(error) });
    throw error;
  });
  if (result.error) {
    log("session", "create error", { key, elapsedMs: Date.now() - sessionStarted, error: describe(result.error) });
    throw new Error(`session create failed: ${describe(result.error)}`);
  }
  active.sessions[key] = result.data.id;
  writeFileSync(join(runDir, "sessions.json"), JSON.stringify(active.sessions, null, 2));
  log("session", "created", { key, id: result.data.id, elapsedMs: Date.now() - sessionStarted, sessionsFile: fileState(rootDir, join(runDir, "sessions.json")) });
  return result.data.id;
}

async function promptAgent(active: Harness, rootDir: string, key: string, phase: string, runDir: string, promptFile: string, outputs: string[], text: string) {
  const sessionID = await sessionFor(active, rootDir, key, runDir);
  const model = modelSpec();
  const agent = process.env.SWARM_AGENT || "build";
  const before = outputTimes(outputs);
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, text);
  const promptStarted = Date.now();
  progress(phase, `${key} session=${shortID(sessionID)} outputs=${outputs.map(outputName).join(",")} prompt=${formatBytes(Buffer.byteLength(text, "utf8"))}`);
  log("prompt", "start", {
    key,
    sessionID,
    method: "promptAsync",
    agent,
    model: modelName(model),
    variant: model.variant,
    promptFile: shown(rootDir, promptFile),
    promptBytes: Buffer.byteLength(text, "utf8"),
    outputs: outputStates(rootDir, outputs, before)
  });
  const result = await active.client.session.promptAsync({
    sessionID,
    directory: rootDir,
    agent,
    model: { providerID: model.providerID, modelID: model.modelID },
    variant: model.variant,
    parts: [{ type: "text", text }]
  }).catch((error: unknown) => {
    log("prompt", "submit threw", { key, sessionID, elapsedMs: Date.now() - promptStarted, error: describe(error) });
    throw error;
  });
  if (result.error) {
    log("prompt", "submit error", { key, sessionID, elapsedMs: Date.now() - promptStarted, error: describe(result.error) });
    throw new Error(`session prompt failed for ${key}: ${describe(result.error)}`);
  }
  log("prompt", "accepted", { key, sessionID, elapsedMs: Date.now() - promptStarted, response: summarizeData(result.data) });
  progress(phase, `${key} accepted in ${duration(promptStarted)}`);
  const finalOutputs = await waitForOutputs(rootDir, outputs, before, { key, phase, sessionID });
  log("prompt", "done", { key, sessionID, elapsedMs: Date.now() - promptStarted, outputs: finalOutputs });
  progress(phase, `${key} done ${duration(promptStarted)} ${formatStates(finalOutputs)}`);
}

function outputTimes(outputs: string[]) {
  return new Map(outputs.map(path => [path, existsSync(path) ? statSync(path).mtimeMs : 0]));
}

function outputStates(rootDir: string, outputs: string[], before: Map<string, number>): OutputState[] {
  return outputs.map(path => {
    const previousMtimeMs = before.get(path) || 0;
    const state = fileState(rootDir, path);
    return { ...state, previousMtimeMs, changed: state.exists && (state.mtimeMs || 0) > previousMtimeMs };
  });
}

function fileState(rootDir: string, path: string) {
  if (!existsSync(path)) return { path: shown(rootDir, path), exists: false };
  const stat = statSync(path);
  return { path: shown(rootDir, path), exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function waitForOutputs(rootDir: string, outputs: string[], before: Map<string, number>, details: { key: string; phase: string; sessionID: string }): Promise<OutputState[]> {
  const timeoutMs = Number(process.env.SWARM_AGENT_TIMEOUT_MS || 900000);
  const logIntervalMs = Math.max(1000, Number(process.env.SWARM_WAIT_LOG_INTERVAL_MS || 10000));
  const startedAt = Date.now();
  let nextLogAt = startedAt + logIntervalMs;
  log("prompt", "wait start", { ...details, timeoutMs, logIntervalMs, outputs: outputStates(rootDir, outputs, before) });
  while (Date.now() - startedAt < timeoutMs) {
    const states = outputStates(rootDir, outputs, before);
    if (states.every(state => state.exists && state.changed)) return states;
    if (Date.now() >= nextLogAt) {
      log("prompt", "wait", { ...details, elapsedMs: Date.now() - startedAt, outputs: states });
      progress(details.phase, `${details.key} ${waitSummary(states, startedAt)}`);
      nextLogAt = Date.now() + logIntervalMs;
    }
    await sleep(500);
  }
  log("prompt", "wait timeout", { ...details, elapsedMs: Date.now() - startedAt, outputs: outputStates(rootDir, outputs, before) });
  throw new Error(`timed out waiting for ${outputs.map(path => shown(rootDir, path)).join(", ")}`);
}

function readDecision(file: string): Decision {
  const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Decision>;
  const outcome = data.outcome;
  if (outcome !== "accept" && outcome !== "continue" && outcome !== "stop_with_risks") throw new Error(`invalid decision outcome: ${file}`);
  if (typeof data.reason !== "string") throw new Error(`invalid decision reason: ${file}`);
  if (typeof data.checksPass !== "boolean") throw new Error(`invalid decision checksPass: ${file}`);
  if (typeof data.accepts !== "number") throw new Error(`invalid decision accepts: ${file}`);
  if (typeof data.blocks !== "number") throw new Error(`invalid decision blocks: ${file}`);
  return { outcome, reason: data.reason, checksPass: data.checksPass, accepts: data.accepts, blocks: data.blocks };
}

async function serve(runDir: string, artifact: string, preferredPort = 5177) {
  const root = resolve(runDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url || "/", "http://local").pathname);
    const latest = latestIteration(runDir);
    const routes: Record<string, string> = {
      "/": existsSync(join(runDir, artifact)) ? artifact : "report.html",
      "/report.html": "report.html",
      "/report.md": "report.md",
      "/brief.md": "brief.md",
      "/checks.json": latest ? join("iterations", latest, "checks.json") : "checks.json"
    };
    const routed = routes[path];
    const file = routed ? join(runDir, routed) : resolve(root, `.${path}`);
    if (!(file === root || file.startsWith(`${root}/`)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.setHeader("Content-Type", contentType(file));
    res.end(readFileSync(file));
  });
  const port = await listen(server, preferredPort).catch((e: NodeJS.ErrnoException) => e.code === "EADDRINUSE" ? listen(server, 0) : Promise.reject(e));
  log("serve", "listening", { port });
  return { server, port };
}

function latestIteration(runDir: string) {
  for (let i = 99; i >= 1; i--) if (existsSync(join(runDir, "iterations", pad(i), "checks.json"))) return pad(i);
  return "";
}

function listen(server: Server, port: number) {
  return new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen((server.address() as { port: number }).port); });
  });
}

function modelSpec() {
  const [providerID, ...rest] = (process.env.SWARM_MODEL || "deepseek/deepseek-v4-flash").split("/");
  return { providerID, modelID: rest.join("/"), variant: process.env.SWARM_VARIANT || "max" };
}

function modelName(model: { providerID: string; modelID: string }) {
  return `${model.providerID}/${model.modelID}`;
}

function log(step: string, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${serialize(data)}`;
  const line = `${new Date().toISOString()} +${Date.now() - started}ms ${step} ${message}${suffix}\n`;
  if (logFile) appendFileSync(logFile, line);
}

function progress(phase: string, message: string) {
  console.log(`[${phase}] ${message}`);
}

function duration(startedAt: number) {
  const ms = Date.now() - startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function artifactSummary(rootDir: string, paths: string[]) {
  return paths.map(path => {
    const state = fileState(rootDir, path);
    return state.exists ? `${outputName(path)}=${formatBytes(state.size)}` : `${outputName(path)}=missing`;
  }).join(" ");
}

function formatStates(states: OutputState[]) {
  return states.map(state => state.exists ? `${outputName(state.path)}=${formatBytes(state.size)}` : `${outputName(state.path)}=missing`).join(" ");
}

function waitSummary(states: OutputState[], startedAt: number) {
  const done = states.filter(state => state.exists && state.changed).map(state => outputName(state.path));
  const missing = states.filter(state => !(state.exists && state.changed)).map(state => outputName(state.path));
  const parts = [`${done.length ? "partial" : "waiting"} ${duration(startedAt)}`];
  if (done.length) parts.push(`done=${done.join(",")}`);
  if (missing.length) parts.push(`missing=${missing.join(",")}`);
  return parts.join(" ");
}

function outputName(path: string) {
  return basename(path);
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return "?B";
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round(bytes / 1024)}KB`;
}

function shortID(id: string) {
  return id.length <= 16 ? id : `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function quote(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(clean.length > 160 ? `${clean.slice(0, 157)}...` : clean);
}

function serialize(data: unknown) {
  try { return JSON.stringify(data); } catch (error) { return JSON.stringify({ unserializable: describe(error) }); }
}

function summarizeData(data: unknown) {
  if (data === null || data === undefined || typeof data !== "object") return data;
  if (Array.isArray(data)) return { type: "array", length: data.length };
  const obj = data as Record<string, unknown>;
  const summary: Record<string, unknown> = { keys: Object.keys(obj).slice(0, 20) };
  for (const key of ["id", "sessionID", "messageID", "role", "type", "status"]) {
    if (key in obj) summary[key] = obj[key];
  }
  if ("time" in obj) summary.time = obj.time;
  return summary;
}

function shown(rootDir: string, path: string) {
  return relative(rootDir, path);
}

function pad(n: number) {
  return String(n).padStart(3, "0");
}

function sleep(ms: number) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function contentType(file: string) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  } as Record<string, string>)[extname(file).toLowerCase()] || "application/octet-stream";
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.cause === undefined ? error.message : `${error.message}; cause: ${describe(error.cause)}`;
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    const code = typeof obj.code === "string" ? ` code=${obj.code}` : "";
    const message = typeof obj.message === "string" ? ` message=${obj.message}` : "";
    const cause = obj.cause === undefined ? "" : ` cause=${describe(obj.cause)}`;
    if (code || message || cause) return `${code}${message}${cause}`.trim();
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}
