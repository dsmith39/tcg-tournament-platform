#!/usr/bin/env bash
# Local Unix E2E helper script.
#
# Responsibilities:
# - Stop stale Node listeners that can interfere with Playwright startup.
# - Optionally perform cleanup only.
# - Execute the E2E suite from repository root.
set -euo pipefail

cleanup_only="false"
if [[ "${1:-}" == "--cleanup-only" ]]; then
  cleanup_only="true"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

stop_node_on_port() {
  local port="$1"

  # Prefer lsof when available for explicit PID discovery.
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        if ps -p "$pid" -o comm= 2>/dev/null | grep -qi 'node'; then
          echo "Stopping node PID $pid on port $port"
          kill -9 "$pid" || true
        fi
      done <<< "$pids"
    fi
    return
  fi

  # Fallback for systems without lsof.
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
}

echo "Cleaning stale local server state for e2e runs..."
stop_node_on_port 3000
stop_node_on_port 3100
stop_node_on_port 3200

if [[ "$cleanup_only" == "true" ]]; then
  echo "Cleanup complete."
  exit 0
fi

cd "$repo_root"

echo "Running e2e suite..."
npm run test:e2e -- --workers=1
