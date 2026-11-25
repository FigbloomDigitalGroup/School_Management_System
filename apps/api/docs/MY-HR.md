# My HR on the API

Written 2026-11-25. A staff member's own payslips, leave, attendance and KPIs from Figbloom HR (bloomHR), read only. This is
the API's version of the Supabase function `my-hr` and of the database rule `my_hr_status()`. **It is off by default.**
Nothing here was tried against a real HR or a real platform: the tests use a fake HR on this machine.

Not in this slice: leave applied for, cancelled or approved through HR, and the "HR & Payroll" hand-off. They can reuse
`src/platform/` and `src/modules/hr/hrRefusal.ts` and add their own routes next to these.

## The routes

All `GET`, under the school, for the caller's own record only. The school and the person come from the verified session (the
path's school must be the session's school). Nothing in a request can name another school or person: other query fields, headers
and a body are ignored.

| Route | Who | Answers |
|---|---|---|
| `/v1/tenants/{tenantId}/me/hr/status` | any member | `{ "status": "<state>" }` (200), see below |
| `.../me/hr/summary` | staff | HR's `summary`: employee, company, latest payslip |
| `.../me/hr/payslips` | staff | HR's `payslips` |
| `.../me/hr/payslips/{payslipId}` | staff | HR's `payslips/<id>`. The id is HR's own (1-64 letters, digits, `_`, `-`), else 400 |
| `.../me/hr/leave` | staff | HR's `leave`: types, balances, applications |
| `.../me/hr/attendance?from&to` | staff | HR's `attendance`. Real dates (`YYYY-MM-DD`), `from` not after `to`, at most 93 days, else 400 |
| `.../me/hr/kpis` | staff | HR's `kpis` |

Staff means an active member of the school with the role `teacher`, `driver`, `staff` or `school_admin`, in a school that is not
suspended. Parents, students, org admins acting for a school and Figbloom staff are not staff here: HR has no employee for them.
The routes are `x-figbloom-authz: authenticated` with this role check inside (no catalogue permission): a platform super admin
must never pass it, which a permission would not guarantee.

HR's JSON is passed on **as HR sent it** (OpenAPI: `MyHrAnswer`, an object with any fields). The API does not read or reshape
it. The one exception is HR's `{"status":"pending_hr"}` (the person's HR record is not approved yet), which becomes
`200 {"status":"pending_hr","message":"Your HR record isn't ready yet. Ask the school's HR administrator."}`.

## The status, and exactly what "off" does

`GET .../me/hr/status` is the rule of `my_hr_status()` for the caller. In this order:

| State | Means |
|---|---|
| `not_staff` | not an active staff member of this school (see above). Wins over everything below |
| `off` | My HR is not switched on for this API: `MY_HR_ENABLED` is not `true`, or `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET`, `PLATFORM_TOKEN_URL` or `HR_MY_HR_URL` is missing |
| `not_linked` | the school has no row in `platform_school_links`: the school is not registered with the platform for My HR |
| `not_enabled` | the platform said in the last hour that HR is not on (or not linked) for the school |
| `available` | show the page |

A school that has a row but was never asked about HR (`hr_enabled` is `NULL`) is **`available`**: "unknown" means "ask HR",
and HR answers on every call. Only a recent explicit "no" hides the page, and the data routes **ask HR again even then** (HR is
the authority), as the Supabase function does. A client shows My HR only for `available`.

**With nothing set (the default), exactly this happens:**

| Call | Result |
|---|---|
| `GET .../me/hr/status`, a staff member | `200 {"status":"off"}` |
| `GET .../me/hr/status`, anyone else | `200 {"status":"not_staff"}` |
| any data route, a staff member | `403`, error code `my_hr_off`, message "My HR isn't available yet." |
| any data route, anyone else | `403`, error code `forbidden`, message "My HR is for the school's staff." |
| a staff member of a school with no row, feature on | `409`, error code `school_not_linked`, message "This school isn't connected to Figbloom HR yet. Ask Figbloom." |

Nothing is sent to the platform or HR in any of these cases, and the token endpoint is not asked. At start the API logs one
line, `my_hr` with `outcome` `off`, `on` or `incomplete` (and the names of the missing settings, never a value).

## Settings

All optional. Unset means the feature is off. The names are the ones the Supabase `my-hr` function uses (the platform ones are
shared with `platform-sync` and `open-hr`).

| Setting | Meaning |
|---|---|
| `MY_HR_ENABLED` | `true` switches the feature on. Anything else, or unset, is off |
| `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET` | the schools service client of the Figbloom platform. **Secrets.** Never in the repo, never logged |
| `PLATFORM_TOKEN_URL` | the platform's token endpoint (`.../oauth2/token`), client-credentials grant |
| `HR_MY_HR_URL` | HR's base for My HR, e.g. `https://hr.example/api/integrations/my-hr` (no trailing slash; one is dropped) |
| `PLATFORM_API_URL` | the platform's own API. **My HR does not use it**; it is read and checked so the hand-off and registration slices share the name, and `PlatformTokenClient.call()` uses it |
| `MY_HR_HTTP_TIMEOUT_MS` | optional, default 15000 (100 to 30000): each call to the token endpoint or to HR, including reading the answer |

The feature is **on** only with `MY_HR_ENABLED=true` and the first four of `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET`,
`PLATFORM_TOKEN_URL`, `HR_MY_HR_URL` all set. A value that is set but unusable stops the start (the message names the setting,
never the value): every address must be `https`, with no credentials, query or fragment. `http` is accepted only for a loopback
host in `local` and `test`, which is how the tests use a fake HR.

`infra/` is not changed by this work. To switch it on in production someone adds these names to the ECS task (secrets for the
first two): `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET`, `PLATFORM_TOKEN_URL`, `PLATFORM_API_URL`, `HR_MY_HR_URL`,
`MY_HR_ENABLED`. The token request asks for the scope `platform/tenants.read platform/tenants.write`, as the Supabase client does.

## How the calls go

1. **Rule and rate limit** in one short transaction as the caller (`figbloom_app`, forced RLS), committed before any network
   call. Spent per call that would reach HR: 30 a minute per person, 300 per school, 1,500 for the platform token (429 with
   `Retry-After`).
2. **HR**, with no database connection held: `<HR_MY_HR_URL>/<path>` with the platform token and the headers `x-figbloom-school`
   (the school's id) and `x-figbloom-person` (the caller's user id). The token is kept until a minute before it expires and one
   fetch is shared by concurrent calls; a 401 is retried once with a fresh token; **redirects are never followed**; every call has
   a timeout that covers reading the answer; an answer is read up to 1 MiB; a client that disconnects cancels the call.
3. HR's JSON comes back as it was sent.

**Nothing HR sends is logged**, nor any token or secret. The logger has a fixed list of fields; the only My HR lines are the
route's name, the school's id and an outcome such as `timeout`. There is no audit row per read: the caller reads only their own
record and HR audits every call.

## HR's refusals, as a person reads them

One function, `refusalFromHr` in `src/modules/hr/hrRefusal.ts`, turns an HR answer into the API's error for every route that calls
HR. Same status, code and sentence on every route, so the leave routes added later read the same. It is the table in the header of
`supabase/functions/my-hr/index.ts`, in the API's error shape `{ "error": { "code", "message", "request_id" } }`.

| HR said | The API answers |
|---|---|
| 404 `not_linked`, or `{"status":"pending_hr"}` on an error | 404 `not_linked` / `pending_hr`: "Your HR record isn't ready yet. Ask the school's HR administrator." |
| 404 otherwise | 404 `not_found` ("That payslip isn't available." / "That isn't available in HR.") |
| 400, 422 | 400 `validation_error`, with HR's sentence when it is short and plain |
| 409 | 409 `conflict` |
| 401 (after the one retry), `school_not_linked`, `invalid_token` | 502 `hr_not_connected`: "Figbloom HR isn't connected to this school yet. Ask Figbloom." |
| 403 otherwise | 403 `hr_forbidden` |
| 429 | 429 `rate_limited`, with HR's `Retry-After` |
| 503 `my_hr_off` (HR's own switch) | **503 `hr_off`**: "My HR is switched off in Figbloom HR for now. Try again later." The same on every route |
| 5xx, no answer, timeout, redirect, no platform token | 503 `hr_unavailable` with `Retry-After: 30` |
| 2xx that is not a JSON object, or over 1 MiB | 502 `hr_bad_answer` |

The error codes `my_hr_off`, `school_not_linked`, `not_linked`, `pending_hr`, `hr_off`, `hr_forbidden`, `hr_not_connected`,
`hr_unavailable` and `hr_bad_answer` are added to the OpenAPI `Error` enum. The rows only the HR-run leave and approval routes
can meet (`approver_not_linked`, `leave_rules`, `not_cancellable`, `already_decided`, `approver_no_access`, `not_your_approval`,
413) are not in the table yet: the slice that adds those routes adds them to this function, with their codes.

## Linking a school (an operator, for now)

Migration 108 adds `platform_school_links`: one row per school, tenant-scoped, forced row security, `SELECT` only for the API
(117 adds the hand-off's update of the three HR-answer columns, below). **Nothing in the API adds or removes a row**, because it is
not decided who registers schools with the platform (Q1 below). Until then an operator adds the row, as the migrator, the way
the housekeeping functions are run (`OPERATIONS.md`):

```sql
-- the school is registered with the platform: My HR shows for its staff (when the feature is on)
INSERT INTO platform_school_links (tenant_id) VALUES ('<tenant uuid>') ON CONFLICT (tenant_id) DO NOTHING;

-- the platform's OWN id for the school (migration 117; Supabase: platform_links.platform_id). The HR & Payroll hand-off needs
-- it to ask whether HR is there for the school; without it that answer is "unknown". My HR does not use it.
UPDATE platform_school_links SET platform_tenant_id = '<the platform tenant id>' WHERE tenant_id = '<tenant uuid>';

-- take it away again: the status becomes not_linked
DELETE FROM platform_school_links WHERE tenant_id = '<tenant uuid>';

-- record the platform's "HR is not on" (hides My HR for an hour), or clear it
UPDATE platform_school_links SET hr_enabled = false, hr_reason = 'target_not_enabled', hr_checked_at = now() WHERE tenant_id = '<tenant uuid>';
UPDATE platform_school_links SET hr_enabled = NULL, hr_reason = NULL, hr_checked_at = NULL WHERE tenant_id = '<tenant uuid>';
```

`hr_reason` is the platform's refusal code. Only `target_not_enabled` and `target_not_linked` hide the page, as in
`my_hr_status()`; `target_no_handoff_url` does not, because My HR signs nobody in. The row is the same fact as Supabase's
`platform_links` (kind `tenant`) and `platform_module_status` (module `hr`) put together. The HR & Payroll hand-off (migration
117, `HR-HANDOFF.md` H1) now writes the platform's answer: the API may update `hr_enabled`, `hr_reason` and `hr_checked_at` of
its own school's row, and nothing else. Registration (adding and removing rows) is still an operator's.

## To switch it on (for the owner)

1. Set `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET`, `PLATFORM_TOKEN_URL`, `PLATFORM_API_URL`, `HR_MY_HR_URL` on the API task, then
   `MY_HR_ENABLED=true`. Restart it and check the `my_hr` log line says `on`.
2. Decide the two questions below, then link each school (SQL above).
3. A staff member of a linked school now gets `available`, and the web build shows My HR.

## Open questions for the owner

- **Q1: who registers a school with the platform?** `PLATFORM-CONSOLE.md` section 2: the API has no `platform-sync`, and
  console.figbloom.org may own registration. This slice decides nothing: `platform_school_links` is the single place the
  answer lands, and an operator fills it until then.
- **Q1b: which ids does HR know?** HR knows a school as the Supabase `tenants.id` and a person as the Supabase `profiles.id`
  (`x-figbloom-school`, `x-figbloom-person`). The API sends **its own** `tenants.id` and `users.id`. A school moved from Supabase with
  `scripts/supabase-to-api` gets new ids, so HR will answer `school_not_linked` (shown as 502 `hr_not_connected`) or `not_linked`
  (404, "Your HR record isn't ready yet") until the ids are mapped: either HR links the new ids, or the API keeps the old ones
  (a column on `platform_school_links` for the school and a mapping for people). Not decided and not built; if it is the second,
  the one place that chooses the ids is `gateMyHrRead` in `src/modules/hr/myHr.ts`.
- **Who writes `not_enabled`?** Answered by the hand-off (migration 117, `HR-HANDOFF.md` H1), as on Supabase: each
  `POST .../me/hr/handoff` records the platform's yes, or its `target_not_enabled`, `target_not_linked` or
  `target_no_handoff_url`. Only while the hand-off is switched on and people open HR from Schools.

## Where the code is

- `src/platform/`: `platformClient.ts` (`PlatformTokenClient`: token, `call(method, path, body)` for the platform's own API),
  `hrApi.ts` (`callHr`), `http.ts`. They know nothing about My HR.
- `src/modules/hr/hrRefusal.ts`: `refusalFromHr`, `hrUnavailable`, `hrBadAnswer` and the sentences.
- `src/modules/hr/myHr.ts`: the rule, the planners (what to ask HR for), the gate and rate limit, `MyHrGateway`.
- `src/http/routes/myHr.ts`: the routes. `migrations/108_my_hr_platform_links.sql`: the table.
- Tests: `test/myHr.unit.test.ts` (no database), `test/myHr.test.ts` (HTTP, the real login, a fake HR and platform in
  `test/support/fakeHr.ts`).
