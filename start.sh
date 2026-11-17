#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v pi >/dev/null 2>&1; then
  echo "[pi-terminal-attention] pi command not found in PATH." >&2
  exit 1
fi

SETTINGS_FILE="${HOME}/.pi/agent/settings.json"
if [ -f "$SETTINGS_FILE" ] && grep -qE "pi-terminal-attention|ghostty-attention" "$SETTINGS_FILE" 2>/dev/null; then
  exec pi "$@"
fi

exec pi -e "$SCRIPT_DIR/src/index.ts" "$@"
