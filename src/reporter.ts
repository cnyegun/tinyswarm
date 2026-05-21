import { readFileSync } from "node:fs";

type CheckWithAxeViolations = {
  axeViolations?: unknown;
  [key: string]: unknown;
};

/** Machine-readable lifecycle event emitted for terminal dashboards and other frontends. */
export type SwarmEvent = {
  /** Stable event discriminator (e.g. `run_start`, `prompt`, `decision`). */
  type: string;
  /** ISO timestamp added by the reporter event helper. */
  timestamp?: string;
  /** Milliseconds elapsed since this run started, added by the reporter event helper. */
  elapsedMs?: number;
  /** Event-specific data kept intentionally open for profile-specific check fields. */
  [key: string]: unknown;
};

/** Optional presentation hooks used by CLIs and TUIs without moving UI state into core. */
export type SwarmReporter = {
  /** Receives the same summary lines the default CLI prints today. */
  line?(text: string): void;
  /** Receives human-readable progress updates. */
  progress?(phase: string, message: string): void;
  /** Receives structured events for machine consumers such as the Rust TUI. */
  event?(event: SwarmEvent): void;
};

export type RunSwarmOptions = {
  reporter?: SwarmReporter;
};

export const consoleReporter: SwarmReporter = {
  line: (text) => console.log(text),
  progress: (phase, message) => console.log(`[${phase}] ${message}`),
};

export function line(reporter: SwarmReporter, text: string) {
  reporter.line?.(text);
}

export function emit(
  reporter: SwarmReporter,
  started: number,
  event: SwarmEvent,
) {
  reporter.event?.({
    ...event,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  });
}

export function progress(
  reporter: SwarmReporter,
  started: number,
  phase: string,
  message: string,
) {
  reporter.progress?.(phase, message);
  emit(reporter, started, { type: "progress", phase, message });
}

export function promptOutputEvent(
  key: string,
  phase: string,
  outputs: string[],
): SwarmEvent | undefined {
  if (phase === "findings") {
    const data = readJsonObject(outputs[0]);
    const findings = stringArray(data?.findings);
    return {
      type: "reviewer",
      id: key,
      phase: "findings",
      status: "done",
      risk: stringValue(data?.risk) || "unknown",
      summary: summarizeReviewerText(findings[0] || "no proven issues"),
      findings: findings.length,
    };
  }
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

export function axeViolationCount(checks: CheckWithAxeViolations) {
  return Array.isArray(checks.axeViolations) ? checks.axeViolations.length : undefined;
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

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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
