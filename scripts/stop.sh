#!/bin/sh
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.projectpilot.bot.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true

if [ -f "$ROOT_DIR/.runtime/project-pilot.pid" ]; then
  kill "$(cat "$ROOT_DIR/.runtime/project-pilot.pid")" 2>/dev/null || true
  rm "$ROOT_DIR/.runtime/project-pilot.pid"
fi

pkill -f "node .*/dist/index.js" 2>/dev/null || true
pkill -f "node dist/index.js" 2>/dev/null || true
pkill -f "ts-node src/index.ts" 2>/dev/null || true
pkill -f "lark-cli event +subscribe" 2>/dev/null || true

echo "ProjectPilot stopped"
