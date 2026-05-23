import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
  type PermissionRuleset,
} from "@opencode-ai/sdk/v2";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { promptOutputEvent } from "./reporter.js";
import {
  type Decision,
  type RunState,
  describe,
  duration,
  emit,
  fileState,
  formatBytes,
  log,
  outputName,
  progress,
  shortID,
  shown,
  sleep,
} from "./core.js";

/**
 * Holds the live opencode server connection and the session ID registry.
 * Created per swarm run by {@link ensureHarness} and torn down in the
 * `finally` block of `runSwarm` when this process owns the server.
 */
export type AgentHarness = {
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
  /** Whether the configured opencode models were already checked for this harness. */
  modelsValidated?: boolean;
};

type FileOutputState = {
  path: string;
  exists: boolean;
  changed: boolean;
  previousMtimeMs: number;
  mtimeMs?: number;
  size?: number;
};

/** Grants every permission to every file pattern; applied to all swarm sessions. */
const allowAll: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
];

/**
 * Releases only the opencode server owned by this run.
 *
 * External servers are deliberately left running; locally-created servers are
 * closed from runSwarm's finally block even when an earlier phase throws.
 */
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
 * 1. Reuse the current run's harness if already initialized.
 * 2. Connect to an externally-managed server via `SWARM_OPENCODE_SERVER_URL`
 *    (or the legacy alias `TINY_OPENCODE_SERVER_URL`).
 * 3. Spawn a new in-process opencode server on an OS-assigned port.
 */
export async function ensureHarness(run: RunState): Promise<AgentHarness> {
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
 * Fails fast when SWARM_MODEL points at a provider/model that opencode cannot use.
 *
 * opencode accepts `promptAsync` before model execution begins; without this preflight,
 * a provider/model error can surface only in opencode's own logs while runSwarm keeps
 * polling for output files that will never be written.
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
        `If using LLM Providers, set api key in ${shown(run.rootDir, join(run.rootDir, ".env"))} or export it before starting an external opencode server.`,
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
 * Returns the opencode session ID for the given logical agent key,
 * creating a new session if one does not yet exist for this run.
 *
 * Session IDs are persisted to `sessions.json` in the run directory so
 * that progress can be inspected externally while the swarm is running.
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
 * files exist and have changed on disk.
 *
 * The prompt text is persisted to `promptFile` before submission so that the
 * exact instruction sent to each agent is reproducible from the run directory.
 * Output detection is file-system based: the function polls for each path in
 * `outputs` and considers it done when the file exists with a newer `mtimeMs`
 * than before the prompt was submitted.
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
  const usage = await readPromptUsage(harness, sessionID, {
    messageID,
    promptStarted,
  });
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

// Adds one prompt's usage to the running totals on RunState. Total is kept
// as a flat sum; per-agent breakdown buckets reviewers by their `key` so the
// roll-up shows orchestrator vs fixer vs each reviewer cost individually.
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
 * Resolves the model spec for one agent key. Orchestrator/fixer use `max`
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
 * Per-prompt token + cost usage extracted from one opencode AssistantMessage.
 * `cost` is in USD as reported by the provider; tokens are split into the
 * fields opencode exposes. All values default to 0 when a provider omits them.
 */
export type PromptUsage = {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
};

/**
 * Fetches the assistant message for the just-completed prompt and returns its
 * cost+tokens. Returns undefined on any failure (network, SDK error, message
 * not yet present) — usage telemetry is best-effort and never blocks a run.
 */
async function readPromptUsage(
  harness: AgentHarness,
  sessionID: string,
  details: { messageID?: string; promptStarted: number },
): Promise<PromptUsage | undefined> {
  const result = await harness.client.session
    .messages({ sessionID, directory: undefined, limit: 20 })
    .catch(() => undefined);
  if (!result || result.error || !Array.isArray(result.data)) return undefined;
  const entries = result.data.filter(
    (item: { info?: { id?: string; role?: string; time?: { created?: number; completed?: number } } }) =>
      item?.info?.role === "assistant",
  );
  const entry = details.messageID
    ? entries.find((item) => item.info?.id === details.messageID)
    : latestAssistantEntry(entries, details.promptStarted);
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

function latestAssistantEntry<
  T extends { info?: { time?: { created?: number; completed?: number } } },
>(entries: T[], promptStarted: number): T | undefined {
  const recent = entries.filter((entry) => {
    const time = messageTimeMs(entry);
    return time === undefined || time >= promptStarted - 1000;
  });
  return [...(recent.length ? recent : entries)]
    .sort((a, b) => (messageTimeMs(b) || 0) - (messageTimeMs(a) || 0))[0];
}

function messageTimeMs(entry: { info?: { time?: { created?: number; completed?: number } } }) {
  const raw = entry.info?.time?.completed ?? entry.info?.time?.created;
  if (typeof raw !== "number") return undefined;
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
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
