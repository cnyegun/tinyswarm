#!/usr/bin/env bash
# One command to run the Accessibility Swarm web UI on the Claude backend.
#
# Differs from start.sh in two ways:
#   * Launches the web server with SWARM_BACKEND=claude.
#   * Opens a new terminal window with `claude` already running, so the paste
#     script in scripts/claude-paste-prompt.sh has a target to type into.
#
# Open http://localhost:5180 once both are up. Close the Claude terminal
# yourself when you're done — the script does not kill it.
set -euo pipefail
cd "$(dirname "$0")"

# --- find a Node.js 20+ runtime ----------------------------------------------
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

# --- preflight: this flow needs a graphical X11 session ----------------------
if [ -z "${DISPLAY:-}" ]; then
  echo "Error: the Claude backend needs a graphical X11 session (DISPLAY is unset)." >&2
  echo "Use start.sh instead for the opencode backend." >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "Error: 'claude' is not on PATH. Install Claude Code first:" >&2
  echo "  https://docs.claude.com/claude-code" >&2
  exit 1
fi
if ! command -v xdotool >/dev/null 2>&1; then
  echo "Error: 'xdotool' is required to type prompts into the Claude terminal." >&2
  echo "Install it with:  sudo apt install xdotool" >&2
  exit 1
fi

# --- pick a terminal emulator to host the Claude session ---------------------
# Order is "popular and well-tested first". The CLAUDE_LAUNCH_TERMINAL env var
# overrides the auto-pick for users on something unusual.
term="${CLAUDE_LAUNCH_TERMINAL:-}"
if [ -z "$term" ]; then
  for cand in gnome-terminal konsole xfce4-terminal mate-terminal \
              terminator tilix alacritty kitty xterm; do
    if command -v "$cand" >/dev/null 2>&1; then
      term="$cand"
      break
    fi
  done
fi
if [ -z "$term" ]; then
  echo "Error: no terminal emulator found. Install one of: gnome-terminal, konsole, xterm." >&2
  echo "Or set CLAUDE_LAUNCH_TERMINAL=<name> to point at a specific terminal." >&2
  exit 1
fi

# --- dependencies + build ----------------------------------------------------
if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from the template."
fi
echo "Building..."
npm run build

# --- spawn the Claude terminal -----------------------------------------------
# Each emulator has its own command-syntax for "run this program in a new
# window in this working directory". We `setsid` to detach so closing the web
# server doesn't drag the terminal down with it.
echo "Launching Claude Code in a new $term window..."
case "$term" in
  gnome-terminal)
    setsid gnome-terminal --working-directory="$PWD" -- claude </dev/null \
      >/dev/null 2>&1 &
    ;;
  konsole)
    setsid konsole --workdir "$PWD" -e claude </dev/null >/dev/null 2>&1 &
    ;;
  xfce4-terminal)
    setsid xfce4-terminal --working-directory="$PWD" --command="claude" \
      </dev/null >/dev/null 2>&1 &
    ;;
  mate-terminal)
    setsid mate-terminal --working-directory="$PWD" -e "claude" \
      </dev/null >/dev/null 2>&1 &
    ;;
  terminator)
    setsid terminator --working-directory="$PWD" -e "claude" \
      </dev/null >/dev/null 2>&1 &
    ;;
  tilix)
    setsid tilix --working-directory="$PWD" -e "claude" \
      </dev/null >/dev/null 2>&1 &
    ;;
  alacritty)
    setsid alacritty --working-directory "$PWD" -e claude \
      </dev/null >/dev/null 2>&1 &
    ;;
  kitty)
    setsid kitty --directory "$PWD" claude </dev/null >/dev/null 2>&1 &
    ;;
  xterm)
    setsid xterm -e "cd '$PWD' && claude" </dev/null >/dev/null 2>&1 &
    ;;
  *)
    echo "Don't know how to launch '$term'." >&2
    echo "Open a terminal yourself and run: claude" >&2
    ;;
esac
disown 2>/dev/null || true

# Give Claude a moment to open before we serve the UI — xdotool needs to be
# able to find the window the first time the user clicks Start.
sleep 2

# --- serve ------------------------------------------------------------------
echo
echo "Web UI:        http://localhost:${SWARM_WEB_PORT:-5180}"
echo "Backend:       claude  (paste script targets the topmost terminal)"
echo "Press Ctrl+C to stop the web server. Close the Claude window yourself."
echo
export SWARM_BACKEND=claude
exec "$node_bin" dist/web.js
