#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${PROJECTPILOT_DEPLOY_BRANCH:-main}"
REMOTE="${PROJECTPILOT_DEPLOY_REMOTE:-origin}"

cd "$ROOT_DIR"

echo "== preflight =="
if ! git status --short >/dev/null 2>&1; then
  echo "git is not available. If macOS asks for the Xcode license, run this in Terminal first:"
  echo "sudo xcodebuild -license accept"
  exit 1
fi

lark-cli doctor

echo
echo "== update source =="
git fetch "$REMOTE" "$BRANCH"
git merge --ff-only "$REMOTE/$BRANCH"

echo
echo "== build =="
npm ci
npm run build

echo
echo "== install service =="
npm run bot:install

echo
echo "== status =="
npm run bot:status
