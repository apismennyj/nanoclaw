#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill $(cat /home/pav/ai-agents/nanoclaw/nanoclaw.pid)

set -euo pipefail

PROJECT_DIR="/home/pav/ai-agents/nanoclaw"
PID_FILE="$PROJECT_DIR/nanoclaw.pid"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/nanoclaw.log"
ERROR_LOG="$LOG_DIR/nanoclaw.error.log"
NODE_BIN="/usr/bin/node"
DIST_FILE="$PROJECT_DIR/dist/index.js"
PORT=3001

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

error() {
  echo -e "${RED}✗ Error: $1${NC}" >&2
  exit 1
}

warn() {
  echo -e "${YELLOW}⚠ Warning: $1${NC}" >&2
}

info() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Check prerequisites
if [ ! -d "$PROJECT_DIR" ]; then
  error "Project directory not found: $PROJECT_DIR"
fi

if [ ! -f "$DIST_FILE" ]; then
  error "dist/index.js not found. Run 'npm run build' first."
fi

if [ ! -d "$LOG_DIR" ]; then
  mkdir -p "$LOG_DIR" || error "Failed to create log directory: $LOG_DIR"
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  warn "node_modules not found. Installing dependencies..."
  cd "$PROJECT_DIR"
  npm install || error "Failed to install dependencies"
  cd - > /dev/null
fi

cd "$PROJECT_DIR"

# Function to kill process using port
kill_port_process() {
  local pid=$1
  echo "Killing process $pid on port $PORT..."

  # Try graceful kill first
  kill "$pid" 2>/dev/null || true
  sleep 1

  # Check if still running
  if kill -0 "$pid" 2>/dev/null; then
    echo "Process still running, force killing..."
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
}

# Stop existing instance if running (by PID file)
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill_port_process "$OLD_PID"
  fi
fi

# Check if port is already in use (may be by different process)
if command -v lsof &> /dev/null; then
  PROCESS_ON_PORT=$(lsof -i ":$PORT" -t 2>/dev/null || echo "")
  if [ -n "$PROCESS_ON_PORT" ]; then
    echo "Port $PORT is already in use by process $PROCESS_ON_PORT"
    kill_port_process "$PROCESS_ON_PORT"
  fi
elif command -v netstat &> /dev/null; then
  PROCESS_ON_PORT=$(netstat -tulpn 2>/dev/null | grep ":$PORT " | awk '{print $NF}' | cut -d'/' -f1 || echo "")
  if [ -n "$PROCESS_ON_PORT" ] && [ "$PROCESS_ON_PORT" != "-" ]; then
    echo "Port $PORT is already in use by process $PROCESS_ON_PORT"
    kill_port_process "$PROCESS_ON_PORT"
  fi
fi

# Final check: ensure port is free
sleep 1
if command -v lsof &> /dev/null; then
  if lsof -i ":$PORT" &> /dev/null; then
    error "Port $PORT is still in use. Unable to free it."
  fi
fi

echo "Starting NanoClaw..."

# Load .env if present (export each variable to the child process)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
else
  warn ".env file not found. Some features may not work."
fi

# Start the process
nohup "$NODE_BIN" "$DIST_FILE" >> "$LOG_FILE" 2>> "$ERROR_LOG" &
NEW_PID=$!

# Save PID
echo "$NEW_PID" > "$PID_FILE"

# Give it a moment to start and check if it's actually running
sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
  info "NanoClaw started (PID $NEW_PID)"
  echo "  Logs: tail -f $LOG_FILE"
  echo "  To stop: kill $NEW_PID"
else
  error "Process failed to start. Check logs: $ERROR_LOG"
fi
