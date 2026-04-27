#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.projectpilot.bot.plist"
NODE_BIN="$(command -v node)"

cd "$ROOT_DIR"
mkdir -p "$ROOT_DIR/.runtime" "$HOME/Library/LaunchAgents"
npm run build

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.projectpilot.bot</string>

  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/dist/index.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$ROOT_DIR/.runtime/project-pilot.launchd.log</string>

  <key>StandardErrorPath</key>
  <string>$ROOT_DIR/.runtime/project-pilot.launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/com.projectpilot.bot"
launchctl kickstart -k "gui/$(id -u)/com.projectpilot.bot"

echo "ProjectPilot LaunchAgent installed: $PLIST_PATH"
sh "$ROOT_DIR/scripts/status.sh"
