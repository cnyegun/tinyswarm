#!/usr/bin/env bash
# claude-paste-prompt.sh — type a prompt into the pre-launched Claude terminal.
#
# Called by src/claude-backend.ts when SWARM_BACKEND=claude. It finds the
# topmost terminal window, raises it, types the prompt (read from a file), and
# presses Enter — so a Claude Code session already idle there picks it up.
#
# Usage: claude-paste-prompt.sh <prompt-file>
#        CLAUDE_PASTE_DRYRUN=1 claude-paste-prompt.sh <prompt-file>
#          — find and report the target terminal, but type nothing (safe test).
#
# Requirements:
#   - An X11 session (this uses xdotool). On Wayland, run the terminal under
#     XWayland, or swap xdotool for ydotool/wtype.
#   - xdotool:  sudo apt install xdotool
#   - xprop (from x11-utils), if present, is used to pick the topmost terminal.
#
# Config:
#   CLAUDE_TERMINAL_WINDOW_CLASS  regex (xdotool --class) overriding the
#     built-in terminal list. Find your terminal's class with:  xprop WM_CLASS
#   CLAUDE_PASTE_DRYRUN           if set, report the target and exit (no typing).
#
# Exit codes: 2 bad arguments · 3 xdotool missing · 4 no X11 · 5 no terminal.
set -euo pipefail

die() { echo "claude-paste-prompt: $1" >&2; exit "${2:-1}"; }

prompt_file="${1:-}"
[ -n "$prompt_file" ] && [ -f "$prompt_file" ] || die "missing or unreadable prompt-file argument" 2
prompt="$(cat "$prompt_file")"
[ -n "$prompt" ] || die "prompt file is empty" 2

command -v xdotool >/dev/null 2>&1 || die "'xdotool' is not installed — run: sudo apt install xdotool" 3
[ -n "${DISPLAY:-}" ] || die "no X11 DISPLAY set — this needs a graphical X11 session" 4

# --- find candidate terminal windows ----------------------------------------
# xdotool's --class is a regex matched against each window's WM_CLASS, and the
# search recurses the window tree — so it works even when the window manager
# reparents windows for decoration (e.g. Cinnamon/Muffin), which defeats a flat
# getwindowclassname lookup.
default_terminals='[Gg]nome-terminal|[Kk]onsole|[Xx][Tt]erm|[Aa]lacritty|[Kk]itty'
default_terminals="$default_terminals|[Xx]fce4-terminal|[Tt]erminator|[Uu]?[Rr]xvt"
default_terminals="$default_terminals|[Tt]ilix|[Mm]ate-terminal|[Ll]xterminal|[Ww]ez[Tt]erm"
default_terminals="$default_terminals|[Qq][Tt]erminal|[Dd]eepin-terminal|[Tt]erminology"
default_terminals="$default_terminals|[Gg]uake|[Tt]ilda|[Hh]yper|[Gg]hostty"
match="${CLAUDE_TERMINAL_WINDOW_CLASS:-$default_terminals}"

mapfile -t hits < <(xdotool search --class "$match" 2>/dev/null || true)

# --- order them by stacking, topmost last -----------------------------------
# _NET_CLIENT_LIST_STACKING lists managed top-level windows bottom-to-top.
# Intersecting with it also drops the child/decoration windows that xdotool's
# tree search returns alongside the real terminal window.
ordered=()
if command -v xprop >/dev/null 2>&1; then
  stacking="$(xprop -root _NET_CLIENT_LIST_STACKING 2>/dev/null | sed 's/.*#//' || true)"
  IFS=', ' read -ra stack <<<"$stacking"
  for hex in "${stack[@]}"; do
    [[ "$hex" =~ ^0x[0-9a-fA-F]+$ ]] || continue
    dec=$((hex))
    for h in "${hits[@]:-}"; do
      [ "$h" = "$dec" ] && ordered+=("$dec")
    done
  done
fi
# Fall back to xdotool's raw order if the stacking list told us nothing.
[ "${#ordered[@]}" -gt 0 ] || ordered=("${hits[@]:-}")

[ "${#ordered[@]}" -gt 0 ] && [ -n "${ordered[0]}" ] || die \
  "no terminal window found (class regex: $match). Open a standalone terminal running 'claude' (not the VS Code panel), or set CLAUDE_TERMINAL_WINDOW_CLASS." 5

target="${ordered[-1]}"
target_name="$(xdotool getwindowname "$target" 2>/dev/null || echo '?')"
[ "${#ordered[@]}" -le 1 ] || \
  echo "claude-paste-prompt: ${#ordered[@]} terminals open — picked topmost: \"$target_name\"" >&2

# --- dry run: report the target and stop, without typing --------------------
if [ -n "${CLAUDE_PASTE_DRYRUN:-}" ]; then
  echo "claude-paste-prompt: [dry run] would type into window \"$target_name\" ($target)"
  exit 0
fi

# --- raise the terminal, type the prompt, press Enter -----------------------
xdotool windowactivate --sync "$target"
sleep 0.3
xdotool type --clearmodifiers --delay 12 -- "$prompt"
sleep 0.15
xdotool key --clearmodifiers Return

echo "claude-paste-prompt: typed ${#prompt} chars into window \"$target_name\" ($target)"
