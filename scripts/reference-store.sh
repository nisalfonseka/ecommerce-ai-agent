#!/usr/bin/env bash
# Local reference store (Medusa v2, ADR-006) on the throwaway Postgres; no Docker or Redis needed.
# Usage: scripts/reference-store.sh [start|stop|reset]
#   start  install deps if missing, create + migrate + seed the database once, run the backend on :9000
#   reset  stop, drop the database, then start (fresh seed, new keys)
#   stop   stop the backend (Postgres keeps running: scripts/test-postgres.sh stop)
# Keys and fixture IDs: $STATE/seed-output.json (holds a secret key; never commit it).
# ACE_STORE_PG_URL=postgres://user:pass@host:port/postgres uses that server instead of the throwaway one (CI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/apps/reference-store/backend"
STATE="${TMPDIR:-/tmp}/ace-store"
PORT="${ACE_STORE_PORT:-9000}"
DB="${ACE_STORE_DB:-ace_store}"
STOREFRONT_URL="${STOREFRONT_URL:-http://localhost:8000}"

stop() {
  if [ -f "$STATE/backend.pid" ]; then
    local pid
    pid="$(cat "$STATE/backend.pid")"
    # `medusa develop` runs a watcher plus a server, so stop the whole process group.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 -- "-$pid" 2>/dev/null || true
    rm -f "$STATE/backend.pid"
  fi
  echo "stopped reference store backend"
}

postgres_url() {
  if [ -n "${ACE_STORE_PG_URL:-}" ]; then echo "$ACE_STORE_PG_URL"; return; fi
  "$ROOT/scripts/test-postgres.sh" start | sed 's/^ACE_TEST_DATABASE_URL=//'
}

wait_for() {
  for _ in $(seq 1 120); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timed out waiting for $1 (logs: $STATE/backend.log)" >&2
  return 1
}

start() {
  mkdir -p "$STATE"
  stop >/dev/null
  local base url
  base="$(postgres_url)"
  url="${base%/postgres}/$DB"
  [ -d "$BACKEND/node_modules" ] || (cd "$BACKEND" && npm ci --no-audit --no-fund --loglevel=error)

  export DATABASE_URL="$url" PORT STOREFRONT_URL BACKEND_URL="http://localhost:$PORT"
  export STORE_CORS="${STORE_CORS:-$STOREFRONT_URL,http://localhost:5173}"
  cd "$BACKEND"
  if ! psql "$base" -qtAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
    psql "$base" -qc "CREATE DATABASE $DB"
    npx medusa db:migrate > "$STATE/migrate.log" 2>&1
    SEED_OUTPUT="$STATE/seed-output.json" npx medusa exec ./src/scripts/seed.ts > "$STATE/seed.log" 2>&1 || {
      echo "seed failed (log: $STATE/seed.log)" >&2
      tail -20 "$STATE/seed.log" >&2
      exit 1
    }
  fi
  # Logs live outside the project: the dev watcher restarts on any file change inside it.
  setsid nohup npx medusa develop > "$STATE/backend.log" 2>&1 &
  echo $! > "$STATE/backend.pid"
  wait_for "http://localhost:$PORT/health"
  echo "reference store: http://localhost:$PORT  (logs: $STATE/backend.log)"
  echo "keys + fixtures: $STATE/seed-output.json"
}

reset() {
  stop >/dev/null
  local base
  base="$(postgres_url)"
  psql "$base" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
  rm -f "$STATE/seed-output.json"
  start
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  *) echo "usage: $0 [start|stop|reset]" >&2; exit 2 ;;
esac
