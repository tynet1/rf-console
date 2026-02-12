#!/usr/bin/env sh
set -eu

PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  exit 0
fi

# Optional hook point. By default the OP25 supervisor notices profile file changes.
# Keep this script for future extension (alerts, logs, metrics).
printf 'profile switch requested: %s\n' "$PROFILE" >&2
