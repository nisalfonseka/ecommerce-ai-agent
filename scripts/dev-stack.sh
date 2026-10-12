#!/usr/bin/env bash
# Local end-to-end stack without API keys: throwaway Postgres → migrate → seed (indexed catalog + knowledge) →
# engine + worker → widget build → demo store on :5173.
# Usage: scripts/dev-stack.sh [start|stop]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/ace-dev"
ENGINE_PORT="${ACE_ENGINE_PORT:-8080}"
DEMO_PORT="${ACE_DEMO_PORT:-5173}"
DB="${ACE_DEV_DB:-ace_dev}"
APP_PASSWORD="ace_dev_app_password"

stop() {
  for name in worker engine demo; do
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
  echo "stopped engine, worker and demo (Postgres keeps running: scripts/test-postgres.sh stop)"
}

wait_log() {
  local file="$1" text="$2"
  for _ in $(seq 1 60); do grep -q "$text" "$file" 2>/dev/null && return 0; sleep 0.5; done
  echo "timed out waiting for $text (log: $file)" >&2
  return 1
}

wait_store_ready() {
  local tenant="$1" store="$2" admin_key="$3"
  for _ in $(seq 1 120); do
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
  for _ in $(seq 1 60); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "timed out waiting for $1" >&2
  return 1
}

start() {
  mkdir -p "$STATE"
  stop >/dev/null
  local base
  base="$("$ROOT/scripts/test-postgres.sh" start | sed 's/^ACE_TEST_DATABASE_URL=//')"
  local psql
  psql="$("$ROOT/scripts/test-postgres.sh" bin psql)"
  local owner="${base%/postgres}/$DB"
  local app_url="postgres://ace_app:$APP_PASSWORD@${base#postgres://postgres@}"
  app_url="${app_url%/postgres}/$DB"
  "$psql" "$base" -qtAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1 \
    || "$psql" "$base" -qc "CREATE DATABASE $DB"

  cd "$ROOT/apps/engine"
  MIGRATION_DATABASE_URL="$owner" ACE_APP_DB_PASSWORD="$APP_PASSWORD" npx tsx src/migrate-cli.ts >/dev/null
  DATABASE_URL="$app_url" ACE_SEED_ORIGINS="http://localhost:$DEMO_PORT" npx tsx src/seed-cli.ts --json \
    > "$STATE/seed.json"
  local key
  key="$(node -e 'console.log(require(process.argv[1])[0].key)' "$STATE/seed.json")"

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

  cd "$ROOT/apps/worker"
  NODE_ENV=development DATABASE_URL="$app_url" ACE_MASTER_KEY="$ACE_MASTER_KEY" \
    nohup node --import tsx src/main.ts > "$STATE/worker.log" 2>&1 &
  echo $! > "$STATE/worker.pid"
  wait_log "$STATE/worker.log" "worker started"

  node -e 'for (const t of require(process.argv[1])) console.log(t.tenantId, t.storeId)' "$STATE/seed.json" \
    | while read -r tenant store; do
        curl -fsS -X POST "http://localhost:$ENGINE_PORT/admin/tenants/$tenant/stores/$store/sync" \
          -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
          --data '{"full":true}' >/dev/null
        wait_store_ready "$tenant" "$store" "$ADMIN_KEY"
      done

  cd "$ROOT/packages/widget"
  node build.mjs
  ACE_DEMO_KEY="$key" ACE_DEMO_API="http://localhost:$ENGINE_PORT" ACE_DEMO_PORT="$DEMO_PORT" \
    nohup node demo/server.mjs > "$STATE/demo.log" 2>&1 &
  echo $! > "$STATE/demo.pid"
  wait_for "http://localhost:$DEMO_PORT/"

  echo "demo store:   http://localhost:$DEMO_PORT"
  echo "engine:       http://localhost:$ENGINE_PORT  (logs: $STATE/engine.log)"
  echo "worker:       running (logs: $STATE/worker.log)"
  echo "admin key:    $ADMIN_KEY"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
