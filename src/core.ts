import { createOpencode, createOpencodeClient, type OpencodeClient, type PermissionRuleset } from "@opencode-ai/sdk/v2";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";

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

const allowAll: PermissionRuleset = [{ permission: "*", pattern: "*", action: "allow" }];
let harness: Harness | undefined;
let logFile = "";
let started = Date.now();

export async function runSwarm(profile: SwarmProfile, input: string, rootDir: string) {
  const maxIterations = Math.max(1, Number(process.env.SWARM_MAX_ITERATIONS || 2));
  const runDir = join(rootDir, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });
  logFile = join(runDir, "swarm.log");
  started = Date.now();

  try {
    const ctx = { rootDir, runDir };
    log("scan", "starting", { profile: profile.id, input });
    await profile.scan(input, ctx);

    const active = await ensureHarness(rootDir, runDir);
    await promptAgent(active, rootDir, "orchestrator", runDir, join(runDir, "prompts", "brief.md"), [join(runDir, "brief.md")], profile.briefPrompt(ctx));

    let lastDecision: Decision | undefined;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const iterDir = join(runDir, "iterations", pad(iteration));
      const iterCtx = { rootDir, runDir, iterDir, iteration };
      mkdirSync(join(iterDir, "findings"), { recursive: true });
      mkdirSync(join(iterDir, "votes"), { recursive: true });

      await Promise.all(profile.reviewers.map(reviewer => promptAgent(
        active,
        rootDir,
        reviewer.id,
        runDir,
        join(iterDir, "prompts", `${reviewer.id}-findings.md`),
        [join(iterDir, "findings", `${reviewer.id}.json`)],
        profile.findingsPrompt(iterCtx, reviewer)
      )));

      await promptAgent(active, rootDir, "orchestrator", runDir, join(iterDir, "prompts", "aggregate.md"), [join(iterDir, "aggregate-feedback.json"), join(iterDir, "solver-task.md")], profile.aggregatePrompt(iterCtx));
      await promptAgent(active, rootDir, "fixer", runDir, join(iterDir, "prompts", "fix.md"), [join(iterDir, "solver-result.json")], profile.fixPrompt(iterCtx));

      const checks = await profile.check(ctx, iteration);
      writeFileSync(join(iterDir, "checks.json"), JSON.stringify(checks, null, 2));
      log("check", checks.passed ? "passed" : "failed", { iteration, failures: checks.failures.length });

      await Promise.all(profile.reviewers.map(reviewer => promptAgent(
        active,
        rootDir,
        reviewer.id,
        runDir,
        join(iterDir, "prompts", `${reviewer.id}-vote.md`),
        [join(iterDir, "votes", `${reviewer.id}.json`)],
        profile.votePrompt(iterCtx, reviewer)
      )));

      const decisionFile = join(iterDir, "decision.json");
      await promptAgent(active, rootDir, "orchestrator", runDir, join(iterDir, "prompts", "decision.md"), [decisionFile], profile.decisionPrompt(iterCtx));
      lastDecision = readDecision(decisionFile);
      if (lastDecision.outcome === "continue" && iteration === maxIterations) {
        lastDecision = { ...lastDecision, outcome: "stop_with_risks", reason: `max iterations reached: ${lastDecision.reason}` };
        writeFileSync(decisionFile, JSON.stringify(lastDecision, null, 2));
      }
      log("decision", lastDecision.outcome, lastDecision);
      if (lastDecision.outcome !== "continue") break;
    }

    await promptAgent(active, rootDir, "orchestrator", runDir, join(runDir, "prompts", "report.md"), [join(runDir, "report.md"), join(runDir, "report.html")], profile.reportPrompt(ctx, lastDecision));
    const served = await serve(runDir, profile.artifact);
    console.log(`Run: ${shown(rootDir, runDir)}`);
    console.log(`Brief: ${shown(rootDir, join(runDir, "brief.md"))}`);
    console.log(`Report: ${shown(rootDir, join(runDir, "report.html"))}`);
    console.log(`Transformed: ${shown(rootDir, join(runDir, profile.artifact))}`);
    console.log(`Log: ${shown(rootDir, logFile)}`);
    console.log(`Local: http://localhost:${served.port}`);
  } finally {
    harness?.close?.();
    harness = undefined;
  }
}

async function ensureHarness(rootDir: string, runDir: string): Promise<Harness> {
  if (harness) return harness;
  const url = process.env.SWARM_OPENCODE_SERVER_URL || process.env.TINY_OPENCODE_SERVER_URL;
  if (url) {
    harness = { client: createOpencodeClient({ baseUrl: url }), url, sessions: {} };
    log("opencode", "using existing server", { url });
    return harness;
  }
  const startedServer = await createOpencode({ hostname: "127.0.0.1", port: 0, timeout: 30000, config: { permission: "allow" } });
  harness = { client: startedServer.client, url: startedServer.server.url, close: startedServer.server.close, sessions: {} };
  log("opencode", "started server", { url: harness.url, permission: "allow", run: shown(rootDir, runDir) });
  return harness;
}

async function sessionFor(active: Harness, rootDir: string, key: string, runDir: string) {
  if (active.sessions[key]) return active.sessions[key];
  const model = modelSpec();
  const result = await active.client.session.create({
    directory: rootDir,
    title: `swarm ${key} ${relative(rootDir, runDir)}`,
    agent: process.env.SWARM_AGENT || "build",
    model: { providerID: model.providerID, id: model.modelID, variant: model.variant },
    permission: allowAll
  });
  if (result.error) throw new Error(`session create failed: ${describe(result.error)}`);
  active.sessions[key] = result.data.id;
  writeFileSync(join(runDir, "sessions.json"), JSON.stringify(active.sessions, null, 2));
  log("session", "created", { key, id: result.data.id });
  return result.data.id;
}

async function promptAgent(active: Harness, rootDir: string, key: string, runDir: string, promptFile: string, outputs: string[], text: string) {
  const sessionID = await sessionFor(active, rootDir, key, runDir);
  const model = modelSpec();
  const before = outputTimes(outputs);
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, text);
  log("prompt", "start", { key });
  const result = await active.client.session.prompt({
    sessionID,
    directory: rootDir,
    agent: process.env.SWARM_AGENT || "build",
    model: { providerID: model.providerID, modelID: model.modelID },
    variant: model.variant,
    parts: [{ type: "text", text }]
  });
  if (result.error) throw new Error(`session prompt failed for ${key}: ${describe(result.error)}`);
  await waitForOutputs(rootDir, outputs, before);
  log("prompt", "done", { key, outputs: outputs.map(path => shown(rootDir, path)) });
}

function outputTimes(outputs: string[]) {
  return new Map(outputs.map(path => [path, existsSync(path) ? statSync(path).mtimeMs : 0]));
}

async function waitForOutputs(rootDir: string, outputs: string[], before: Map<string, number>) {
  const timeoutMs = Number(process.env.SWARM_AGENT_TIMEOUT_MS || 900000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (outputs.every(path => existsSync(path) && statSync(path).mtimeMs > (before.get(path) || 0))) return;
    await sleep(500);
  }
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
  const [providerID, ...rest] = (process.env.SWARM_MODEL || "openai/gpt-5.5").split("/");
  return { providerID, modelID: rest.join("/"), variant: process.env.SWARM_VARIANT || "low" };
}

function log(step: string, message: string, data?: unknown) {
  const line = `${new Date().toISOString()} +${Date.now() - started}ms ${step} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`;
  if (logFile) appendFileSync(logFile, line);
  console.log(`[swarm] ${step}: ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
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

function describe(error: unknown) {
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}
