# Argon2id benchmark: instructions for the deployment hardware

**Status:** the tool is ready and reproducible; **no deployment-hardware result exists yet.** Local figures below are indicative only (a developer laptop is not a server). Do not change the parameters from local numbers.

## What is configured

`src/modules/identity/password.ts`: `ARGON2_PARAMS = { memory: 47104 KiB (46 MiB), passes: 1, parallelism: 1, tagLength: 32, saltBytes: 16 }` — OWASP's first-choice Argon2id configuration. Parameters are stored inside every hash (`$argon2id$v=19$m=…,t=…,p=…`), verification honours the stored parameters (capped at 256 MiB / 10 passes / 4 lanes so a corrupt row cannot demand unbounded memory), and a successful login with a hash that differs from the current parameters re-hashes it (`auth_rehash_password`, compare-and-swap, never a downgrade, no forced reset). Changing `ARGON2_PARAMS` therefore migrates users lazily with no coordination.

## Run it (technical lead, on the deployment hardware)

```
cd apps/api
node --version                                   # must be >= 24.7 (crypto.argon2)
npm ci
npx tsx scripts/argon2-benchmark.mts --iterations 100 --concurrency 1,2,4,8,16,32 --candidates --out argon2-<host>-<date>.json
# or, for a build without tsx:  npm run bench:argon2 -- --iterations 100 --candidates
```

* Run it on an otherwise idle instance of the **same instance type, container CPU/memory limits and Node version** as production. Repeat at least three times at different times of day.
* It measures with the real `hashPassword`/`verifyPassword` code paths; passwords are random per run and never printed; **no hash is printed or stored**; it opens no database, network socket or `.env`, and changes no configuration.
* The libuv pool has 4 threads by default (`UV_THREADPOOL_SIZE`): at most 4 verifications run at once, which is what bounds concurrent memory (4 × 46 MiB ≈ 184 MiB of working set). If production sets a larger pool, run the benchmark with the same value.
* `--candidates` additionally times OWASP's equivalent alternatives (m=19456 t=2, m=12288 t=3, m=9216 t=4, all p=1). They are measured only.

## How to read the result (decision guidance, owner/lead decides)

1. **Sequential `verifyCorrectPassword` p95** is the user-visible cost of a login. A common target is roughly 100–500 ms; much below ~50 ms leaves safety margin unused, much above 500 ms hurts users and amplifies login-flood cost.
2. **`concurrency` rows**: find the concurrency at which p95 exceeds your latency budget, and compare with the login token buckets (5-token bucket per IP/account; see `docs/ACCOUNT-LIFECYCLE.md`). The sustainable login rate per instance is the `throughputPerSecond` at the pool size you run.
3. **`peakRssGrowthMiB`** must fit inside the container memory limit with headroom for the rest of the process (a login storm holds up to `threadpool × m` KiB at once).
4. If the numbers justify a change, edit `ARGON2_PARAMS` (never below OWASP's minimum equivalent: m ≥ 19 MiB with t ≥ 2, or m ≥ 46 MiB with t = 1, p = 1), ship it, and let logins migrate hashes lazily. Do not lower parameters to speed up tests.

## Local, indicative result (2026-11-21, developer machine)

Intel Core i7-1255U (12 logical CPUs), 31.6 GiB RAM, Windows 11, Node v24.16.0, default 4-thread pool, 25 iterations.

| Measure | p50 | p95 |
|---|---|---|
| hash (sequential) | 43.5 ms | 60.7 ms |
| verify, correct password | 44.7 ms | 56.7 ms |
| verify, wrong password | 43.5 ms | 52.8 ms |
| 1 concurrent verify | 43.0 ms | 49.3 ms (22.5/s, +47 MiB RSS) |
| 2 concurrent | 54.1 ms | 65.0 ms (35.5/s, +92 MiB) |
| 4 concurrent | 79.2 ms | 97.3 ms (46.4/s, +184 MiB) |

Observations: cost is flat for correct vs wrong passwords (no timing oracle from the hash), and memory grows linearly with concurrent verifications up to the pool size. These numbers say nothing about the server's CPU, memory bandwidth or container limits: **do not copy them into a decision.**

## Evidence

`test/argon2.benchmark.test.ts` (the script runs, reports the configured parameters and environment, and emits no hash or password); `test/auth.argon2id.test.ts` (migration, CAS, hostile parameters).
