# Load test (QA 18)

How fast is the app for a realistic school, and what slows it down? These scripts build a school of 1,512
learners in the **local** Supabase database and replay what the apps really send, with [k6](https://k6.io) running
in a Docker container. Nothing here touches a hosted project: every script refuses any address but `127.0.0.1`.

```
npx supabase start && npm run db:fresh        # the local stack, seeded (Alliance's fee items are copied)
sh tests/load/prepare.sh                      # the school: about two minutes
sh tests/load/run.sh registers                # 60 teachers submit a register over 5 minutes
sh tests/load/run.sh registers_burst          # ... all 60 at the same instant
sh tests/load/run.sh payments                 # 100 payments recorded by 20 clerks
sh tests/load/run.sh parents_once -e SPREAD=60            # 500 parents open the app over a minute
sh tests/load/run.sh parents_once -e PARENT_VUS=60 -e SPREAD=60   # ... or 60 of them
sh tests/load/run.sh signin -e XFF=1          # 500 password sign-ins, each from its own address
npx tsx --env-file=.env tests/load/app-calls.ts   # one user: admin Dashboard, teacher register, parent home screen
docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/queries.sql       # the hot queries, with and without RLS
docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/experiments.sql   # what an index / split policies would buy (rolled back)
docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/helpers.sql        # cost of one permission check
docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/platform-scale.sql # does it grow with OTHER schools? (no load school needed)
sh tests/load/cleanup.sh                      # remove the school and check the counts
```

`STREAMS=2 PER_CLASS=10 TEACHERS=10 PARENTS=20 sh tests/load/prepare.sh` builds a small school, and `-e SMOKE=1`
shrinks a scenario to a few users: use both to check the scripts themselves. Run nothing else against the database
meanwhile (the Playwright tests and `scripts/run-rls-checks.sh` share it), and read the numbers with these in mind:

- **It measures a laptop.** The database, the API, auth and k6 all share one machine, and PostgREST uses its default
  pool of 10 database connections. Hosted compute will differ; compare runs with each other, not with a plan.
- **Requests carry minted tokens**, so the per-IP sign-in limit is not part of the result (`signin` measures sign-in
  on its own). The apps' own calls, in the order they make them, are in `load.js`.
- **Each request has a budget** (p95 under 2 s, a whole screen under 3 s) and a failed budget is a failed run. They
  fail today, on purpose: the slow requests are filed as bugs (see QA 18, FIG-1251). When one is fixed the run turns green.
- `tokens.json` and the other generated files go to `test-results/load/` (git-ignored). The tokens are signed with
  the local dev secret and are worthless anywhere else.
- Every run also samples container CPU: `summary.ts` prints it. A database near 1,000% with the REST layer idle means
  the queries themselves are the bottleneck, not the network or the apps.
