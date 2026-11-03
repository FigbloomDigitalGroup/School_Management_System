#!/bin/sh
# Runs the SQL checks in supabase/rls-checks against the local database.
#
#   sh scripts/run-rls-checks.sh                          # every script
#   sh scripts/run-rls-checks.sh supabase/rls-checks/fees.sql   # just those named
#
# Needs `supabase start`, `npm run db:seed` and `npm run db:seed-org` (12 of the scripts read
# the second school). Every script rolls back, so the database is left as it was; don't run it
# while the browser tests or another script use the same database.
#
# A script fails the run when it prints a FAIL line, when it stops on an error (psql exits
# non-zero without printing FAIL, so the exit code counts too) or when it prints no result at
# all. KNOWN lines are filed defects and INFO lines are notes: neither fails the run.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

CONTAINER=${SUPABASE_DB_CONTAINER:-supabase_db_figbloom}
if [ "$#" -gt 0 ]; then files=$*; else files=$(ls supabase/rls-checks/*.sql); fi

failed=0
out=$(mktemp)
trap 'rm -f "$out"' EXIT

printf '%-38s %5s %5s %5s  %s\n' script PASS FAIL KNOWN result
for f in $files; do
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$f" > "$out" 2>&1
  code=$?
  pass=$(grep -c '^NOTICE:  PASS' "$out")
  bad=$(grep -c '^NOTICE:  FAIL' "$out")
  known=$(grep -c '^NOTICE:  KNOWN' "$out")
  if [ "$code" -ne 0 ]; then result="STOPPED (exit $code)"
  elif [ "$bad" -gt 0 ]; then result="FAILED"
  elif [ $((pass + known)) -eq 0 ]; then result="NO RESULTS"
  else result="ok"; fi
  printf '%-38s %5s %5s %5s  %s\n' "$(basename "$f")" "$pass" "$bad" "$known" "$result"
  if [ "$result" != ok ]; then
    failed=1
    grep -E '^NOTICE:  FAIL|ERROR|^psql:' "$out" | cut -c1-220 | head -12 | sed 's/^/    /'
  fi
done

if [ "$failed" -ne 0 ]; then echo "RLS checks FAILED." >&2; exit 1; fi
echo "RLS checks passed."
