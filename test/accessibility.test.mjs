import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessibilityProfile } from "../dist/accessibility.js";

const image =
  '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">';

test("accessibility scan writes compact axe and full axe sidecar", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "tiny-rewrite-a11y-scan-"));
  const images = Array.from({ length: 40 }, () => image).join("");
  const page = `<!doctype html><html lang="en"><head><title>Scan compact</title></head><body><main><h1>Scan compact</h1>${images}</main></body></html>`;
  const server = await listen((_, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
  });

  try {
    await accessibilityProfile.scan(`http://127.0.0.1:${server.address().port}/`, { rootDir: runDir, runDir });
  } finally {
    server.close();
  }

  const compact = JSON.parse(await readFile(join(runDir, "axe.json"), "utf8"));
  const full = JSON.parse(await readFile(join(runDir, "axe-full.json"), "utf8"));
  const compactViolation = compact.violations.find((item) => item.id === "image-alt");
  const fullViolation = full.violations.find((item) => item.id === "image-alt");

  assert.equal(compactViolation.nodeCount, 40);
  assert.equal(compactViolation.nodes.length, 5);
  assert.equal(compactViolation.omittedNodes, 35);
  assert.equal(fullViolation.nodes.length, 40);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 3);
});

test("accessibility check keeps axe violations compact but actionable", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "tiny-rewrite-a11y-"));
  await mkdir(join(runDir, "screenshots"), { recursive: true });
  await writeFile(join(runDir, "facts.json"), JSON.stringify({ url: "" }));

  const images = Array.from({ length: 40 }, () => image).join("");
  const html = `<!doctype html><html lang="en"><head><title>Compact check</title></head><body><main><h1>Compact check</h1>${images}</main></body></html>`;
  await writeFile(
    join(runDir, "transformed.html"),
    html,
  );

  const result = await accessibilityProfile.check({ rootDir: runDir, runDir }, 1);
  const violation = result.axeViolations.find((item) => item.id === "image-alt");

  assert.equal(violation.nodeCount, 40);
  assert.equal(violation.nodes.length, 5);
  assert.equal(violation.omittedNodes, 35);
  assert.ok(violation.additionalTargets.length > 0);
  assert.ok(violation.nodes[0].target[0].startsWith("img"));
  assert.match(violation.nodes[0].failureSummary, /alt attribute/);

  const full = JSON.parse(
    await readFile(join(runDir, "iterations", "001", "checks-full.json"), "utf8"),
  );
  const fullViolation = full.axeViolations.find((item) => item.id === "image-alt");
  assert.equal(fullViolation.nodes.length, 40);
  assert.ok(JSON.stringify(result).length < JSON.stringify(full).length / 3);
});

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
