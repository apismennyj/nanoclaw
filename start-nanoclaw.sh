#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/pav/ai-agents/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/pav/ai-agents/nanoclaw"

# Stop existing instance if running
if [ -f "/home/pav/ai-agents/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/pav/ai-agents/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
# Load .env if present (export each variable to the child process)
if [ -f "/home/pav/ai-agents/nanoclaw/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "/home/pav/ai-agents/nanoclaw/.env"
  set +a
fi

nohup "/usr/bin/node" "/home/pav/ai-agents/nanoclaw/dist/index.js" \
  >> "/home/pav/ai-agents/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/pav/ai-agents/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/pav/ai-agents/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/pav/ai-agents/nanoclaw/logs/nanoclaw.log"
