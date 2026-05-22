#!/usr/bin/env bash
# One command to run the Accessibility Swarm web UI.
# Finds a Node 20+ runtime, installs what's missing, builds, and serves the page.
set -euo pipefail
cd "$(dirname "$0")"

# --- find a Node.js 20+ runtime (the project needs node:process loadEnvFile) ---
node_bin=""
node_major=0
for candidate in "$(command -v node || true)" "$HOME"/.nvm/versions/node/v*/bin/node; do
  [ -x "$candidate" ] || continue
  major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 20 ] && [ "$major" -ge "$node_major" ]; then
    node_bin="$candidate"
    node_major="$major"
  fi
done
if [ -z "$node_bin" ]; then
  echo "Error: Node.js 20+ is required but was not found. Try: nvm install 22" >&2
  exit 1
fi
echo "Node: $("$node_bin" --version)  ($node_bin)"

# --- dependencies ------------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

# --- Chromium for page scans (one-time download) -----------------------------
if ! ls "$HOME"/.cache/ms-playwright/chromium-* >/dev/null 2>&1; then
  echo "Installing Chromium for page scans (one-time)..."
  ./node_modules/.bin/playwright install chromium \
    || echo "Warning: Chromium install failed - page scans may not work."
fi

# --- .env --------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from the template - add an API key to it before starting a run."
fi

# --- build and serve ---------------------------------------------------------
echo "Building..."
npm run build
echo "Starting the web UI - press Ctrl+C to stop."
exec "$node_bin" dist/web.js
