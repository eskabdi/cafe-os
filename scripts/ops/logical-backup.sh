#!/usr/bin/env bash
# Daily logical backup of a hosted CafeOS database (docs/operations/backups-and-dr.md).
#
# DRY RUN BY DEFAULT: without --execute it only prints the plan and checks the tools; it never connects.
# With --execute it asks you to type the database host before dumping (or set CONFIRM_HOST=<host> for an unattended job).
# The dump is READ-ONLY on the database. It never restores, never seeds, never writes to the database.
#
# Env:
#   SUPABASE_DB_URL       required: postgresql://... direct or session-pooler URL (secret; never echoed, never committed)
#   BACKUP_DIR            optional: output directory (default ./backups, git-ignored)
#   BACKUP_AGE_RECIPIENT  optional: an `age` public key; when set the dump is encrypted and the plaintext removed
#   CONFIRM_HOST          optional: skips the interactive prompt when it equals the database host
#
# Usage: scripts/ops/logical-backup.sh [--dry-run|--execute]
set -euo pipefail

mode="dry-run"
case "${1:-}" in
  --execute) mode="execute" ;;
  "" | --dry-run) ;;
  *) echo "usage: $0 [--dry-run|--execute]" >&2; exit 2 ;;
esac

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (secret) in the environment}"
out_dir="${BACKUP_DIR:-./backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="${out_dir}/cafeos-${stamp}.dump"

# host only (strip scheme, credentials, path, port) so nothing secret is printed
host="${SUPABASE_DB_URL#*://}"
host="${host##*@}"
host="${host%%/*}"
host="${host%%:*}"
case "$host" in
  127.0.0.1 | localhost) echo "refusing: $host is a local database; this script is for hosted backups" >&2; exit 2 ;;
esac

command -v pg_dump >/dev/null || { echo "pg_dump not found (install the PostgreSQL client matching the server major version)" >&2; exit 2; }

suffix=""
[ -n "${BACKUP_AGE_RECIPIENT:-}" ] && suffix=".age (encrypted)"
echo "mode:     $mode"
echo "host:     $host"
echo "schemas:  public, auth, storage (Storage OBJECTS are not in the database; copy them separately)"
echo "output:   ${file}${suffix}"
echo "pg_dump:  $(pg_dump --version)"

if [ "$mode" = "dry-run" ]; then
  echo "dry run: nothing was done. Re-run with --execute to dump."
  exit 0
fi

if [ "${CONFIRM_HOST:-}" != "$host" ]; then
  read -r -p "Type the database host ($host) to confirm the dump: " answer
  [ "$answer" = "$host" ] || { echo "not confirmed; aborting" >&2; exit 1; }
fi

mkdir -p "$out_dir"
umask 077
pg_dump --format=custom --compress=6 --no-password \
  --schema=public --schema=auth --schema=storage \
  --file "$file" "$SUPABASE_DB_URL"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "age not found; plaintext dump left at $file" >&2; exit 1; }
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "${file}.age" "$file"
  rm -f "$file"
  file="${file}.age"
fi

size="$(wc -c < "$file" | tr -d ' ')"
sum="$(sha256sum "$file" | cut -d' ' -f1)"
echo "done: $file ($size bytes, sha256 $sum)"
echo "Record it as service_role (backups-and-dr.md, 'Recording runs'):"
echo "  insert into public.platform_backup_runs (kind, status, finished_at, size_bytes, location, checksum_sha256)"
echo "  values ('logical_dump', 'succeeded', now(), $size, '<off-site location, no credentials>', '$sum');"
