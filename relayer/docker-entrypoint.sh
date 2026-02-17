#!/usr/bin/env bash
set -euo pipefail

MAPPINGS_FILE="/app/relayer-mappings.json"
INIT_SCRIPT="/app/relayer/init-mappings.js"

if [ ! -f "$MAPPINGS_FILE" ]; then
  echo "[relayer-entrypoint] mappings file not found, initializing..."
  if [ -f "$INIT_SCRIPT" ]; then
    node "$INIT_SCRIPT" || echo "[relayer-entrypoint] init script failed"
  else
    echo "[relayer-entrypoint] init script missing: $INIT_SCRIPT"
  fi
else
  echo "[relayer-entrypoint] mappings file exists"
fi

exec node dist/index.js
