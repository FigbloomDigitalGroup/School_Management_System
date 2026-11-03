#!/bin/sh
# Removes the load-test school and its accounts from the LOCAL database, and shows the table counts so you can
# check the database is back to what it was (after `npm run db:fresh`: tenants 11, students 419, invoices 419,
# payments 0, attendance 4030, marks 387, auth users 16). The database writes about a dozen "records removed"
# audit entries of its own for the deletion; they cannot be deleted.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
DB=${SUPABASE_DB_CONTAINER:-supabase_db_figbloom}
docker exec -i "$DB" psql -U postgres -d postgres -q < tests/load/cleanup.sql 2>&1 | grep -v -E '^WARNING:  skipping|^$'
docker exec -i "$DB" psql -U postgres -d postgres -At -F' ' -c "select 'tenants', count(*) from tenants union all select 'students', count(*) from students union all select 'invoices', count(*) from fee_invoices union all select 'payments', count(*) from payments union all select 'attendance', count(*) from attendance union all select 'marks', count(*) from marks union all select 'auth users', count(*) from auth.users"
