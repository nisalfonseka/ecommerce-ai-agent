#!/usr/bin/env bash
# The reference store end to end, no API keys needed:
#   Medusa backend :9000 (scripts/reference-store.sh) → engine :8080 on the Medusa adapter with the keyless demo
#   model and COD on → worker (index, knowledge, webhooks) → storefront :8000 with the assistant widget installed.
# Usage: scripts/store-stack.sh [start|stop]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/ace-store-stack"
ENGINE_PORT="${ACE_ENGINE_PORT:-8080}"
SF_PORT="${ACE_STOREFRONT_PORT:-8000}"
STORE_PORT="${ACE_STORE_PORT:-9000}"
DB="${ACE_STORE_ENGINE_DB:-ace_store_engine}"
APP_PASSWORD="ace_store_app_password"
STOREFRONT="$ROOT/apps/reference-store/storefront"
SEED_OUTPUT="${TMPDIR:-/tmp}/ace-store/seed-output.json"

start_detached() {
  if command -v setsid >/dev/null 2>&1; then
    exec setsid nohup "$@"
  fi
  exec nohup "$@"
}

process_tree() {
  local pid="$1" child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do process_tree "$child"; done
}

stop_pid() {
  local file="$STATE/$1.pid"
  [ -f "$file" ] || return 0
  local pid pids
  pid="$(cat "$file")"
  pids="$(process_tree "$pid")"
  kill -- "-$pid" 2>/dev/null || kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 -- "-$pid" 2>/dev/null || kill -9 $pids 2>/dev/null || true
  rm -f "$file"
}

stop() {
  stop_pid storefront
  stop_pid worker
  stop_pid engine
  "$ROOT/scripts/reference-store.sh" stop >/dev/null
  rm -f "$STATE/connection.json"
  echo "stopped storefront, worker, engine and reference store (Postgres keeps running)"
}

wait_log() {
  local file="$1" text="$2"
  for _ in $(seq 1 120); do grep -q "$text" "$file" 2>/dev/null && return 0; sleep 0.5; done
  echo "timed out waiting for $text (log: $file)" >&2
  return 1
}

wait_store_ready() {
  local tenant="$1" store="$2" admin_key="$3"
  for _ in $(seq 1 240); do
    local sync docs
    sync="$(curl -fsS "http://localhost:$ENGINE_PORT/admin/tenants/$tenant/stores/$store/sync" \
      -H "authorization: Bearer $admin_key")"
    docs="$(curl -fsS "http://localhost:$ENGINE_PORT/admin/tenants/$tenant/stores/$store/knowledge" \
      -H "authorization: Bearer $admin_key")"
    if node -e 'const s=JSON.parse(process.argv[1]),d=JSON.parse(process.argv[2]),c=s.counts;process.exit(s.state?.status==="ready"&&c?.active>0&&c.enriched===c.active&&c.embedded===c.active&&c.staleEmbeddings===0&&d.items?.length>0&&d.items.every(x=>x.status==="ready")?0:1)' "$sync" "$docs"; then
      return 0
    fi
    sleep 0.5
  done
  echo "timed out waiting for indexed catalog and knowledge for $store" >&2
  return 1
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
  local psql
  psql="$("$ROOT/scripts/test-postgres.sh" bin psql)"
  "$psql" "$base" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
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
    start_detached node --import tsx src/main.ts > "$STATE/engine.log" 2>&1 &
  echo $! > "$STATE/engine.pid"
  wait_for "http://localhost:$ENGINE_PORT/healthz"
  node "$ROOT/scripts/connect-reference-store.mjs" "$SEED_OUTPUT" "http://localhost:$ENGINE_PORT" "$admin_key" \
    "http://localhost:$SF_PORT" > "$STATE/connection.json"
  chmod 600 "$STATE/connection.json"
  local key webhook_url webhook_secret
  key="$(node -e 'console.log(require(process.argv[1]).widgetKey)' "$STATE/connection.json")"
  webhook_url="$(node -e 'console.log(require(process.argv[1]).webhookUrl)' "$STATE/connection.json")"
  webhook_secret="$(node -e 'console.log(require(process.argv[1]).webhookSecret)' "$STATE/connection.json")"

  ACE_WEBHOOK_URL="$webhook_url" ACE_WEBHOOK_SECRET="$webhook_secret" \
    STOREFRONT_URL="http://localhost:$SF_PORT" "$ROOT/scripts/reference-store.sh" start >/dev/null

  cd "$ROOT/apps/worker"
  NODE_ENV=development DATABASE_URL="$app_url" ACE_MASTER_KEY="$master" \
    start_detached node --import tsx src/main.ts > "$STATE/worker.log" 2>&1 &
  echo $! > "$STATE/worker.pid"
  wait_log "$STATE/worker.log" "worker started"
  local tenant store
  tenant="$(node -e 'console.log(require(process.argv[1]).tenantId)' "$STATE/connection.json")"
  store="$(node -e 'console.log(require(process.argv[1]).storeId)' "$STATE/connection.json")"
  wait_store_ready "$tenant" "$store" "$admin_key"

  cd "$ROOT/packages/widget"
  node build.mjs >/dev/null
  cp dist/ace.js "$STOREFRONT/public/ace.js"

  cd "$STOREFRONT"
  [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error
  export MEDUSA_BACKEND_URL="http://localhost:$STORE_PORT"
  MEDUSA_PUBLISHABLE_KEY="$(node -e "console.log(require('$SEED_OUTPUT').publishableKey)")"
  MEDUSA_REGION_ID="$(node -e "console.log(require('$SEED_OUTPUT').regionId)")"
  export MEDUSA_PUBLISHABLE_KEY MEDUSA_REGION_ID NEXT_TELEMETRY_DISABLED=1
  export NEXT_PUBLIC_ACE_WIDGET_KEY="$key" NEXT_PUBLIC_ACE_API="http://localhost:$ENGINE_PORT" NEXT_PUBLIC_ACE_WIDGET_SRC=/ace.js
  node node_modules/next/dist/bin/next build > "$STATE/storefront-build.log" 2>&1 || {
    tail -30 "$STATE/storefront-build.log" >&2
    exit 1
  }
  start_detached node node_modules/next/dist/bin/next start -p "$SF_PORT" > "$STATE/storefront.log" 2>&1 &
  echo $! > "$STATE/storefront.pid"
  wait_for "http://localhost:$SF_PORT/"
  echo "storefront:  http://localhost:$SF_PORT"
  echo "engine:      http://localhost:$ENGINE_PORT  (logs: $STATE/engine.log)"
  echo "worker:      running (logs: $STATE/worker.log)"
  echo "medusa:      http://localhost:$STORE_PORT"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
