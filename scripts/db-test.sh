#!/usr/bin/env bash
# Throwaway-Postgres database test harness (no Docker / no Supabase stack needed).
#   initdb temp cluster -> Supabase-compat shim -> migrations -> seed -> pgTAP (pg_prove) -> teardown
#
# Usage: scripts/db-test.sh [--keep] [--no-tests] [--no-race] [--upto <migration-file-prefix>] [test-file ...]
#   --upto 20261003001000   apply migrations only up to (and including) that one: lets a new test be run against the
#                           PREVIOUS schema to prove it fails before the fix (the seed is skipped when it needs a later one)
#   --no-race               skip scripts/db/race-tests.sh (real concurrent sessions; runs after both pgTAP passes)
# Env:   PG_BIN (default: PostgreSQL 15 if installed, matching supabase/config.toml major_version = 15; else
#        pg_config --bindir), DB_TEST_PORT (default 54329)
#
# Real-stack equivalents (same migrations / seed / tests; this is what CI runs):
#   supabase db reset   = migrations + supabase/seed.sql  (config.toml [db.seed] sql_paths = ["./seed.sql"])
#   supabase test db    = pg_prove --ext .pg --ext .sql -r  over supabase/tests (cwd = supabase/tests)
# This script invokes pg_prove the SAME way: recursive, both extensions, cwd = supabase/tests, sorted order,
# one session per file. With no file arguments that is exactly the real-stack file set.
#
# Layout contract (checked below): EVERYTHING under supabase/tests must be a self-contained pgTAP file named
# *.test.sql, because `supabase test db` executes every .sql/.pg file it finds. The plain-Postgres shim is in
# scripts/db/shim (never under supabase/tests).
#
# The superuser of the throwaway cluster is `supabase_admin` (like Supabase). Migrations, seed and tests run
# as the NON-superuser `postgres` the shim creates, so real-stack privilege differences surface here too.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${PG_BIN:-}" ]; then
  if [ -x /usr/lib/postgresql/15/bin/initdb ]; then PG_BIN=/usr/lib/postgresql/15/bin
  else PG_BIN="$( (command -v pg_config >/dev/null && pg_config --bindir) || echo /usr/lib/postgresql/16/bin)"; fi
fi
PORT="${DB_TEST_PORT:-54329}"
TESTS_DIR="$ROOT/supabase/tests"
KEEP=0; RUN_TESTS=1; RUN_RACE=1; UPTO=""; FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --no-tests) RUN_TESTS=0 ;;
    --no-race) RUN_RACE=0 ;;
    --upto) UPTO="${2:?--upto needs a migration prefix}"; shift ;;
    *) FILES+=("$1") ;;
  esac
  shift
done

# ── layout contract ──
bad="$(find "$TESTS_DIR" -type f ! -name '*.test.sql' -print)"
if [ -n "$bad" ]; then
  echo "supabase/tests may only contain *.test.sql pgTAP files (supabase test db runs every .sql/.pg file):" >&2
  echo "$bad" >&2
  exit 1
fi
for f in $(find "$TESTS_DIR" -type f -name '*.test.sql' | sort); do
  if ! grep -qE 'plan\(|no_plan\(' "$f"; then echo "pgTAP file without a plan: $f" >&2; exit 1; fi
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
  # --keep: fast (clean) shutdown, otherwise fsync=off + immediate would lose the tail of the data
  "${AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -m "$([ "$KEEP" -eq 0 ] && echo immediate || echo fast)" stop >/dev/null 2>&1 || true
  if [ "$KEEP" -eq 0 ]; then rm -rf "$TMP"; else echo "kept: $TMP (socket dir, port $PORT)"; fi
}
trap cleanup EXIT

echo "==> initdb ($TMP)"
"${AS_PG[@]}" "$PG_BIN/initdb" -D "$PGDATA" -U supabase_admin --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
"${AS_PG[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -w -l "$TMP/server.log" \
  -o "-p $PORT -c listen_addresses='' -c unix_socket_directories='$SOCK' -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null

PSQL_ADMIN=("$PG_BIN/psql" -h "$SOCK" -p "$PORT" -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
PSQL=("$PG_BIN/psql" -h "$SOCK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)

echo "==> Supabase shim (as supabase_admin)"
"${PSQL_ADMIN[@]}" -f "$ROOT/scripts/db/shim/00_supabase_shim.sql"

echo "==> migrations (as postgres)"
for f in "$ROOT"/supabase/migrations/*.sql; do
  b="$(basename "$f")"
  if [ -n "$UPTO" ] && [[ "${b:0:${#UPTO}}" > "$UPTO" ]]; then continue; fi
  echo "    $(basename "$f")"
  "${PSQL[@]}" --single-transaction -f "$f"
done

# The demo seed refuses to run unless it recognises the local Supabase stack (default JWT secret) or is explicitly
# opted in. This throwaway cluster has neither, so opt in for the seed session only.
echo "==> seed (as postgres, app.allow_demo_seed=on)"
PGOPTIONS="-c app.allow_demo_seed=on" "${PSQL[@]}" -f "$ROOT/supabase/seed.sql"

if [ "$RUN_TESTS" -eq 1 ]; then
  echo "==> pgTAP"
  export PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
  cd "$TESTS_DIR"
  if [ "${#FILES[@]}" -eq 0 ]; then
    pg_prove --ext .pg --ext .sql -r --verbose .
    echo "==> pgTAP, second pass (the suite must be re-runnable on the same database: helper install/cleanup is idempotent)"
    pg_prove --ext .pg --ext .sql -r .
  else
    # explicit subset: helpers (00_helpers.test.sql) always go first, then the requested files.
    # (On the real stack a single-file run needs the helpers to be installed already.)
    ARGS=(database/00_helpers.test.sql)
    for f in "${FILES[@]}"; do
      f="$(cd "$OLDPWD" && realpath "$f")"; ARGS+=("${f#"$TESTS_DIR"/}")
    done
    pg_prove --ext .pg --ext .sql -r --verbose "${ARGS[@]}"
  fi
fi
if [ "$RUN_TESTS" -eq 1 ] && [ "$RUN_RACE" -eq 1 ] && [ "${#FILES[@]}" -eq 0 ]; then
  echo "==> race tests (real concurrent sessions)"
  PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres bash "$ROOT/scripts/db/race-tests.sh"
fi
echo "==> OK"
