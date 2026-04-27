#!/bin/sh
set -u

LABEL="com.projectpilot.bot"
UID_VALUE="$(id -u)"

echo "== launchctl =="
launchctl print "gui/$UID_VALUE/$LABEL" 2>/dev/null | sed -n '1,40p' || echo "$LABEL is not loaded"

echo
echo "== processes =="
matches="$(ps -axo pid,ppid,command | grep -E '(node .*/dist/index.js|lark-cli event \+subscribe|npm start|node dist/index.js)' | grep -v grep || true)"
if [ -n "$matches" ]; then
  echo "ProjectPilot process found"
  echo "$matches"
else
  echo "ProjectPilot not running"
fi
