#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  startClaudeFullRun,
  startClaudeSnapshots,
  type ClaudeSnapshot,
} from "./claude-backend.js";

/**
 * Browser front end for the swarm.
 *
 * Serves a single page where a user pastes a URL and presses Start. Each run is
 * launched as a child `dist/index.js --json-events` process — the same runner
 * the Rust TUI drives — so a run can be cleanly stopped by killing that child.
 * The child's event stream is relayed to the browser over Server-Sent Events.
 *
 * When `SWARM_BACKEND=claude`, a run is instead handed to a pre-launched
 * Claude Code terminal — see src/claude-backend.ts.
 */

/** Generation backend for the web UI, from `SWARM_BACKEND` (default opencode). */
function swarmBackend(): "opencode" | "claude" {
  return process.env.SWARM_BACKEND?.trim().toLowerCase() === "claude"
    ? "claude"
    : "opencode";
}

const rootDir = fileURLToPath(new URL("..", import.meta.url));
loadLocalEnv();
const port = Number(process.env.SWARM_WEB_PORT || 5180);
const pagePath = join(rootDir, "web", "index.html");
const fontsDir = join(rootDir, "web", "fonts");
const runnerPath = join(rootDir, "dist", "index.js");
const require = createRequire(import.meta.url);

type BrowserSyncModule = {
  create(name?: string): BrowserSyncInstance;
};
type BrowserSyncInstance = {
  init(options: Record<string, unknown>, cb: (error?: Error) => void): void;
  exit(): void;
};

/**
 * `browser-sync` is only used to live-reload the opencode artifact. Load it
 * lazily so the Claude backend can run on machines (or installs) where the
 * dependency isn't present.
 */
let browserSync: BrowserSyncModule | null = null;
function loadBrowserSync(): BrowserSyncModule | null {
  if (browserSync) return browserSync;
  try {
    browserSync = require("browser-sync") as BrowserSyncModule;
    return browserSync;
  } catch (error) {
    broadcast({
      type: "log",
      text: `Live preview disabled: browser-sync is not installed (${describe(error)}).`,
    });
    return null;
  }
}

/** Lifecycle of the single run this server tracks at a time. */
type RunStatus = "idle" | "running" | "completed" | "failed" | "stopped";

/** A swarm event from the runner, or a synthetic one this server adds. */
type RunEvent = { type: string; [key: string]: unknown };

/** Live state for the current (or most recent) run, replayed to new clients. */
type RunState = {
  status: RunStatus;
  target: string;
  /** Epoch ms the run started, so the browser can show a true elapsed clock. */
  startedAt: number;
  /** Every event seen so far this run, so a late browser can catch up. */
  events: RunEvent[];
  /** Absolute path to this run's directory; claude backend uses it for /artifact/. */
  runDir?: string;
  /** Snapshots produced by phase 1 of the claude backend. */
  snapshots?: ClaudeSnapshot[];
  /** Style key the user picked after seeing the snapshots. */
  style?: string;
};

const run: RunState = { status: "idle", target: "", startedAt: 0, events: [] };
const clients = new Set<ServerResponse>();
let child: ChildProcess | null = null;
let preview: BrowserSyncInstance | null = null;
let previewRunDir = "";
let previewArtifact = "transformed.html";
let previewStarting = false;
let stopping = false;

const server = createServer((req, res) => {
  const path = new URL(req.url || "/", "http://local").pathname;
  if (req.method === "GET" && path === "/") return servePage(res);
  if (req.method === "GET" && path.startsWith("/fonts/"))
    return serveFont(res, path);
  if (req.method === "GET" && path === "/events") return serveEvents(res);
  if (req.method === "POST" && path === "/run") return startRun(req, res);
  if (req.method === "POST" && path === "/stop") return stopRun(res);
  if (req.method === "POST" && path === "/pick") return pickStyle(req, res);
  if (req.method === "GET" && path.startsWith("/artifact/"))
    return serveArtifact(res, path);
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Swarm web UI ready: http://localhost:${port}`);
});

// SSE connections sit idle for long stretches while agents think; a periodic
// comment keeps the socket (and any proxy in front of it) from timing out.
setInterval(() => {
  for (const client of clients) {
    try {
      client.write(": keep-alive\n\n");
    } catch {
      clients.delete(client);
    }
  }
}, 20000).unref();

// Never leave an orphaned swarm behind if the server itself is shut down.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killChild("SIGKILL");
    stopPreview();
    process.exit(0);
  });
}

/** Serves the static single-page UI. */
function servePage(res: ServerResponse) {
  if (!existsSync(pagePath)) {
    res
      .writeHead(500, { "Content-Type": "text/plain" })
      .end("web/index.html is missing");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(pagePath));
}

/** Serves a self-hosted woff2 font file from web/fonts/. */
function serveFont(res: ServerResponse, path: string) {
  const name = path.slice("/fonts/".length);
  const file = join(fontsDir, name);
  if (!/^[a-z0-9._-]+\.woff2$/i.test(name) || !existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "font/woff2",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(readFileSync(file));
}

/**
 * Opens a Server-Sent Events stream: a `snapshot` of the current run, a replay
 * of every event so far, then live events as they happen.
 */
function serveEvents(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  send(res, {
    type: "snapshot",
    status: run.status,
    target: run.target,
    startedAt: run.startedAt,
  });
  for (const event of run.events) send(res, event);
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

/** Validates the submitted URL and launches a run as a child process. */
function startRun(req: IncomingMessage, res: ServerResponse) {
  if (run.status === "running") {
    respondJson(res, 409, { error: "A run is already in progress." });
    return;
  }
  readBody(req)
    .then((body) => {
      const target = parseUrl(body);
      if (!target) {
        respondJson(res, 400, {
          error: "Enter a valid http:// or https:// URL.",
        });
        return;
      }
      run.status = "running";
      run.target = target;
      run.startedAt = Date.now();
      run.events.length = 0;
      run.runDir = undefined;
      run.snapshots = undefined;
      run.style = undefined;
      stopping = false;
      stopPreview();
      previewRunDir = "";
      previewArtifact = "transformed.html";
      respondJson(res, 200, { ok: true });
      broadcast({ type: "web_start", target, startedAt: run.startedAt });
      if (swarmBackend() === "claude") {
        const runDir = createRunDir();
        run.runDir = runDir;
        startClaudeSnapshots({
          target,
          rootDir,
          runDir,
          emit: broadcast,
          onSnapshotsReady: handleSnapshotsReady,
          onFail: (message) => finish("failed", message),
        });
      } else {
        spawnRun(target);
      }
    })
    .catch(() => respondJson(res, 400, { error: "Could not read the request." }));
}

/** Spawns the runner and relays its stdout/stderr to connected browsers. */
function spawnRun(target: string) {
  // `detached` puts the runner in its own process group so a stop can take
  // down everything it spawns (notably the opencode server), not just itself.
  child = spawn(process.execPath, [runnerPath, "--json-events", target], {
    cwd: rootDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // stdout carries one JSON event per line; stray non-JSON lines become logs.
  readLines(child.stdout, (line) => {
    const event = parseEvent(line) ?? { type: "log", text: line };
    broadcast(event);
    handleRunnerEvent(event);
  });
  readLines(child.stderr, (line) => broadcast({ type: "log", text: line }));
  child.on("error", (error) => {
    broadcast({ type: "error", message: describe(error) });
    finish("failed", describe(error));
  });
  child.on("exit", (code, signal) => {
    if (stopping) finish("stopped");
    else if (code === 0) finish("completed");
    else finish("failed", `runner exited (${code ?? signal})`);
  });
}

/** Stops the in-progress run by killing the child process. */
function stopRun(res: ServerResponse) {
  if (run.status !== "running") {
    respondJson(res, 409, { error: "No run is in progress." });
    return;
  }
  if (swarmBackend() === "claude") {
    // The Claude agent runs in the user's own terminal; this server has no
    // child process to kill. TODO(claude-backend): wire a real cancel, e.g. a
    // stop marker the playbook checks.
    respondJson(res, 200, { ok: true });
    finish("stopped", "Stopping the Claude terminal agent is not wired up yet.");
    return;
  }
  if (!child) {
    respondJson(res, 409, { error: "No run is in progress." });
    return;
  }
  stopping = true;
  const target = child;
  killChild("SIGTERM");
  stopPreview();
  // Escalate if the runner doesn't wind down its agents promptly.
  setTimeout(() => {
    if (child === target) killChild("SIGKILL");
  }, 4000).unref();
  respondJson(res, 200, { ok: true });
}

/** Starts live preview only after scan has seeded the run artifact. */
function handleRunnerEvent(event: RunEvent) {
  if (event.type === "run_start") {
    previewRunDir = typeof event.runDirAbsolute === "string"
      ? event.runDirAbsolute
      : "";
    previewArtifact = typeof event.artifact === "string"
      ? event.artifact
      : "transformed.html";
    return;
  }
  if (
    event.type === "phase" &&
    event.phase === "scan" &&
    event.status === "completed"
  ) {
    startPreview();
  }
}

function startPreview() {
  if (preview || previewStarting || !previewRunDir) return;
  const bs = loadBrowserSync();
  if (!bs) return;
  previewStarting = true;
  const port = Number(process.env.SWARM_LIVE_PREVIEW_PORT || 5178);
  const path = previewArtifact.split("/").map(encodeURIComponent).join("/");
  const localUrl = `http://localhost:${port}/${path}`;
  const started = bs.create("swarm-live-preview");
  preview = started;
  broadcast({ type: "live_preview", status: "starting", localUrl, port });
  started.init(
    {
      server: previewRunDir,
      files: [join(previewRunDir, previewArtifact)],
      startPath: previewArtifact,
      port,
      listen: "127.0.0.1",
      open: false,
      ui: false,
      notify: false,
      ghostMode: false,
      reloadDebounce: 250,
      logLevel: "silent",
    },
    (error?: Error) => {
      previewStarting = false;
      if (preview !== started) return;
      if (!error) {
        broadcast({ type: "live_preview", status: "ready", localUrl, port });
        return;
      }
      preview = null;
      broadcast({
        type: "live_preview",
        status: "failed",
        localUrl,
        port,
        message: describe(error),
      });
    },
  );
}

function stopPreview() {
  const target = preview;
  preview = null;
  previewStarting = false;
  if (!target) return;
  try {
    target.exit();
  } catch {
    /* already gone */
  }
}

/** Signals the runner's whole process group, falling back to the child alone. */
function killChild(signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    // Negative PID targets the process group created by `detached: true`.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Records the terminal run status and tells every client the run is over. */
function finish(status: RunStatus, message?: string) {
  if (run.status !== "running") return;
  run.status = status;
  child = null;
  broadcast({
    type: "web_done",
    status,
    message,
    elapsedMs: Date.now() - run.startedAt,
  });
}

/**
 * Cap on the replay buffer. A long run can emit thousands of log lines; an
 * unbounded `run.events` would mean every late-joining or reconnecting client
 * has to chew through all of them, which is what made the activity log look
 * frozen in long Claude runs.
 *
 * Structural events (anything that's not a plain `log`) are kept regardless,
 * so the picker, run_complete, web_done, etc. still replay correctly — only
 * the noisy log tail is trimmed.
 */
const REPLAY_LOG_CAP = 400;

/** Appends an event to the run history and pushes it to every live client. */
function broadcast(event: RunEvent) {
  run.events.push(event);
  trimReplayBuffer();
  for (const client of clients) send(client, event);
}

function trimReplayBuffer() {
  let logCount = 0;
  for (const event of run.events) if (event.type === "log") logCount++;
  if (logCount <= REPLAY_LOG_CAP) return;
  let toDrop = logCount - REPLAY_LOG_CAP;
  const kept: RunEvent[] = [];
  for (const event of run.events) {
    if (event.type === "log" && toDrop > 0) {
      toDrop--;
      continue;
    }
    kept.push(event);
  }
  run.events.length = 0;
  run.events.push(...kept);
}

/** Writes one SSE `data:` frame. */
function send(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Sends a JSON response with the given status code. */
function respondJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** Splits a stream into trimmed, non-empty lines. */
function readLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) onLine(line);
  });
}

/** Parses a line as a swarm event, or returns null if it is not one. */
function parseEvent(line: string): RunEvent | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value && typeof value === "object" && typeof value.type === "string") {
      return value as RunEvent;
    }
  } catch {
    /* not JSON — treated as a plain log line by the caller */
  }
  return null;
}

/** Buffers a request body, rejecting anything implausibly large for a URL. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > 100_000) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Extracts and validates the `url` field from a JSON request body. */
function parseUrl(body: string): string | undefined {
  let raw = "";
  try {
    raw = String((JSON.parse(body) as { url?: unknown }).url ?? "").trim();
  } catch {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Creates a fresh timestamped run directory, matching core.ts's layout. */
function createRunDir(): string {
  const dir = join(
    rootDir,
    "runs",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Phase 1 succeeded. Stash the snapshots on the run state and tell every
 * connected browser to show the picker; the user will POST /pick next.
 */
function handleSnapshotsReady(snapshots: ClaudeSnapshot[]) {
  run.snapshots = snapshots;
  broadcast({
    type: "snapshots_ready",
    snapshots: snapshots.map((s) => ({
      style: s.style,
      name: s.name,
      path: `/artifact/${encodeURIComponent(s.file)}`,
    })),
  });
}

/** POST /pick — the user chose a style; advance to the full-generation phase. */
function pickStyle(req: IncomingMessage, res: ServerResponse) {
  if (run.status !== "running" || !run.runDir) {
    respondJson(res, 409, { error: "No run is in progress." });
    return;
  }
  if (!run.snapshots) {
    respondJson(res, 409, { error: "Snapshots are not ready yet." });
    return;
  }
  if (run.style) {
    respondJson(res, 409, { error: "A style is already chosen for this run." });
    return;
  }
  if (swarmBackend() !== "claude") {
    respondJson(res, 409, { error: "Style picking is only used by the Claude backend." });
    return;
  }
  readBody(req)
    .then((body) => {
      const style = parseStyle(body, run.snapshots);
      if (!style) {
        respondJson(res, 400, { error: "Unknown style." });
        return;
      }
      run.style = style;
      respondJson(res, 200, { ok: true });
      broadcast({ type: "style_picked", style });
      startClaudeFullRun({
        target: run.target,
        rootDir,
        runDir: run.runDir!,
        style,
        emit: broadcast,
        finish,
        localUrlFor: (filename) =>
          `http://localhost:${port}/artifact/${encodeURIComponent(filename)}`,
      });
    })
    .catch(() => respondJson(res, 400, { error: "Could not read the request." }));
}

/** Validates `style` from the request body against the snapshots offered. */
function parseStyle(body: string, snapshots?: ClaudeSnapshot[]): string | undefined {
  let raw = "";
  try {
    raw = String((JSON.parse(body) as { style?: unknown }).style ?? "").trim();
  } catch {
    return undefined;
  }
  if (!raw || !snapshots) return undefined;
  return snapshots.find((s) => s.style === raw)?.style;
}

/** GET /artifact/<filename> — serves a single file from the current run dir. */
function serveArtifact(res: ServerResponse, urlPath: string) {
  const rel = decodeURIComponent(urlPath.slice("/artifact/".length));
  if (
    !run.runDir ||
    !rel ||
    rel.includes("/") ||
    rel.includes("\\") ||
    rel.includes("..")
  ) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  const file = join(run.runDir, rel);
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": artifactContentType(rel) });
  res.end(readFileSync(file));
}

function artifactContentType(name: string): string {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  if (name.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** Loads the project `.env` so a run has the same secrets the CLI would. */
function loadLocalEnv() {
  const envFile = join(rootDir, ".env");
  if (!existsSync(envFile)) return;
  try {
    loadEnvFile(envFile);
  } catch (error) {
    console.error(`[swarm:web] failed to load .env: ${describe(error)}`);
  }
}

/** Reduces a thrown value to a readable message. */
function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
