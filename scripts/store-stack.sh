#!/usr/bin/env bash
# The reference store end to end, no API keys needed:
#   Medusa backend :9000 (scripts/reference-store.sh) → engine :8080 on the Medusa adapter with the keyless demo
#   model and COD on → storefront :8000 with the assistant widget installed.
# Usage: scripts/store-stack.sh [start|stop]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/ace-store-stack"
ENGINE_PORT="${ACE_ENGINE_PORT:-8080}"
SF_PORT="${ACE_STOREFRONT_PORT:-8000}"
DB="${ACE_STORE_ENGINE_DB:-ace_store_engine}"
APP_PASSWORD="ace_store_app_password"
STOREFRONT="$ROOT/apps/reference-store/storefront"
SEED_OUTPUT="${TMPDIR:-/tmp}/ace-store/seed-output.json"

stop_pid() {
  local file="$STATE/$1.pid"
  [ -f "$file" ] || return 0
  local pid
  pid="$(cat "$file")"
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 -- "-$pid" 2>/dev/null || true
  rm -f "$file"
}

stop() {
  stop_pid storefront
  stop_pid engine
  "$ROOT/scripts/reference-store.sh" stop >/dev/null
  echo "stopped storefront, engine and reference store (Postgres keeps running)"
}

wait_for() {
  for _ in $(seq 1 120); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2
  return 1
}

postgres_url() {
  if [ -n "${ACE_STORE_PG_URL:-}" ]; then echo "$ACE_STORE_PG_URL"; return; fi
  "$ROOT/scripts/test-postgres.sh" start | sed 's/^ACE_TEST_DATABASE_URL=//'
}

start() {
  mkdir -p "$STATE"
  stop >/dev/null
  STOREFRONT_URL="http://localhost:$SF_PORT" "$ROOT/scripts/reference-store.sh" start

  # Engine on a fresh database, so each start registers exactly one reference-store tenant.
  local base owner app_url
  base="$(postgres_url)"
  psql "$base" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
  owner="${base%/postgres}/$DB"
  app_url="postgres://ace_app:$APP_PASSWORD@${base#*://*@}"
  app_url="${app_url%/postgres}/$DB"
  cd "$ROOT/apps/engine"
  MIGRATION_DATABASE_URL="$owner" ACE_APP_DB_PASSWORD="$APP_PASSWORD" npx tsx src/migrate-cli.ts >/dev/null
  local master admin_key
  master="$(head -c32 /dev/urandom | base64)"
  admin_key="store-admin-$(head -c12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  NODE_ENV=development PORT="$ENGINE_PORT" DATABASE_URL="$app_url" ACE_MASTER_KEY="$master" \
    CONVERSATION_TOKEN_SECRET="$(head -c40 /dev/urandom | base64)" TRUST_PROXY_HOPS=0 \
    ADMIN_API_KEY_SHA256="$(printf %s "$admin_key" | sha256sum | cut -d' ' -f1)" \
    setsid nohup node --import tsx src/main.ts > "$STATE/engine.log" 2>&1 &
  echo $! > "$STATE/engine.pid"
  wait_for "http://localhost:$ENGINE_PORT/healthz"
  local key
  key="$(node "$ROOT/scripts/connect-reference-store.mjs" "$SEED_OUTPUT" "http://localhost:$ENGINE_PORT" "$admin_key" \
    "http://localhost:$SF_PORT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).widgetKey))')"

  cd "$ROOT/packages/widget"
  node build.mjs >/dev/null
  cp dist/ace.js "$STOREFRONT/public/ace.js"

  cd "$STOREFRONT"
  [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error
  export MEDUSA_BACKEND_URL="http://localhost:9000"
  MEDUSA_PUBLISHABLE_KEY="$(node -e "console.log(require('$SEED_OUTPUT').publishableKey)")"
  MEDUSA_REGION_ID="$(node -e "console.log(require('$SEED_OUTPUT').regionId)")"
  export MEDUSA_PUBLISHABLE_KEY MEDUSA_REGION_ID NEXT_TELEMETRY_DISABLED=1
  export NEXT_PUBLIC_ACE_WIDGET_KEY="$key" NEXT_PUBLIC_ACE_API="http://localhost:$ENGINE_PORT" NEXT_PUBLIC_ACE_WIDGET_SRC=/ace.js
  node node_modules/next/dist/bin/next build > "$STATE/storefront-build.log" 2>&1 || {
    tail -30 "$STATE/storefront-build.log" >&2
    exit 1
  }
  setsid nohup node node_modules/next/dist/bin/next start -p "$SF_PORT" > "$STATE/storefront.log" 2>&1 &
  echo $! > "$STATE/storefront.pid"
  wait_for "http://localhost:$SF_PORT/"
  echo "storefront:  http://localhost:$SF_PORT"
  echo "engine:      http://localhost:$ENGINE_PORT  (logs: $STATE/engine.log)"
  echo "medusa:      http://localhost:9000"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
