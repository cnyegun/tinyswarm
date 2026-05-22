# AAA - Accessibility AI Audit

AAA runs an accessibility swarm against a web page. It captures the source page, asks opencode agents to rewrite it, checks the result with Playwright and axe, then serves the transformed page and report from `runs/<timestamp>/`.

## Requirements

- Node.js 20 or newer and npm.
- Git.
- Playwright Chromium browser files. Install them with `npm run setup:browsers` after `npm install`.
- Linux system packages for Chromium, if they are missing. Install them with `npm run setup:browsers:linux`.
- opencode. `npm install` installs the local `opencode-ai` package, so a global opencode install is not required.
- An LLM provider key for opencode. The default model uses `DEEPSEEK_API_KEY`; opencode.ai free/Zen models use `OPENCODE_API_KEY`.
- Rust and Cargo only when running the TUI with `npm run swarm:tui`.

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

```bash
cp .env.example .env
```

Edit `.env` and set one of these auth paths:

- Default DeepSeek path: set `DEEPSEEK_API_KEY` and keep `SWARM_MODEL=deepseek/deepseek-v4-flash`.
- opencode.ai path: set `OPENCODE_API_KEY` and set `SWARM_MODEL=opencode/deepseek-v4-flash-free`.

Normal runs spawn an opencode server automatically. Set `SWARM_OPENCODE_SERVER_URL` only when you already have an external opencode server running with the right provider keys.

## Run

```bash
npm run swarm -- accessibility https://example.com
```

With the Rust TUI:

```bash
npm run swarm:tui -- accessibility https://example.com
```

## Test

```bash
npm test
npm run test:tui
```
