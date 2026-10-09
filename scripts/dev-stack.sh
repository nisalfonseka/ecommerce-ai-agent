#!/usr/bin/env bash
# Local end-to-end stack without API keys: throwaway Postgres → migrate → seed (demo model) → engine on :8080
# (NODE_ENV=development) → widget build → demo store on :5173.
# Usage: scripts/dev-stack.sh [start|stop]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/ace-dev"
ENGINE_PORT="${ACE_ENGINE_PORT:-8080}"
DEMO_PORT="${ACE_DEMO_PORT:-5173}"
DB="${ACE_DEV_DB:-ace_dev}"
APP_PASSWORD="ace_dev_app_password"

stop() {
  for name in engine demo; do
    # Each service is a single node process (no npx wrapper), so its pid is the process to stop.
    if [ -f "$STATE/$name.pid" ]; then
      local pid
      pid="$(cat "$STATE/$name.pid")"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 "$pid" 2>/dev/null || true
      rm -f "$STATE/$name.pid"
    fi
  done
  echo "stopped engine and demo (Postgres keeps running: scripts/test-postgres.sh stop)"
}

wait_for() {
  for _ in $(seq 1 60); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "timed out waiting for $1" >&2
  return 1
}

start() {
  mkdir -p "$STATE"
  stop >/dev/null
  local base
  base="$("$ROOT/scripts/test-postgres.sh" start | sed 's/^ACE_TEST_DATABASE_URL=//')"
  local owner="${base%/postgres}/$DB"
  local app_url="postgres://ace_app:$APP_PASSWORD@${base#postgres://postgres@}"
  app_url="${app_url%/postgres}/$DB"
  psql "$base" -qtAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1 || psql "$base" -qc "CREATE DATABASE $DB"

  cd "$ROOT/apps/engine"
  MIGRATION_DATABASE_URL="$owner" ACE_APP_DB_PASSWORD="$APP_PASSWORD" npx tsx src/migrate-cli.ts >/dev/null
  local key
  key="$(DATABASE_URL="$app_url" ACE_SEED_ORIGINS="http://localhost:$DEMO_PORT" npx tsx src/seed-cli.ts --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].key))')"

  [ -f "$STATE/secrets" ] || {
    echo "ACE_MASTER_KEY=$(head -c32 /dev/urandom | base64)"
    echo "CONVERSATION_TOKEN_SECRET=$(head -c40 /dev/urandom | base64)"
    echo "ADMIN_KEY=dev-admin-$(head -c12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  } > "$STATE/secrets"
  # shellcheck disable=SC1091
  . "$STATE/secrets"
  NODE_ENV=development PORT="$ENGINE_PORT" DATABASE_URL="$app_url" ACE_MASTER_KEY="$ACE_MASTER_KEY" \
    CONVERSATION_TOKEN_SECRET="$CONVERSATION_TOKEN_SECRET" TRUST_PROXY_HOPS=0 \
    ADMIN_API_KEY_SHA256="$(printf %s "$ADMIN_KEY" | sha256sum | cut -d' ' -f1)" \
    nohup node --import tsx src/main.ts > "$STATE/engine.log" 2>&1 &
  echo $! > "$STATE/engine.pid"
  wait_for "http://localhost:$ENGINE_PORT/healthz"

  cd "$ROOT/packages/widget"
  node build.mjs
  ACE_DEMO_KEY="$key" ACE_DEMO_API="http://localhost:$ENGINE_PORT" ACE_DEMO_PORT="$DEMO_PORT" \
    nohup node demo/server.mjs > "$STATE/demo.log" 2>&1 &
  echo $! > "$STATE/demo.pid"
  wait_for "http://localhost:$DEMO_PORT/"

  echo "demo store:   http://localhost:$DEMO_PORT"
  echo "engine:       http://localhost:$ENGINE_PORT  (logs: $STATE/engine.log)"
  echo "admin key:    $ADMIN_KEY"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
