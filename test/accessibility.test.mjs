import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accessibilityProfile } from "../dist/accessibility.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const transparentGif =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

test("dist accessibility build is fresh", async () => {
  const distAccessibility = join(repoRoot, "dist", "accessibility.js");
  const srcAccessibility = join(repoRoot, "src", "accessibility.ts");

  assert.equal(
    existsSync(distAccessibility),
    true,
    "dist/accessibility.js missing; run npm run build before tests",
  );
  const [distStat, srcStat] = await Promise.all([
    stat(distAccessibility),
    stat(srcAccessibility),
  ]);
  assert.ok(
    distStat.mtimeMs >= srcStat.mtimeMs,
    "dist/accessibility.js is older than src/accessibility.ts; run npm run build before tests",
  );
});

test("accessibility scan writes compact axe and full axe sidecar", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "tiny-rewrite-a11y-scan-"));
  const longAttr = "x".repeat(2000);
  const headings = Array.from(
    { length: 70 },
    (_, index) => `<h2>Section ${index}</h2>`,
  ).join("");
  const links = Array.from(
    { length: 110 },
    (_, index) => `<a href="/resource-${index}">Resource ${index}</a>`,
  ).join("");
  const buttons = Array.from(
    { length: 70 },
    (_, index) => `<button type="button">Action ${index}</button>`,
  ).join("");
  const paragraphs = Array.from(
    { length: 120 },
    (_, index) =>
      `<p>Long visible content snippet ${index} that should be capped in the extracted facts artifact.</p>`,
  ).join("");
  const images = Array.from(
    { length: 90 },
    (_, index) => `<img data-long="${longAttr}-${index}" src="${transparentGif}">`,
  ).join("");
  const page = `<!doctype html><html lang="en"><head><title>Scan compact</title></head><body><main><h1>Scan compact</h1>${headings}${links}${buttons}${paragraphs}${images}</main></body></html>`;
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
  const facts = JSON.parse(await readFile(join(runDir, "facts.json"), "utf8"));
  const compactViolation = compact.violations.find((item) => item.id === "image-alt");
  const fullViolation = full.violations.find((item) => item.id === "image-alt");

  assert.equal("passes" in compact, false);
  assert.equal("inapplicable" in compact, false);
  assertCompactViolationShape(compactViolation, 90);
  assert.equal(fullViolation.nodes.length, 90);
  assert.ok(JSON.stringify(compact).length < 30000);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 3);

  assert.equal(facts.headings.length, 60);
  assert.equal(facts.links.length, 100);
  assert.equal(facts.buttons.length, 60);
  assert.equal(facts.images.length, 80);
  assert.equal(facts.textSnippets.length, 100);
});

test("accessibility check keeps axe violations compact but actionable", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "tiny-rewrite-a11y-"));
  await mkdir(join(runDir, "screenshots"), { recursive: true });
  await writeFile(join(runDir, "facts.json"), JSON.stringify({ url: "" }));

  const longAttr = "y".repeat(2000);
  const images = Array.from(
    { length: 90 },
    (_, index) => `<img data-long="${longAttr}-${index}" src="${transparentGif}">`,
  ).join("");
  const html = `<!doctype html><html lang="en"><head><title>Compact check</title></head><body><main><h1>Compact check</h1>${images}</main></body></html>`;
  await writeFile(
    join(runDir, "transformed.html"),
    html,
  );

  const result = await accessibilityProfile.check({ rootDir: runDir, runDir }, 1);
  const violation = result.axeViolations.find((item) => item.id === "image-alt");

  assertCompactViolationShape(violation, 90);
  assert.ok(violation.additionalTargets.length > 0);
  assert.ok(violation.nodes[0].target[0].startsWith("img"));
  assert.match(violation.nodes[0].failureSummary, /alt attribute/);
  assert.ok(JSON.stringify(result).length < 30000);

  const full = JSON.parse(
    await readFile(join(runDir, "iterations", "001", "checks-full.json"), "utf8"),
  );
  const fullViolation = full.axeViolations.find((item) => item.id === "image-alt");
  assert.equal(fullViolation.nodes.length, 90);
  assert.ok(JSON.stringify(result).length < JSON.stringify(full).length / 3);
});

test("accessibility prompts keep sidecars targeted and prior iteration exact", () => {
  const runDir = "/tmp/tiny-rewrite-run";
  const iterDir = join(runDir, "iterations", "002");
  const reviewer = accessibilityProfile.reviewers[0];

  const findings = accessibilityProfile.findingsPrompt(
    { rootDir: runDir, runDir, iterDir, iteration: 2 },
    reviewer,
  );
  assert.match(findings, /iterations\/001\/checks-full\.json/);
  assert.doesNotMatch(findings, /iterations\/002\/checks-full\.json/);
  assert.doesNotMatch(findings, /iterations\/\*/);
  assert.match(findings, /Open full sidecars only after/);

  const aggregate = accessibilityProfile.aggregatePrompt({
    rootDir: runDir,
    runDir,
    iterDir,
    iteration: 2,
  });
  assert.match(aggregate, /top eight/);
  assert.match(aggregate, /do not restate full evidence/);
  assert.doesNotMatch(aggregate, /iterations\/\*/);

  const fix = accessibilityProfile.fixPrompt({
    rootDir: runDir,
    runDir,
    iterDir: join(runDir, "iterations", "001"),
    iteration: 1,
  });
  assert.match(
    fix,
    /fixer is the only role allowed to load\/copy original\.html wholesale/,
  );
  assert.match(fix, /never copy raw HTML into notes or summaries/);
});

function assertCompactViolationShape(violation, nodeCount) {
  assert.equal(violation.nodeCount, nodeCount);
  assert.ok(violation.nodes.length <= 5);
  assert.equal(violation.omittedNodes, nodeCount - violation.nodes.length);
  assert.ok((violation.additionalTargets || []).length <= 25);

  for (const node of violation.nodes) {
    assert.ok(node.html.length <= 500);
    assert.ok(node.failureSummary.length <= 1200);
    assert.ok((node.checks || []).length <= 8);
    for (const check of node.checks || []) {
      assert.ok(check.message.length <= 300);
    }
  }
}

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
