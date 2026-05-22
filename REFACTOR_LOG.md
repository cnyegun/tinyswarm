# Refactor Log

Long-horizon simplification log for tiny-rewrite. One focused improvement per
session. New sessions read this first.

## Repo context (as of session 2)

tiny-rewrite is a TypeScript CLI swarm-runner. `runSwarm(profile, input, rootDir)`
runs an orchestrator + fixer + N reviewers through an opencode server to remediate
accessibility issues on a target URL. One profile exists today: `accessibilityProfile`.

**Layout (after session 1):**

```
src/accessibility.ts  822  the one SwarmProfile (scan, check, prompts, axe compaction)
src/core.ts           616  runSwarm + iteration loop + decision logic + utilities
src/harness.ts        577  opencode server, sessions, promptAgent, waitForOutputs
src/report.ts         856  markdown + HTML report (~190 lines inline CSS)
src/reporter.ts       103  reporter callback shape + helpers
src/server.ts          55  HTTP preview server for the final artifact
src/static-server.ts   60  shared static file serving + listen helper
src/web.ts            328  browser UI server (spawns index.js as child process)
src/index.ts           50  CLI entry
```

**Consumers (do not break their contracts):**
- `src/index.ts` — CLI, imports `runSwarm`, `SwarmEvent`, `SwarmReporter` from `./core.js`
- `test/core-runner.mjs` — black-box test driver, calls runSwarm + capturing reporter
- `src/web.ts` — spawns `dist/index.js --json-events`, parses one JSON event per stdout line
- Rust TUI (external) — same JSON event stream
- `test/accessibility.test.mjs` — imports `accessibilityProfile` directly

**Public API frozen:** `runSwarm`, and these exported types from `core.js`:
`SwarmProfile, Reviewer, Decision, CheckResult, RunPaths, IterationPaths,
SwarmEvent, SwarmReporter, RunSwarmOptions`.

**What "simpler" means here:** fewer code paths in the observability surface
(log + emit + progress mirror), fewer concepts where two functions do almost
the same thing (duplicate `serve()`, duplicate compact-axe helpers), fewer
config knobs the user has to learn. NOT fewer lines.

## Recent direction (don't undo)

- Session 0 (commit b2fd476): split a 2,526-line `core.ts` into harness/report/server.
  **Further splitting is probably wrong.** The current 4-file split is the floor.
- Session 1 (this branch's previous commits): added observability tests, collapsed
  duplicate prompt-failed reporting in harness, consolidated check-phase reporting
  via a local closure in core, removed leaked `axeViolationCount` from reporter.ts,
  trimmed verbose JSDoc, removed `briefHighlight` filesystem read from report.ts.

## Sessions

### Session 1 — observability triplet (commits 6e2fdf5..6042b6a, on `main`)

**What worked:**
- Adding a capturing SwarmReporter to `test/core-runner.mjs` + a new
  `test/observability.test.mjs` (17 tests) locked the reporter surface so the
  refactor could happen without fear. 54 tests total now.
- `reportPromptFailed()` helper in harness.ts collapsed two identical
  log+emit blocks (SDK rejection vs 2xx-with-error) into one. Two log
  messages, one event shape.
- Local `reportCheck` closure in `core.ts:runChecks` captures iteration +
  elapsedMs once. Status transitions can't drift out of sync across channels.
- Inlining `axeViolationCount` removed accessibility-shape knowledge from
  reporter.ts (which is supposed to be project-dep-free).
- Removed `briefHighlight()` + `brief.md` read from report.ts. The
  orchestrator agent card just renders a static one-liner now — no test or
  consumer looks at the extracted paragraph.

**What I tried and abandoned:**
- One global `phaseEvent(run, ...)` helper for log + emit + progress across
  scan/iteration/check/decision. Abandoned because the per-phase data shapes
  diverge enough (log uses `key`, emit uses `agent`; some phases have
  progress, some don't; status names differ: "starting" vs "start"). A
  single helper would have to take 5 parameters and would not read clearer
  than the call sites.
- Removing the `progress()` mirror-to-event in reporter.ts (every
  `reporter.progress()` call also emits `{type:"progress"}`). The web UI
  consumes events, the CLI consumes the progress callback — both paths look
  used. Did not investigate the Rust TUI's consumption pattern. Left for a
  future session that can verify the TUI side.

**Surprises:**
- `decideFromFailedChecks` skips emitting the `iteration:completed` event
  when checks fail — only `iteration:active` is emitted for failed-check
  iterations. The observability test now pins this gap explicitly so anyone
  who "fixes" it has to do it intentionally.
- `core-runner.mjs` is huge (~810 lines) compared to the actual core
  (616 lines). It's a faithful opencode HTTP mock with scenario routing,
  not a smell.

### Session 2 — inline axe compaction helper chain (branch `refactor/session-2`)

**Target picked:** Candidate C from the session 1 list — the
`compactAxeViolations → compactAxeNode → compactChecksForNode →
compactCheckMessages` chain in `src/accessibility.ts`. Six hops to compact one
node; three helpers each used in exactly one place.

**What worked:**
- Wrote `test/axe-compact.test.mjs` first (8 unit tests) pinning the slicing
  behaviors the refactor would touch: any/all/none merge order, slice spanning
  groups, additionalTargets dedup, wcag tag enrichment, nested target arrays,
  omittedNodes math, undefined-field stripping.
- Exported `compactAxeViolations` from `accessibility.ts` so the unit tests
  could hit it directly instead of going through Chromium. Pure utility, not
  in the frozen `runSwarm` API list — non-breaking.
- Inlined `compactAxeNode` and its node-mapping body inside the
  `sampledNodes.map(...)` call in `compactAxeViolations`. Collapsed
  `compactChecksForNode + compactCheckMessages` into one `compactNodeChecks`
  that builds the typed-group array via `flatMap` then slices once. Reading
  the compaction now takes two hops, not four.
- 8 unit tests + 5 integration tests + 49 other tests = 62 green throughout.

**What I tried and abandoned:**
- Considered also inlining `compactNodeChecks` into the node mapping. Tried
  it locally; the inline version pushed the violation mapping body to ~25
  lines and the per-group merging logic got tangled with the per-node check
  shape. Kept as a small named helper because the name "compactNodeChecks"
  carries real meaning (multi-group merge + slice).
- Considered exporting more helpers (`compactAxeResult`, `wcagForTags`) for
  symmetry. Rejected — they have only one caller each inside accessibility.ts
  and exporting things "for symmetry" creates surface area that future
  sessions have to honor.

**Surprises:**
- The existing accessibility integration test relies on real Chromium+axe to
  produce ~90 violation nodes for the `image-alt` rule. The new unit tests
  produce the same shape with hand-crafted input in milliseconds. Both
  layers earn their keep — the integration test pins real-axe shape (which
  could shift on axe upgrade), the unit tests pin the slice/merge rules.
- `wcagForTags` reads `reference/wcag/wcag-map.json` at runtime and caches
  the result in a module-level `wcagMapCache`. The unit test relies on that
  file being present; if it ever goes missing the wcag-enrichment test will
  fail with an informative `compact.wcag missing 1.4.3 entry` — better than
  a silent miss.

### Session 3 — route per-role model overrides through reporter.line (branch `refactor/session-3`)

**Target picked:** Candidate G from the session 1 list — the two
`console.log()` calls in `src/core.ts` that announced
`SWARM_ORCHESTRATOR_MODEL` / `SWARM_FIXER_MODEL` overrides while bypassing
the reporter.

**What worked:**
- Wrote one observability test first asserting the override announcements
  reach `reporter.line`. The test failed against the existing code —
  proof it actually exercises the bypass, not some adjacent surface.
  Then made the smallest fix that flipped it green.
- The fix was literally `console.log(...)` → `line(run, ...)`, twice.
  Diff is two `if` blocks where only the call name changed.
- This was a bug, not just consistency: `--json-events` mode (web.ts +
  Rust TUI consumers) parses stdout as one JSON event per line. The
  previous `console.log` calls injected non-JSON text whenever per-role
  models were configured. The JSON reporter has no `line` callback, so
  routing through `line()` cleanly drops them; the CLI default still
  prints them via `consoleReporter.line → console.log`.

**What I tried and abandoned:**
- Initially committed the failing test alone before the fix (TDD-style
  red-then-green). That broke the "every commit leaves tests passing"
  rule — the next session couldn't start cleanly at that commit. Reset
  with `git reset --soft HEAD~1` and bundled test + fix into one green
  commit. Lesson: tests-first means *written* first, not *committed*
  first; the red phase belongs in the working tree, not in git history.

**Surprises:**
- The bypass had been there at least since the core.ts split (session 0).
  Easy to miss because the lines only print under env conditions the
  default CLI flow never triggers; a JSON-mode regression would only
  show up if a downstream consumer reported "garbled JSON" — and only
  when the user set per-role model envs.

## Candidates for future sessions

Specific file:line targets, ranked by suspected payoff. Each entry is meant
to be pick-up-able cold.

### A. Duplicate `serve()` between `accessibility.ts` and `server.ts`

- `src/accessibility.ts:805-822` — internal preview server used only by
  `check()` to run axe against `transformed.html` via localhost.
- `src/server.ts:24-55` — public preview server with named routes
  (`/`, `/report.html`, `/checks.json`, etc.).

Both build a `createServer` over `sendStaticFile`. The accessibility one
serves `transformed.html` at `/` directly because the artifact may not yet
exist when checks run. server.ts falls back from `transformed.html` to
`report.html` for `/`.

**Why complex:** two places to fix if MIME handling changes or path traversal
needs hardening.

**Smallest change that helps:** unclear yet — could be a single helper in
`static-server.ts` that takes a route map. Risk: forcing a route-map API on
the simpler case adds an abstraction. Investigate before changing.

### B. The `progress()` mirror-to-event coupling in `reporter.ts`

- `src/reporter.ts:55-63` — every `progress(reporter, started, phase, msg)`
  call invokes `reporter.progress?.()` AND emits a `{type:"progress",...}`
  event.

Both paths exist because the CLI uses the callback and the Rust TUI / web UI
read the event stream. The mirror is wasteful only if some consumer reads
*both* and dedupes — verify each consumer before touching.

**Why complex:** two channels for the same data; adding a progress field
forces the developer to remember both paths agree.

**Smallest change that helps:** unclear. May actually be correct duplication.

### C. ~~accessibility.ts axe compaction layer~~ — DONE (session 2)

Inlined the single-use helpers; the remaining 5 helpers
(`compactAxeViolations`, `compactAxeResult`, `compactNodeChecks`,
`truncateAxeTarget(Item)`, `truncateEvidenceText`, `omitUndefinedFields`,
`stringArray`, `wcagForTags`) are each used multiple places or carry real
semantic load.

### D. `validateConfiguredModels` in `harness.ts:153-227`

~75 lines for a preflight that mostly logs. The dedup-by-modelName via
`new Map(specs.map(...))` for 3 fixed keys is intricate.

**Why complex:** the function does three things (resolve specs, fetch
providers, check each model) interleaved with logging. Hard to skim.

**Smallest change that helps:** maybe just inline the dedup; the input set
is `["default", "orchestrator", "fixer"]` — collapse via an Array.from with
seen-set, or even just a loop. Or extract the error-message construction
into one place since the multi-line `[].join(". ")` is doing layout work.

### E. report.ts inline CSS (~190 lines)

- Two `@media (min-width: 768px)` blocks can be merged.
- Comments referencing `DESIGN.md §5.2`, `§8.1`, `§8.12` — interesting in
  context but contribute noise to a deterministic report file.
- Every CSS class IS used in the HTML template — confirmed last session.

**Why complex:** none individually, but the volume of design tokens
(~50 CSS custom properties) is large. Could split into a string const.

**Smallest change that helps:** merge the duplicate media queries. Tiny.
Or extract `STYLES` to a top-of-file const for reading.

### F. `web.ts:36-43` has its own `RunState` type shadowing `core.ts`'s

Different concept (web run lifecycle vs swarm run state) but same name.
Rename `web.ts`'s type to `WebRun` or similar.

**Why complex:** confusing when reading both files. Pure renaming.

### G. ~~`core.ts` orchestrator/fixer model variant logging~~ — DONE (session 3)

Routed through `line(run, ...)`. Was a real bug for `--json-events` mode,
not just a consistency issue.

### H. `core.ts:175-181` — final line block at run completion

Six adjacent `line(run, ...)` calls listing Run/Brief/Report/Transformed/Log/Local.
Same data is in the `run_complete` event. The CLI prints the lines; the
event-only consumers see them in `run_complete`. The duplication is small
but doubles the surface for "where do final paths come from."

**Why complex:** if a path moves, two places change.

**Smallest change that helps:** unclear. The lines are human-formatted; the
event is structured. May be correct duplication.

### I. (discovered session 2) accessibility.ts type-input declarations

Lines 30-54: `AxeCheckInput`, `AxeNodeInput`, `AxeViolationInput` types are
~25 lines of duplicated-with-axe shape definitions because the axe SDK types
don't expose the input shapes cleanly. The duplication is real but probably
unavoidable; investigated and chose not to touch in session 2. Mentioned
here so a future session doesn't burn time on it.

### J. (discovered session 3) reporter coverage audit — already clean

Session 3 audited `grep -rn "console\.\(log\|error\|warn\)" src/` to check
for other reporter bypasses. All remaining direct `console` calls are
legitimate boundaries: `src/index.ts` CLI startup before `runSwarm`
exists, `src/web.ts` top-level web server log lines outside any run,
and `src/reporter.ts` consoleReporter's own implementation. No further
bypass to flag — don't repeat this audit unless a new entry point is
added.

## What NOT to do

- Don't re-split core.ts. The 4-file shape was deliberate (session 0).
- Don't change the public API. See "consumers" above.
- Don't reword existing swarm.log strings — the observability test pins
  `\bscan done\b`, `\bdecision accept\b`, etc., and downstream tools grep them.
- Don't add an event-bus or pub-sub abstraction. The reporter callback is
  the abstraction; adding another would be net-negative.
