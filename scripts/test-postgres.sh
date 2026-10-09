#!/usr/bin/env bash
# Throwaway Postgres for @ace/db integration tests (no Docker needed).
# Usage: scripts/test-postgres.sh [start|stop]   — prints the ACE_TEST_DATABASE_URL to export.
set -euo pipefail

PORT="${ACE_TEST_PG_PORT:-54329}"
DIR="${TMPDIR:-/tmp}/ace-test-pg"
BIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")"
RUN_AS=()
# initdb refuses to run as root; use the postgres OS user when we are root.
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi

case "${1:-start}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "${#RUN_AS[@]}" -gt 0 ] && chown postgres "$DIR"
      "${RUN_AS[@]}" "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
    fi
    if ! "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -o "-p $PORT -k $DIR" -w start >/dev/null
    fi
    echo "ACE_TEST_DATABASE_URL=postgres://postgres@localhost:$PORT/postgres"
    ;;
  stop)
    "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" -w stop >/dev/null && echo "stopped"
    ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 2
    ;;
esac
