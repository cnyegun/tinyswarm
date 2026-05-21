#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { accessibilityProfile } from "./accessibility.js";
import { runSwarm, type SwarmEvent, type SwarmReporter } from "./core.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const rawArgs = process.argv.slice(2);
const jsonEvents = rawArgs.includes("--json-events");
const args = rawArgs.filter((arg) => arg !== "--json-events");
const input = args[0] === "accessibility" ? args[1] : args[0];
const reporter = jsonEvents ? jsonReporter() : undefined;

if (!input) {
  if (jsonEvents) writeEvent({ type: "error", message: "missing input" });
  else console.error("Usage: npm run swarm -- accessibility <url>");
  process.exit(1);
}

runSwarm(accessibilityProfile, input, rootDir, { reporter }).catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  if (jsonEvents) writeEvent({ type: "fatal", message });
  else console.error(`[swarm] fatal: ${message}`);
  process.exit(1);
});

function jsonReporter(): SwarmReporter {
  return { event: writeEvent };
}

function writeEvent(event: SwarmEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
