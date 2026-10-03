#!/usr/bin/env bash
# Throwaway-Postgres database test harness (no Docker / no Supabase stack needed).
#   initdb temp cluster -> Supabase-compat shim -> migrations -> seed -> pgTAP (pg_prove) -> teardown
# Usage: scripts/db-test.sh [--keep] [--no-tests] [test-file ...]
# Env:   PG_BIN (default: pg_config --bindir or /usr/lib/postgresql/16/bin), DB_TEST_PORT (default 54329)
# Real stack equivalents: `supabase db reset` and `supabase test db` (same migrations/seed/tests).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-$( (command -v pg_config >/dev/null && pg_config --bindir) || echo /usr/lib/postgresql/16/bin)}"
PORT="${DB_TEST_PORT:-54329}"
KEEP=0; RUN_TESTS=1; FILES=()
for a in "$@"; do
  case "$a" in --keep) KEEP=1 ;; --no-tests) RUN_TESTS=0 ;; *) FILES+=("$a") ;; esac
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cafeos-dbtest.XXXXXX")"
if [ "$(id -u)" -eq 0 ]; then
  chown postgres:postgres "$TMP"; chmod 755 "$TMP"
  AS_PG=(runuser -u postgres --)
else
  AS_PG=()
fi
PGDATA="$TMP/data"; SOCK="$TMP"

cleanup() {
  "${AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  if [ "$KEEP" -eq 0 ]; then rm -rf "$TMP"; else echo "kept: $TMP (socket dir, port $PORT)"; fi
}
trap cleanup EXIT

echo "==> initdb ($TMP)"
"${AS_PG[@]}" "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
"${AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -w -l "$TMP/server.log" \
  -o "-p $PORT -c listen_addresses='' -c unix_socket_directories='$SOCK' -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null

PSQL=("$PG_BIN/psql" -h "$SOCK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)

echo "==> Supabase shim + pgTAP"
"${PSQL[@]}" -f "$ROOT/supabase/tests/shim/00_supabase_shim.sql"
"${PSQL[@]}" -c 'create extension if not exists pgtap with schema extensions'

echo "==> migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  "${PSQL[@]}" --single-transaction -f "$f"
done

echo "==> seed"
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"

if [ "$RUN_TESTS" -eq 1 ]; then
  echo "==> pgTAP"
  if [ "${#FILES[@]}" -eq 0 ]; then FILES=("$ROOT"/supabase/tests/*.sql); fi
  pg_prove -h "$SOCK" -p "$PORT" -U postgres -d postgres --verbose "${FILES[@]}"
fi
echo "==> OK"
