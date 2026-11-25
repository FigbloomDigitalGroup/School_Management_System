# Public school lookup by address

Written 2026-11-25. The one public read that lets a person who was handed a login id (a learner, a parent, a driver) sign
in on the web: `POST /v1/auth/login/login-id` takes the school's id, and the web only knows the school's address
(`/s/<slug>`). Code: `src/http/routes/publicSchools.ts`, `src/modules/tenancy/publicSchoolLookup.ts`. Tests:
`test/public.schoolLookup.test.ts` (negative first). No migration.

## Contract

`GET /v1/public/schools/{slug}`. No session, no tenant header (both are ignored if sent).

| Answer | When | Body |
|---|---|---|
| 200 | the address belongs to a school that is `active`, `trial` or `overdue` | `{ "tenant_id": "<uuid>", "name": "<school name>" }`, nothing else |
| 400 | the address is not 3 to 40 of `a-z`, `0-9`, `-` (the `tenants.slug` CHECK) | the standard `validation_error` body; checked before the database |
| 404 | nobody has the address, **or** the school is `onboarding`, `setup_stalled` or `suspended` | the standard not-found body, `{"error":{"code":"not_found","message":"Not found","request_id":"..."}}`, the same bytes as an unknown route |
| 429 | the caller's bucket is empty | the standard `rate_limited` body with `Retry-After` |

Every answer is `Cache-Control: no-store` (the API default), so a school that is suspended disappears at once and no shared
cache keeps an answer. Upper case is a 400: the web lower-cases and trims what the person typed before it asks (every
address the API makes is lower case).

The statuses that are found are the ones a person can sign in to on Supabase (`supabase/functions/_shared/signInStatuses.ts`,
`SIGN_IN_STATUSES`). The API has no `archived` school status; `suspended` is the closed one.

## How it answers

1. The slug is checked against `^[a-z0-9-]{3,40}$` (Zod). A malformed one is a 400 that takes no token and writes nothing.
2. One token from the caller's own bucket, `school_lookup:ip:<address>`, with the login limiter (`consumeAuthToken`,
   `AUTH_RATE_*`). An IPv6 caller is accounted per /64 (`junkBucketAddress`, as for the M-Pesa junk bucket), so new
   addresses in one network do not mint new buckets. An unresolvable address shares `school_lookup:ip:unknown` (fail closed).
3. One statement through `withIdentityAccess` (no tenant context):
   `SELECT t.id AS tenant_id, t.name FROM tenants t WHERE t.slug = $1 AND t.status IN ('active', 'trial', 'overdue')`.
   `tenants.slug` is UNIQUE, so it is one index probe whatever the answer, and the status filter is inside the statement,
   so a school that is not open never leaves the database.
4. A miss (unknown or not open, the same branch) writes `auth.school_lookup.missed` to `security_audit_events` with the
   slug and the address, no school and no actor, then answers 404. Hits are not written.

### Why no definer function (migration 111 was not used)

`tenants` is an identity-plane table: the runtime role has had `SELECT` on it since migration 009 and the login-id path
reads it the same way with no tenant context (`auth/service.ts`). A `SECURITY DEFINER` function would add a privileged
object that reads nothing the runtime role cannot already read. So: no migration, no definer, no grant, nothing in the
function inventory or the RLS catalogue changes.

## Rate limit

| | |
|---|---|
| Bucket | `school_lookup:ip:<address>` (IPv6: `<first 64 bits>::/64`; no address: `school_lookup:ip:unknown`) |
| Numbers | `AUTH_RATE_*`, today the defaults: 5 at once, then 2 every 5 s (24 a minute, 1,440 an hour, per address) |
| Cost | 1 for every lookup that passes the shape check, hit or miss |
| Shared with | nothing: its own bucket, so lookups never use up a person's login budget (`login:ip:*`) and the other way round |

`AUTH_RATE_*` also sets the login, password change, re-authentication, reset and invitation limits: raising it for the lookup
raises them too.

## Threat model

| Threat | What stops it |
|---|---|
| Listing or searching schools | There is no list, search, prefix or wildcard: exact equality on a value that passed `^[a-z0-9-]{3,40}$`; `%`, `_`, `*` and everything else are a 400 |
| Learning that a school exists but is suspended or not set up | The same 404 bytes and headers, the same single statement, the same audit write: unknown and not-open take one code path after the statement |
| Scanning for addresses | 5 then 2 every 5 s per address (IPv6 per /64); every answered miss is in the security log with the slug and the address; the access log has a line per 404 and 429 |
| SQL injection | The shape check, then one parameterised statement |
| Reading anything else about a school | Only `tenants.id` and `tenants.name` are selected; no tenant context is set; no other table is read |
| A session or tenant header changing the answer | The route reads neither (tested with a forged token, another school's teacher, a learner, mismatched headers) |
| Filling the security log | A row needs a token, so at most 24 a minute per address (the same bound as failed logins) |
| Load | A malformed slug costs no database work; a valid one is one bucket write, one index probe and (on a miss) one insert, under the pool acquire timeout |

Not claimed: constant time. A real slug walks the index to the row before the status check; an unknown one stops in the
index. The difference is microseconds inside a request that also writes the bucket and the audit row.

The school id is not a secret (it is what sign-in takes), and the address is a public URL. What the limit protects is the
list of schools on the platform and which of them are closed.

## What it deliberately does not do

- No search, list, autocomplete or "did you mean"; no county, crest, logo, counts, status, organisation or timezone.
- No "your school is suspended" message (Supabase's `resolve-login-id` said so; here a suspended school is the same 404).
- No check of the login id itself, and no masked name (Supabase's `resolve-login-id` returned "Esther H."). Sign-in
  answers generically.
- No lower-casing or trimming on the server; no CAPTCHA; no cache headers.

## Tests

`test/public.schoolLookup.test.ts`, through the real `figbloom_app` login:

- refused before the database: empty, upper and mixed case, too short and too long, `_`, `%`, `*`, quotes and comments, a
  tautology, a stacked `DROP TABLE`, NUL, space, dot, non-ASCII, a right-to-left override, regex and JSON: each the standard
  400, no bucket row, no audit row, `tenants` unchanged; a path that is not one segment, and `POST`, are unknown routes;
- one answer: an unknown address is the not-found body byte for byte (as an unknown route); onboarding, setup_stalled and
  suspended schools give the same status, body and headers; both write the same trail with no school or actor; a hit writes
  none; a prefix, a suffix or a near miss is not found;
- open schools: active, trial and overdue answer exactly `{tenant_id, name}`, `no-store`, no cookie, conforming to OpenAPI;
  the id is the one `login-id` sign-in takes;
- the caller does not matter: anonymous, forged tokens, a school administrator, another school's teacher and a learner (with
  their own and with another school's tenant header) get identical answers;
- the limiter with the production numbers: 5 then 429 with `Retry-After` (hits and misses alike, also for a real school);
  the shape check still answers 400 without a token; another address is untouched; IPv6 per /64; 30 guesses give 5
  answers and exactly 5 audit rows;
- the OpenAPI operation: public, no tenant, no `security`, the slug pattern of the code, a 200 of exactly `tenant_id` and
  `name`, only 200/400/404/429, and nothing else under `/v1/public/`.

Also updated: OpenAPI and `packages/shared/src/api/schema.d.ts`, the event kind in `modules/audit/audit.ts` and
`test/fixtures/schoolAuditClassification.json` (`hidden`: the `auth.` prefix is never shown to a school, and the event has no
school), and `RATE-LIMIT-POLICY.md`.

## Findings (numbered `lookup-1` ...)

lookup-1. **Login-id sign-in is laxer than the lookup.** `loginWithLoginId` refuses only a `suspended` school, so a login id
    at an `onboarding` or `setup_stalled` school signs in if someone has the school id; the product's rule (Supabase) is
    active, trial, overdue only. The lookup follows the product. Aligning login-id (and `auth_session_tenant_eligible`) is
    an owner decision. It rarely matters: a school is `onboarding` only until its first administrator accepts, and nothing
    in the API sets `setup_stalled`, `trial` or `overdue` today.
lookup-2. **No suspended-school message.** Supabase told people at a suspended school why they could not sign in (403
    `school_suspended`, never the reason). Here the lookup is a 404 by design and login-id is a generic 401, so the web can
    only say "school not found". If the owner wants the message back, it belongs after a correct password, not in the
    lookup.
lookup-3. **School computer rooms share one address.** 40 learners behind one public address who open the sign-in page
    together get 5 answers at once and the rest over about a minute (and the login limiter has the same numbers). The web
    should remember the answer per address on the device so a device asks once. A separate, larger budget for the lookup
    would need new configuration (an owner decision; not invented here).
lookup-4. **A distributed scan is slowed, not stopped.** Each address is limited; many addresses are not. There is no alert
    on `auth.school_lookup.missed` (the codebase has no alerting pattern for security events); an operator sees it by
    looking. Slugs are public URLs and the answer is an id and a name, so the exposure is the platform's school list.
lookup-5. **The shared `RateLimited` response says "per IP first then per account".** For this operation there is only the
    per-address bucket.
