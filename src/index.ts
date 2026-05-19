#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { accessibilityProfile } from "./accessibility.js";
import { runSwarm } from "./core.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const input = args[0] === "accessibility" ? args[1] : args[0];

if (!input) {
  console.error("Usage: npm run swarm -- accessibility <url>");
  process.exit(1);
}

runSwarm(accessibilityProfile, input, rootDir).catch((e) => {
  console.error(`[swarm] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
