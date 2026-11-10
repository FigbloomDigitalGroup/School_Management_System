#!/bin/sh
# Builds the load-test school in the LOCAL database: 1,512 learners, 60 teachers, 500 parents, two terms of
# attendance, marks, invoices and payments (about two minutes). Remove it afterwards with tests/load/cleanup.sh.
#
#   sh tests/load/prepare.sh                                   # the full school
#   STREAMS=2 PER_CLASS=10 TEACHERS=10 PARENTS=20 sh tests/load/prepare.sh   # a small one, to check the scripts
#
# Needs `supabase start`, `npm run db:seed` (Alliance's fee items are copied) and the SERVICE ROLE key in .env.
# Refuses any database but the local one. Do not run it while other tests use the database.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
DB=${SUPABASE_DB_CONTAINER:-supabase_db_figbloom}
STREAMS=${STREAMS:-9}; PER_CLASS=${PER_CLASS:-42}; TEACHERS=${TEACHERS:-60}; PARENTS=${PARENTS:-500}
export TEACHERS PARENTS
psql() { docker exec -i "$DB" psql -U postgres -d postgres -q "$@"; }

if [ "$(psql -At -c "select count(*) from tenants where slug = 'load-test'")" != 0 ]; then
  echo "the load school already exists: run sh tests/load/cleanup.sh first" >&2; exit 1
fi
psql < tests/load/school-1-tenant.sql || exit 1
npx --no-install tsx --env-file=.env tests/load/accounts.ts || exit 1
psql -v streams="$STREAMS" -v per_class="$PER_CLASS" -v teachers="$TEACHERS" < tests/load/school-2-data.sql 2>&1 | grep -v -E '^WARNING:  skipping|^$' || exit 1
npx --no-install tsx --env-file=.env tests/load/tokens.ts
