#!/bin/sh
# Runs one k6 scenario from tests/load/load.js against the LOCAL Supabase stack, and samples how busy the
# containers are while it runs, so the result says where the time went (database, REST layer, auth or gateway).
#
#   sh tests/load/run.sh registers                      # 60 teachers over 5 minutes
#   sh tests/load/run.sh parents_once -e SPREAD=60      # 500 parents, spread over a minute
#   sh tests/load/run.sh parents_once -e PARENT_VUS=60 -e SPREAD=60
#   sh tests/load/run.sh payments -e SMOKE=1            # a few users, to check the script
#
# Scenarios: parents, parents_once, registers, registers_burst, payments, signin (see load.js). Needs Docker,
# `supabase start` and tests/load/prepare.sh. k6 runs in a container on the Supabase network; the k6 image is
# pulled on first use. Results land in test-results/load/ (git-ignored): out_<scenario>.json (k6 summary),
# k6_<scenario>.txt, samples_<scenario>.csv and pg_<scenario>.csv. Do not run it while other tests use the database.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
[ $# -ge 1 ] || { echo "usage: sh tests/load/run.sh <scenario> [-e NAME=value ...]" >&2; exit 2; }
SCEN="$1"; shift
K6_IMAGE=${K6_IMAGE:-grafana/k6:0.54.0}
DB=${SUPABASE_DB_CONTAINER:-supabase_db_figbloom}
OUT=test-results/load
[ -f "$OUT/tokens.json" ] || { echo "no $OUT/tokens.json: run sh tests/load/prepare.sh first" >&2; exit 2; }

# The anon key is read from .env without printing it.
ANON=$(grep '^VITE_SUPABASE_ANON_KEY=' .env | cut -d= -f2-)
[ -n "$ANON" ] || { echo "VITE_SUPABASE_ANON_KEY is not set in .env" >&2; exit 2; }
# Docker on Windows wants a Windows-style path for a bind mount; elsewhere pwd is already right.
here=$( (pwd -W 2>/dev/null) || pwd )

rm -f "$OUT/samples_$SCEN.csv" "$OUT/pg_$SCEN.csv" "$OUT/stop_$SCEN"
(
  while [ ! -f "$OUT/stop_$SCEN" ]; do
    docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" "$DB" supabase_rest_figbloom supabase_auth_figbloom supabase_kong_figbloom 2>/dev/null \
      | sed "s/^/$(date +%H:%M:%S),/" >> "$OUT/samples_$SCEN.csv"
    docker exec "$DB" psql -U postgres -d postgres -At -F, -c "select to_char(now(),'HH24:MI:SS'), count(*) filter (where state='active'), count(*) filter (where wait_event_type='Lock'), count(*) filter (where state='idle in transaction'), count(*) from pg_stat_activity where datname='postgres'" >> "$OUT/pg_$SCEN.csv" 2>/dev/null
  done
) &
sampler=$!

MSYS_NO_PATHCONV=1 docker run --rm --network supabase_network_figbloom \
  -v "$here/$OUT:/data" -v "$here/tests/load:/k6:ro" \
  -e BASE=http://supabase_kong_figbloom:8000 -e ANON="$ANON" -e SCEN="$SCEN" "$@" \
  "$K6_IMAGE" run /k6/load.js --summary-export="/data/out_$SCEN.json" --quiet 2>&1 | tee "$OUT/k6_$SCEN.txt"
code=$?

touch "$OUT/stop_$SCEN"
wait "$sampler" 2>/dev/null
rm -f "$OUT/stop_$SCEN"
npx --no-install tsx tests/load/summary.ts "$SCEN"
exit "$code"
