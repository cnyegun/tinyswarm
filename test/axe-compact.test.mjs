import test from "node:test";
import assert from "node:assert/strict";
import { compactAxeViolations } from "../dist/accessibility.js";

// Direct unit tests for the axe compaction function. The accessibility
// integration test already pins cap values via real Chromium+axe output; these
// tests cover the things real-axe output doesn't reliably exercise:
//
//   - any/all/none check groups merge in a stable order with the right type
//   - AXE_NODE_CHECK_LIMIT slices across all groups combined, not per-group
//   - wcag tag enrichment maps axe wcag* tags to reference paths
//   - additionalTargets dedup against the sampled-target set
//   - nested target arrays (frames/shadow DOM) preserve their shape
//   - omittedNodes math is non-negative when nodeCount < sample limit
//
// These behaviors are the slicing surface of the next refactor.

test("checks from any/all/none groups merge with the right type labels", () => {
  const [compact] = compactAxeViolations([
    {
      id: "color-contrast",
      help: "Elements must meet contrast",
      nodes: [
        {
          target: [".bad"],
          any: [{ id: "color-contrast", message: "ratio too low" }],
          all: [{ id: "presence", message: "must be present" }],
          none: [{ id: "exception", message: "did not match exception" }],
        },
      ],
    },
  ]);

  const checks = compact.nodes[0].checks;
  assert.equal(checks.length, 3);
  // Order is any, then all, then none — frontend tooling sorts by this label
  // to group related failures.
  assert.deepEqual(
    checks.map((check) => check.type),
    ["any", "all", "none"],
  );
  assert.equal(checks[0].id, "color-contrast");
  assert.equal(checks[1].id, "presence");
  assert.equal(checks[2].id, "exception");
});

test("checks slice respects AXE_NODE_CHECK_LIMIT across merged groups", () => {
  // 10 checks total (4 any + 4 all + 2 none) should slice to 8, taking the
  // any group first, then all, then as many none as fit. If the slice were
  // per-group, we'd see 3+3+2=8 with a different ordering — the test pins
  // the across-all behavior.
  const makeChecks = (id, count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${id}-${i}`,
      message: `${id} message ${i}`,
    }));

  const [compact] = compactAxeViolations([
    {
      id: "rule",
      nodes: [
        {
          target: [".node"],
          any: makeChecks("any", 4),
          all: makeChecks("all", 4),
          none: makeChecks("none", 2),
        },
      ],
    },
  ]);

  const checks = compact.nodes[0].checks;
  assert.equal(checks.length, 8);
  // All four "any" entries should be present, then four "all".
  assert.deepEqual(
    checks.map((check) => check.type),
    ["any", "any", "any", "any", "all", "all", "all", "all"],
  );
});

test("nested target arrays (frames/shadow DOM) preserve nesting", () => {
  const [compact] = compactAxeViolations([
    {
      id: "rule",
      nodes: [
        {
          // axe represents shadow DOM targets as nested arrays:
          // [["frame-selector", "inner-shadow-selector"]]
          target: [["#outer-frame", "#inner-shadow"]],
        },
      ],
    },
  ]);

  const target = compact.nodes[0].target;
  assert.equal(Array.isArray(target), true);
  assert.equal(Array.isArray(target[0]), true);
  assert.deepEqual(target[0], ["#outer-frame", "#inner-shadow"]);
});

test("additionalTargets skip duplicates that are already sampled", () => {
  // Build 7 nodes (AXE_NODE_SAMPLE_LIMIT is 5). The 6th and 7th nodes share a
  // selector with sampled nodes — they must be skipped, not duplicated in
  // additionalTargets. Otherwise the compact output would carry the same
  // selector twice and the agent would treat it as two distinct failures.
  const [compact] = compactAxeViolations([
    {
      id: "image-alt",
      nodes: [
        { target: ["#a"] },
        { target: ["#b"] },
        { target: ["#c"] },
        { target: ["#d"] },
        { target: ["#e"] },
        { target: ["#a"] }, // dup of sampled
        { target: ["#f"] }, // new
      ],
    },
  ]);

  assert.equal(compact.nodes.length, 5);
  assert.deepEqual(compact.additionalTargets, [["#f"]]);
});

test("wcag tag enrichment maps axe wcag* tags to reference paths", () => {
  // axe tags each WCAG rule with `wcag` + the SC number with dots removed,
  // e.g. 1.4.3 -> "wcag143". The compact result enriches violations with the
  // success-criterion title/level/ref so agents do not have to look up axe
  // tags separately.
  const [compact] = compactAxeViolations([
    {
      id: "color-contrast",
      help: "Contrast",
      tags: ["cat.color", "wcag2aa", "wcag143"],
      nodes: [{ target: ["#x"] }],
    },
  ]);

  assert.equal(Array.isArray(compact.wcag), true);
  // Find the SC 1.4.3 entry. We don't pin its exact title (the WCAG reference
  // index owns that), but it must be present with sc + ref + level fields.
  const sc143 = compact.wcag.find((entry) => entry.sc === "1.4.3");
  assert.ok(sc143, "compact.wcag missing 1.4.3 entry");
  assert.equal(typeof sc143.title, "string");
  assert.equal(typeof sc143.level, "string");
  assert.match(sc143.ref, /^reference\/wcag\//);
});

test("omittedNodes is zero when nodeCount fits inside the sample", () => {
  const [compact] = compactAxeViolations([
    {
      id: "rule",
      nodes: [{ target: ["#a"] }, { target: ["#b"] }],
    },
  ]);

  assert.equal(compact.nodeCount, 2);
  assert.equal(compact.nodes.length, 2);
  assert.equal(compact.omittedNodes, 0);
});

test("violations without nodes still emit a compact entry with zero counts", () => {
  // Some rules can produce no nodes (incomplete entries from axe), but the
  // shape must stay stable so the report writer doesn't have to handle two
  // shapes.
  const [compact] = compactAxeViolations([
    { id: "rule", help: "Rule", nodes: [] },
  ]);

  assert.equal(compact.nodeCount, 0);
  assert.deepEqual(compact.nodes, []);
  assert.equal(compact.omittedNodes, 0);
  assert.equal(compact.additionalTargets, undefined);
});

test("undefined optional fields are stripped from the compact output", () => {
  // omitUndefinedFields prevents the compact JSON from carrying noisy null-ish
  // entries that agents could misread as evidence. A violation with no
  // impact/tags/etc. should not gain those keys.
  const [compact] = compactAxeViolations([
    {
      id: "rule",
      nodes: [{ target: ["#x"] }],
    },
  ]);

  assert.equal("impact" in compact, false);
  assert.equal("tags" in compact, false);
  assert.equal("wcag" in compact, false);
  assert.equal("additionalTargets" in compact, false);

  const node = compact.nodes[0];
  assert.equal("impact" in node, false);
  assert.equal("html" in node, false);
  assert.equal("failureSummary" in node, false);
  assert.equal("checks" in node, false);
});
