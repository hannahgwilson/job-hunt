#!/usr/bin/env bash
# Build the whole SQL layer in a throwaway local Postgres and (optionally) seed
# it, so migrations get exercised BEFORE they're pasted into the Supabase SQL
# editor. Nothing here ever touches the deployed database.
#
#   ./dev/local_db.sh              # build schema + migrations + functions + seed
#   ./dev/local_db.sh --no-seed    # build only
#   ./dev/local_db.sh psql         # open a shell on the built database
#   ./dev/local_db.sh stop         # shut the cluster down
#
# Needs Postgres on PATH (brew install postgresql@18 libpq). The cluster lives
# under $PGDIR and is disposable — delete it and re-run to start clean.
set -euo pipefail

PGDIR="${JH_PGDIR:-/tmp/jh-localdb}"
PGPORT="${JH_PGPORT:-55432}"
DB=jh
DEMO_UID=11111111-1111-1111-1111-111111111111
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export LC_ALL=C   # PG18 on macOS refuses to start without this
export PGOPTIONS='-c client_min_messages=warning'   # idempotency NOTICEs are noise here
PATH="/opt/homebrew/opt/libpq/bin:/opt/homebrew/bin:$PATH"
PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

case "${1:-build}" in
  stop) pg_ctl -D "$PGDIR/data" stop >/dev/null 2>&1 || true; echo "stopped"; exit 0 ;;
  psql) exec "${PSQL[@]}" -d "$DB" ;;
esac

if ! pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
  [ -d "$PGDIR/data" ] || { mkdir -p "$PGDIR/sock"; initdb -D "$PGDIR/data" -U postgres --auth=trust >/dev/null; }
  pg_ctl -D "$PGDIR/data" -o "-p $PGPORT -k $PGDIR/sock -h 127.0.0.1" -l "$PGDIR/pg.log" start >/dev/null
  sleep 2
fi

"${PSQL[@]}" -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" >/dev/null
run() { "${PSQL[@]}" -d "$DB" -q -f "$1"; }

echo "→ shim";       run "$REPO/dev/local_shim.sql"
echo "→ schema";     run "$REPO/schema.sql"
# Migrations first for their DDL. Several redefine functions that only exist
# once functions.sql has run, so failures here are expected and swallowed —
# the pass AFTER functions.sql is the one that has to be clean.
echo "→ migrations (DDL pass)"
for m in "$REPO"/migrations/*.sql; do "${PSQL[@]}" -d "$DB" -q -f "$m" >/dev/null 2>&1 || true; done
echo "→ functions.sql"; run "$REPO/functions.sql"
echo "→ migrations (verify pass — must be clean)"
for m in "$REPO"/migrations/*.sql; do
  run "$m" || { echo "✗ $(basename "$m") failed on top of functions.sql"; exit 1; }
done

if [ "${1:-build}" != "--no-seed" ]; then
  echo "→ demo seed"
  "${PSQL[@]}" -d "$DB" -q -c \
    "INSERT INTO auth.users (id,email) VALUES ('$DEMO_UID','demo@jobhunt.test') ON CONFLICT DO NOTHING;"
  run "$REPO/seed/demo_seed.sql"
fi

echo
echo "Ready. Query as the demo user:"
echo "  psql -h 127.0.0.1 -p $PGPORT -U postgres -d $DB \\"
echo "    -c \"select jsonb_pretty(get_action_queue('$DEMO_UID'));\""
