/**
 * Claude generation backend — two-phase wrapper.
 *
 * The web UI normally generates a page by spawning the opencode swarm as a
 * child process (see `spawnRun` in web.ts). Setting `SWARM_BACKEND=claude`
 * selects this backend instead, which uses the developer's own Claude Code
 * subscription rather than an API key.
 *
 * ## Two phases
 *
 *   1. **Snapshots** ({@link startClaudeSnapshots}). A single fast Claude pass
 *      produces two low-fidelity HTML mockups of the target page — one per
 *      design style in `designs/`. The web UI shows both to the user; they
 *      pick one.
 *
 *   2. **Full generation** ({@link startClaudeFullRun}). With the chosen
 *      style, a full Claude pass rebuilds the front page as an accessible
 *      wrapper: links and images keep pointing at the original site; only the
 *      front page itself is rewritten.
 *
 * Each phase: build a short prompt that points the terminal agent at the
 * matching playbook (`claude-web-snapshot.md` / `claude-web-generation.md`),
 * type it into the pre-launched Claude terminal via
 * `scripts/claude-paste-prompt.sh`, then poll the run directory for the
 * agent's completion marker.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ─── shared types ──────────────────────────────────────────────────────────

/** SSE event sink (web.ts's `broadcast`). */
type Emit = (event: { type: string; [key: string]: unknown }) => void;

/** One snapshot produced by phase 1, as the agent reports it. */
export type ClaudeSnapshot = {
  /** Style key, matching a file in `designs/` (e.g. `"government"`). */
  style: string;
  /** Human-readable label for the picker UI. */
  name: string;
  /** Filename inside the run directory (e.g. `"snapshot-corporate.html"`). */
  file: string;
};

export type StartClaudeSnapshotsOptions = {
  /** The page URL the user submitted. */
  target: string;
  /** Absolute project root. */
  rootDir: string;
  /** Absolute path to the existing run directory; created by web.ts. */
  runDir: string;
  /** Broadcasts an event to every connected browser. */
  emit: Emit;
  /** Called when the snapshot agent finished; advances to the picker UI. */
  onSnapshotsReady: (snapshots: ClaudeSnapshot[]) => void;
  /** Called on any phase-1 failure (e.g. timeout, error marker). */
  onFail: (message: string) => void;
};

export type StartClaudeFullRunOptions = {
  target: string;
  rootDir: string;
  /** The same run directory used by phase 1. */
  runDir: string;
  /** Style key the user chose (must map to `designs/<style>.md`). */
  style: string;
  emit: Emit;
  /** Settles the run on the web side. */
  finish: (status: "completed" | "failed", message?: string) => void;
  /**
   * Builds the public URL for a file in the run dir, so the browser can open
   * the regenerated page from the "ready" message.
   */
  localUrlFor: (filename: string) => string;
};

// ─── shared constants ──────────────────────────────────────────────────────

const PASTE_SCRIPT = join("scripts", "claude-paste-prompt.sh");
const SNAPSHOT_PLAYBOOK = "claude-web-snapshot.md";
const GENERATION_PLAYBOOK = "claude-web-generation.md";
const POLL_INTERVAL_MS = 2000;

/** Built-in design styles offered by the snapshot phase. */
const SNAPSHOT_DESIGNS: ReadonlyArray<{ key: string; name: string; file: string }> = [
  { key: "government", name: "Government", file: "designs/government.md" },
  { key: "corporate",  name: "Corporate",  file: "designs/corporate.md" },
];

function snapshotTimeoutMs(): number {
  return Math.max(60_000, Number(process.env.SWARM_SNAPSHOT_TIMEOUT_MS || 300_000));
}
function fullTimeoutMs(): number {
  return Math.max(60_000, Number(process.env.SWARM_AGENT_TIMEOUT_MS || 900_000));
}

// ─── phase 1 — snapshots ───────────────────────────────────────────────────

/**
 * Phase 1: ask the Claude terminal agent to produce a quick mockup of the
 * target page in every style in {@link SNAPSHOT_DESIGNS}. Fire-and-forget;
 * progress and outcome are reported through `emit`, `onSnapshotsReady`, and
 * `onFail`.
 */
export function startClaudeSnapshots(opts: StartClaudeSnapshotsOptions): void {
  const { target, rootDir, runDir, emit, onSnapshotsReady, onFail } = opts;
  try {
    const prompt = buildSnapshotPrompt(target, rootDir, runDir);
    const promptFile = join(runDir, "claude-prompt.txt");
    writeFileSync(promptFile, `${prompt}\n`);

    emit({
      type: "log",
      text: `Snapshot phase: run directory ${relative(rootDir, runDir)}`,
    });
    warnIfMissing(join(rootDir, SNAPSHOT_PLAYBOOK), emit, "snapshot playbook");
    for (const d of SNAPSHOT_DESIGNS) {
      warnIfMissing(join(rootDir, d.file), emit, `design file (${d.key})`);
    }

    pastePrompt(rootDir, promptFile, prompt, emit, "Snapshot phase");
    watchForMarker({
      marker: join(runDir, "snapshots-done.json"),
      timeoutMs: snapshotTimeoutMs(),
      emit,
      label: "Snapshot phase",
      waitingMessage: "waiting for the terminal agent to produce the two snapshots…",
      onFound: (data) => {
        const errorText = typeof data.error === "string" ? data.error : undefined;
        if (errorText) {
          onFail(`Snapshot agent reported an error: ${errorText}`);
          return;
        }
        const snapshots = parseSnapshotList(data);
        if (snapshots.length === 0) {
          onFail("Snapshot agent did not report any snapshots.");
          return;
        }
        emit({
          type: "log",
          text: `Snapshot phase: ${snapshots.length} snapshots ready.`,
        });
        onSnapshotsReady(snapshots);
      },
      onTimeout: () =>
        onFail(
          `Snapshot phase: timed out after ${Math.round(snapshotTimeoutMs() / 1000)}s ` +
            `waiting for snapshots-done.json.`,
        ),
    });
  } catch (error) {
    onFail(`Snapshot phase failed to start: ${describe(error)}`);
  }
}

/** Reads and validates the `snapshots` array from `snapshots-done.json`. */
function parseSnapshotList(data: Record<string, unknown>): ClaudeSnapshot[] {
  const raw = Array.isArray(data.snapshots) ? data.snapshots : [];
  const out: ClaudeSnapshot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const style = typeof r.style === "string" ? r.style : "";
    const file = typeof r.file === "string" ? r.file : "";
    if (!style || !file) continue;
    const defined = SNAPSHOT_DESIGNS.find((d) => d.key === style);
    const name = typeof r.name === "string" && r.name
      ? r.name
      : defined?.name || style;
    out.push({ style, name, file });
  }
  return out;
}

function buildSnapshotPrompt(target: string, rootDir: string, runDir: string): string {
  const designsList = SNAPSHOT_DESIGNS
    .map((d) => `${d.key}=${join(rootDir, d.file)}`)
    .join(", ");
  const filesList = SNAPSHOT_DESIGNS
    .map((d) => join(runDir, `snapshot-${d.key}.html`))
    .join(" and ");
  return [
    `Read ${join(rootDir, SNAPSHOT_PLAYBOOK)} and follow it to produce two quick style snapshots.`,
    `Target URL: ${target}.`,
    `Run directory: ${runDir}.`,
    `Designs: ${designsList}.`,
    `Write ${filesList}, then ${join(runDir, "snapshots-done.json")}.`,
  ].join(" ");
}

// ─── phase 2 — full generation ─────────────────────────────────────────────

/**
 * Phase 2: with the user's chosen style, ask the terminal agent to produce
 * the full accessible wrapper. Fire-and-forget; progress is reported through
 * `emit`, and the run is settled via `finish`.
 */
export function startClaudeFullRun(opts: StartClaudeFullRunOptions): void {
  const { target, rootDir, runDir, style, emit, finish, localUrlFor } = opts;
  try {
    const styleFile = `designs/${style}.md`;
    const styleAbs = join(rootDir, styleFile);
    if (!existsSync(styleAbs)) {
      finish("failed", `Generation phase: style file not found: ${styleFile}`);
      return;
    }

    const prompt = buildFullPrompt(target, rootDir, runDir, styleAbs);
    const promptFile = join(runDir, "claude-prompt-generation.txt");
    writeFileSync(promptFile, `${prompt}\n`);

    emit({
      type: "log",
      text: `Generation phase: style ${style}, run directory ${relative(rootDir, runDir)}`,
    });
    warnIfMissing(join(rootDir, GENERATION_PLAYBOOK), emit, "generation playbook");

    pastePrompt(rootDir, promptFile, prompt, emit, "Generation phase");
    watchForMarker({
      marker: join(runDir, "claude-done.json"),
      timeoutMs: fullTimeoutMs(),
      emit,
      label: "Generation phase",
      waitingMessage: "waiting for the terminal agent to finish the full rewrite…",
      onFound: (data) => {
        const outcome = typeof data.outcome === "string" ? data.outcome : "done";
        const reason = typeof data.reason === "string" ? data.reason : "";
        if (outcome === "error") {
          emit({ type: "log", text: `Generation phase: agent reported an error — ${reason}` });
          finish("failed", reason || "The Claude agent reported an error.");
          return;
        }
        const outputFile = "transformed.html";
        const localUrl = localUrlFor(outputFile);
        emit({
          type: "log",
          text: `Generation phase: done — output at ${relative(rootDir, join(runDir, outputFile))}`,
        });
        emit({
          type: "run_complete",
          runDir: relative(rootDir, runDir),
          outputPath: relative(rootDir, join(runDir, outputFile)),
          localUrl,
          decision: { outcome, reason },
        });
        finish("completed");
      },
      onTimeout: () =>
        finish(
          "failed",
          `Generation phase: timed out after ${Math.round(fullTimeoutMs() / 1000)}s ` +
            `waiting for claude-done.json.`,
        ),
    });
  } catch (error) {
    finish("failed", `Generation phase failed to start: ${describe(error)}`);
  }
}

function buildFullPrompt(
  target: string,
  rootDir: string,
  runDir: string,
  styleAbs: string,
): string {
  return [
    `Read ${join(rootDir, GENERATION_PLAYBOOK)} and follow it to regenerate a web page as an accessible wrapper.`,
    `Target URL: ${target}.`,
    `Run directory: ${runDir}.`,
    `Style file: ${styleAbs}.`,
    `Write the regenerated page to ${join(runDir, "transformed.html")}`,
    `and finish by writing ${join(runDir, "claude-done.json")}.`,
  ].join(" ");
}

// ─── shared: paste, watch, helpers ─────────────────────────────────────────

/**
 * Runs the paste script so the prompt lands in the pre-launched terminal.
 *
 * If the script is missing or fails (e.g. `xdotool` is not installed), this
 * does not abort the phase: it emits the prompt so the user can paste it by
 * hand, and the watcher keeps polling for the marker either way.
 */
function pastePrompt(
  rootDir: string,
  promptFile: string,
  prompt: string,
  emit: Emit,
  label: string,
): void {
  const scriptPath = join(rootDir, PASTE_SCRIPT);
  if (!existsSync(scriptPath)) {
    emit({ type: "log", text: `${label}: ${PASTE_SCRIPT} is missing` });
    emitManualPrompt(label, prompt, emit);
    return;
  }

  emit({ type: "log", text: `${label}: pasting prompt into the terminal…` });
  const child = spawn("bash", [scriptPath, promptFile], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    emit({ type: "log", text: `${label}: paste script error — ${describe(error)}` });
    emitManualPrompt(label, prompt, emit);
  });
  child.on("exit", (code) => {
    if (code === 0) {
      emit({
        type: "log",
        text: `${label}: ${stdout.trim() || "prompt sent to the terminal"}`,
      });
    } else {
      emit({
        type: "log",
        text: `${label}: paste failed (exit ${code ?? "?"})${
          stderr.trim() ? ` — ${stderr.trim()}` : ""
        }`,
      });
      emitManualPrompt(label, prompt, emit);
    }
  });
}

function emitManualPrompt(label: string, prompt: string, emit: Emit): void {
  emit({
    type: "log",
    text: `${label}: paste this into your Claude terminal manually -> ${prompt}`,
  });
}

/**
 * Polls a marker file. Calls `onFound` once it appears (with the parsed JSON
 * object, or `{}` on parse failure), or `onTimeout` once `timeoutMs` elapses.
 */
function watchForMarker(opts: {
  marker: string;
  timeoutMs: number;
  emit: Emit;
  label: string;
  waitingMessage: string;
  onFound: (data: Record<string, unknown>) => void;
  onTimeout: () => void;
}): void {
  const { marker, timeoutMs, emit, label, waitingMessage, onFound, onTimeout } = opts;
  const deadline = Date.now() + timeoutMs;
  emit({ type: "log", text: `${label}: ${waitingMessage}` });

  const poll = setInterval(() => {
    if (existsSync(marker)) {
      clearInterval(poll);
      onFound(readJson(marker));
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(poll);
      onTimeout();
    }
  }, POLL_INTERVAL_MS);
  poll.unref();
}

function readJson(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function warnIfMissing(path: string, emit: Emit, label: string): void {
  if (!existsSync(path)) {
    emit({ type: "log", text: `Claude backend: warning — ${label} is missing at ${path}` });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
