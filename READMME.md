# AAA - Accessibility AI Audit

AAA orchestrates an accessibility swarm for web pages. It captures a live source page, uses opencode agents to produce an accessible rewrite, validates the result with Playwright and axe, then serves the transformed page and audit report from `runs/<timestamp>/`.

The goal is not just to pass automated checks. AAA is designed to improve accessibility while preserving the page's purpose, content, links, visual identity, and task flow.

## Requirements

- Node.js 20 or newer and npm.
- Git.
- Playwright Chromium browser files.
- An LLM provider key for opencode.
- Rust and Cargo only when running the TUI.

`npm install` installs the local `opencode-ai` package, so a global opencode install is not required.

## Install

```bash
npm install
npm run setup:browsers
```

On Linux, use this if Chromium reports missing system dependencies:

```bash
npm run setup:browsers:linux
```

After `npm install`, verify the local opencode binary:

```bash
npx --no-install opencode --version
```

## Configure

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and choose one auth path.

Default DeepSeek path:

```bash
DEEPSEEK_API_KEY=your_key_here
SWARM_MODEL=deepseek/deepseek-v4-flash
```

opencode.ai path:

```bash
OPENCODE_API_KEY=your_key_here
SWARM_MODEL=opencode/deepseek-v4-flash-free
```

Useful run controls:

```bash
SWARM_MAX_ITERATIONS=3
SWARM_AGENT_TIMEOUT_MS=900000
SWARM_WAIT_LOG_INTERVAL_MS=10000
```

Normal runs spawn an opencode server automatically. Set `SWARM_OPENCODE_SERVER_URL` only when you already have an external opencode server running with the right provider keys.

## Run

Command-line run:

```bash
npm run swarm -- accessibility https://example.com
```

Rust TUI:

```bash
npm run swarm:tui -- accessibility https://example.com
```

Browser UI:

```bash
npm run swarm:web
```

The browser UI defaults to:

```text
http://localhost:5180
```

## How It Works

Each run creates a timestamped directory under `runs/`.

1. Scan: Playwright opens the target URL, saves `original.html`, extracts `facts.json`, writes compact and full axe evidence, and captures a screenshot.
2. Brief: the orchestrator agent writes `brief.md`, framing the page purpose, accessibility risks, preservation needs, and reviewer focus.
3. Fix: the fixer agent writes `transformed.html` and `solver-result.json`.
4. Check: Playwright and axe validate the transformed page and write `checks.json`.
5. Review: when checks pass, specialist reviewers vote on semantic, keyboard, cognitive, visual, and preservation quality.
6. Decision: the orchestrator writes `decision.json`.
7. Report: local code writes `report.md` and `report.html`.
8. Serve: the transformed page and report are served from localhost.

If automated checks fail, reviewer votes are skipped for that iteration. The next iteration goes directly back to the fixer with the check failures as the main repair target.

## Agents

AAA uses focused opencode sessions for each role:

- `orchestrator`: writes the brief and final iteration decision.
- `fixer`: rewrites the captured page into `transformed.html`.
- `semantic`: reviews screen-reader structure, names, roles, headings, and alt text.
- `keyboard`: reviews keyboard and motor access.
- `cognitive`: reviews clarity, labels, task flow, and predictable navigation.
- `visual`: reviews contrast, zoom, reflow, focus appearance, and mobile behavior.
- `preservation`: reviews content, links, media, facts, and recognizable brand feel.

The orchestrator and fixer use the `max` model variant. Reviewers use the `low` variant.

## Artifacts

Common run files:

```text
runs/<timestamp>/original.html
runs/<timestamp>/facts.json
runs/<timestamp>/axe.json
runs/<timestamp>/axe-full.json
runs/<timestamp>/brief.md
runs/<timestamp>/transformed.html
runs/<timestamp>/report.md
runs/<timestamp>/report.html
runs/<timestamp>/swarm.log
runs/<timestamp>/sessions.json
runs/<timestamp>/screenshots/original.png
runs/<timestamp>/screenshots/transformed-001.png
runs/<timestamp>/iterations/001/solver-result.json
runs/<timestamp>/iterations/001/checks.json
runs/<timestamp>/iterations/001/checks-full.json
runs/<timestamp>/iterations/001/decision.json
runs/<timestamp>/iterations/001/votes/*.json
runs/<timestamp>/iterations/001/prompts/*.md
```

`axe.json` and `checks.json` are compact agent-facing files. `axe-full.json` and `checks-full.json` preserve deeper axe detail for targeted debugging.

## Telemetry

When the provider reports usage, AAA records per-prompt token and cost telemetry.

- `prompt:done` events can include usage for that prompt.
- `run_complete` includes total usage and per-agent usage.
- The CLI prints a final token and cost summary.

Usage telemetry is best-effort. Missing provider usage never blocks a run.

## Test

```bash
npm test
npm run test:tui
```

Focused checks:

```bash
npm run test:core
node --test test/axe-compact.test.mjs
node --test test/observability.test.mjs
```

## Notes

- Passing axe is required evidence, not a full WCAG conformance claim.
- The final report is generated locally from run artifacts, not by another model call.
- Keep `.env` private. Do not commit API keys.
- Use `runs/<timestamp>/swarm.log` when debugging a run.
