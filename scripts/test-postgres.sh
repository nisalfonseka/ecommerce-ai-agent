#!/usr/bin/env bash
# Throwaway Postgres for @ace/db integration tests (no Docker needed).
# Usage: scripts/test-postgres.sh [start|stop]   — start prints the ACE_TEST_DATABASE_URL to export.
set -euo pipefail

PORT="${ACE_TEST_PG_PORT:-54329}"
DIR="${TMPDIR:-/tmp}/ace-test-pg"

find_pg_bin() {
  command -v "$1" 2>/dev/null && return 0
  local candidate
  for candidate in \
    /opt/homebrew/opt/postgresql@*/bin/"$1" \
    /opt/homebrew/opt/postgresql/bin/"$1" \
    /usr/local/opt/postgresql@*/bin/"$1" \
    /usr/local/opt/postgresql/bin/"$1" \
    /usr/lib/postgresql/*/bin/"$1"; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

INITDB="$(find_pg_bin initdb || true)"
if [ -z "$INITDB" ]; then
  echo "PostgreSQL server is missing: brew install postgresql@16 pgvector (macOS) or apt-get install postgresql-16 postgresql-16-pgvector (Debian/Ubuntu)" >&2
  exit 1
fi
BIN="$(dirname "$INITDB")"

# initdb refuses to run as root; a function also works on macOS's Bash 3.2, where empty arrays + set -u fail.
run_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

case "${1:-start}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = "0" ] && chown postgres "$DIR"
      run_pg "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
    fi
    if ! run_pg "$BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      run_pg "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -o "-p $PORT -k $DIR" -w start >/dev/null
    fi
    # Migrations create the vector extension; fail early with an install hint if the cluster lacks pgvector.
    if ! run_pg "$BIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -qc "create extension if not exists vector" >/dev/null 2>&1; then
      echo "pgvector is missing: brew install pgvector (macOS) or apt-get install postgresql-16-pgvector (Debian/Ubuntu)" >&2
      exit 1
    fi
    echo "ACE_TEST_DATABASE_URL=postgres://postgres@localhost:$PORT/postgres"
    ;;
  stop)
    run_pg "$BIN/pg_ctl" -D "$DIR/data" -w stop >/dev/null && echo "stopped"
    ;;
  bin)
    [ -n "${2:-}" ] && [ -x "$BIN/$2" ] || { echo "usage: $0 bin <postgres-command>" >&2; exit 2; }
    echo "$BIN/$2"
    ;;
  *)
    echo "usage: $0 [start|stop|bin <postgres-command>]" >&2
    exit 2
    ;;
esac
