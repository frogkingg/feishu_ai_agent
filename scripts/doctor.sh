#!/bin/sh
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "== local files =="
test -f .env && echo ".env found" || echo ".env missing"
test -f dist/index.js && echo "dist/index.js found" || echo "dist/index.js missing"

echo
echo "== build =="
npm run build

echo
echo "== lark-cli =="
command -v lark-cli || true
lark-cli --version || true
lark-cli doctor || true

echo
echo "== bot status =="
sh "$ROOT_DIR/scripts/status.sh"

echo
echo "== recent logs =="
tail -n 40 "$ROOT_DIR/.runtime/project-pilot.launchd.log" 2>/dev/null || true
tail -n 40 "$ROOT_DIR/.runtime/project-pilot.launchd.err.log" 2>/dev/null || true
