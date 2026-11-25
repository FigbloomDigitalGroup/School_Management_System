# HR-run leave and the "HR & Payroll" handoff on the API: design note

Written 2026-11-25 against `dev-joe` at `1624da4d`, and updated the same day to match the My HR work as pushed
(`feature/api-my-hr` at `49dcb66c`, `apps/api/docs/MY-HR.md`). Design only: no code, no migration, no setting is added by this note.
It decides no product question. Those are listed in section 6 for the owner.

## 0. Scope, and what this note leaves out

Six web pages are HR-backed and are hidden on the API build today. The work on them is split like this:

| Part | Who | Where |
|---|---|---|
| My HR: payslips, balances, attendance, KPIs (the **view** routes `summary`, `payslips`, `payslip`, `leave`, `attendance`, `kpis`, and a status route) for `teacher/my-hr`, `staff/my-hr`, `admin/my-hr` | the My HR work (branches `feature/api-my-hr`, then `feature/web-api-my-hr`) | `apps/api/docs/MY-HR.md` on that branch (pushed, **not yet merged into `dev-joe`**). Routes `GET /v1/tenants/{tenantId}/me/hr/{status,summary,payslips,payslips/{payslipId},leave,attendance,kpis}`. |
| Loans (`teacher/loans`, `staff/loans`) | nobody | `staff/Loans.tsx` is a preview with no backend on Supabase either. The pages stay hidden. |
| The **HR-run leave actions** of the `my-hr` function: `leave_form`, `leave_applications`, `leave_apply`, `leave_cancel`, `approvals`, `approval_decide`. They serve `admin/leave-to-approve` and the HR parts of `teacher/leave` and `staff/leave`. | **this note** | sections 1 to 5 |
| The **"HR & Payroll" handoff**: `open-hr`, `hr_handoff_status`, the sidebar item | **this note** | sections 1 to 5 |

Everything below sits on top of the My HR work's platform token client, HR caller and settings. I read its pushed branch
(`MY-HR.md` and the code, read only). What these slices reuse:

- `src/platform/platformClient.ts`: `PlatformTokenClient` (token kept until a minute before expiry, one 401 retry) with
  `call(method, path, body, signal?)` for the platform's own API. It throws `PlatformError` with `.status` and `.code` (the
  platform's `error.code`, else `http_<status>`; status 0 for unreachable; `not_configured` without `PLATFORM_API_URL`). Config
  helper `platformTokenConfigFrom(config)`.
- `src/platform/hrApi.ts`: `callHr(tokens, url, call)`, which sends `x-figbloom-school` and `x-figbloom-person`.
- `src/modules/hr/hrRefusal.ts`: **one** mapper, `refusalFromHr(answer, {notFound?})`, plus `hrUnavailable()` and `hrBadAnswer()`.
  HR's `503 my_hr_off` is always `503 hr_off` there.
- The settings (all optional, unset means off) and the routes under `/v1/tenants/{tenantId}/me/hr/`. This note's routes go
  under the same prefix.
- Migration 108: `platform_school_links`, one row per school (`hr_enabled`, `hr_reason`, `hr_checked_at`). Nothing writes it yet.

`MY-HR.md` names this work as the next step: leave through HR and the handoff are "not in this slice" and "can reuse
`src/platform/` and `src/modules/hr/hrRefusal.ts`". Where this note says "as My HR", it means `MY-HR.md`.

**Contract documents.** The code cites `SCHOOLS_HR_HANDOFF_CONTRACT.md` (sections 1 and 3), `SCHOOLS_HR_LEAVE_CONTRACT.md`
(sections 2 and 3), `SCHOOLS_HR_PHASE1_CONTRACT.md` and `SCHOOLS_HR_PHASE2_CONTRACT.md`. **I did not find any of them** on the
Desktop. `C:\Users\Admin\Desktop\Projects\Figbloom Operations\docs\00-phase0-audit.md` (line 25) says the product-to-platform
contracts live in the `ERP` repo, and the platform is the `figbloomHR-platform` repo. The local `bloomHR` clone is dated
2026-10-30, which is before the Schools integration, so it has no HR routes. So section 2 is **what Schools' own code and
tests assume**, not what the platform or HR promise. Treat it as unverified until someone checks it against the real
contracts or a real call.

## 1. What each feature does today on Supabase

### 1.1 "HR & Payroll" (the handoff)

One click takes a person from the school's console into Figbloom HR, signed in. It is not a page. It is an action under
the menu (`sideActions` of `ConsoleShell`, from `apps/web/src/lib/useHrItem.ts`), shown in the admin, teacher and staff
consoles. It is not in `NAV`.

**Who sees it.** `hr_handoff_status(tenant)` (migration `20261105700000`) is the one rule. It refuses (`42501`) anyone but:

- the school's own administrator,
- an org admin of the school's **active** organisation (acting inside it),
- a teacher or other staff member who holds the **Fees** area (the bursar).

Figbloom staff (`super_admin`) are refused: HR has no account for them. For everyone else it answers one of:

| Value | Meaning |
|---|---|
| `off` | the switch `PLATFORM_HANDOFF_ENABLED` is off (the default) |
| `not_linked` | the platform does not know the school (no `platform_links` row: its registration was never delivered) |
| `not_enabled` | the platform said in the last hour that HR is not on or not linked for the school |
| `available` | show the item |

The web also asks `mayOfferHr` first (`packages/shared/src/hrHandoff.ts`), so a person who could never have it is not asked.
The answer is cached 60 seconds in the browser.

**The click.** The browser opens a blank tab inside the click (so the pop-up blocker allows it), calls `open-hr`, then sends
the tab to the answer's address. `open-hr` (`supabase/functions/open-hr/index.ts`):

1. asks `hr_handoff_status` **as the caller**; `off` and `not_linked` are refused, `not_enabled` is asked again (a click
   means the person expects it to work now);
2. reads the caller's profile and calls the platform: `POST /handoffs` with the school, and the person's id, name, role and
   **real** e-mail or `null` (a synthetic sign-in address such as `...@login.<slug>.figbloom.internal` is no e-mail);
3. records the platform's answer in `platform_module_status` (`platform_record_module_status`): a "yes" shows the item, a
   "no" hides it for one hour;
4. writes one audit event, "Opened HR & Payroll (one-time sign-in link)", category `access`. **The one-time code is never
   logged or audited.**
5. hands the browser the URL only if it is `https`.

The platform's refusals and what `open-hr` says:

| Platform | `open-hr` answers |
|---|---|
| 201 `{url, expires_at}` | 200 `{url, expires_at}` (the link works once and for about a minute) |
| 409 `target_not_enabled`, `target_not_linked`, `target_no_handoff_url` | 409 with that code and a sentence; recorded as a "no" |
| 404 (school unknown) | 409 `school_not_linked` |
| 429 | 429 `rate_limited` ("too many in the last minute") |
| unreachable, 5xx, no token | 503 `platform_unavailable` |
| any other URL than `https` | 502 `platform_bad_answer` |
| secrets not set | 503 `platform_not_configured` |

**Why it matters beyond the click.** The handoff does two other jobs. (a) It is the only way Schools learns whether HR is on
for a school: the platform's tenant lookup is console-only and the platform does not relay `platform.module.enabled` to
Schools. (b) It is how HR connects a **person** to an HR user: an approver who never opened HR & Payroll from Schools gets
`409 approver_not_linked` ("Open HR & Payroll once to connect your HR account.").

### 1.2 Leave run by HR

At a school where HR leave is on, staff apply for leave in Schools but **HR keeps the leave**: its form, balances and
approval chain. Approvers decide in Schools, as their own HR user.

**The rule.** `hr_leave_access()` (migration `20261105800000`) takes no argument and is about the caller only. It answers
`{status, approver}`.

- `status`: `not_staff` (not an active, non-archived `teacher`, `driver`, `staff` or `school_admin` at a school that is not
  suspended; an org admin acting for a school is never that school's staff), `off` (`HR_LEAVE_ENABLED` is off, the default),
  `not_linked`, `not_enabled`, `available`.
- `approver`: the school's admins, and staff who hold the **Leave** or the **Fees** area (head teacher, deputy, bursar).
- HR leave is on for a school when the switch is on **and** the school is linked **and** HR's last answer for it is not
  `target_not_enabled` / `target_not_linked`. Unlike the handoff item, that "no" does not wear off after an hour: which form a
  school uses must not flip back and forth.
- While it is on for a school, the school's own leave form is hidden and the database refuses a Schools-only request. The
  switch flips the **whole school**.

**What the pages do.** All go through the one `my-hr` function (`POST {route, ...}` with the person's JWT):

| Route | HR call | Used by |
|---|---|---|
| `leave_form` | `GET leave/form`: leave types and their rules, balances, the approval chain, `reason_min_length`, document limits | `teacher/leave`, `staff/leave` (HR mode) |
| `leave_applications` | `GET leave`: balances and the person's applications with approval progress | same |
| `leave_apply` | `POST leave/applications` `{type_id, start_date, end_date, half_day?, reason (10+ characters), document?: {name, content_type, base64}}`; document up to 3 MB | same |
| `leave_cancel` | `POST leave/applications/<id>/cancel` | same |
| `approvals` | `GET approvals`: what waits on this person's HR user | `admin/leave-to-approve` |
| `approval_decide` | `POST approvals/<id>/decide` `{decision: "approve"\|"decline", comment?}`, done in HR as that HR user | `admin/leave-to-approve` |

`staff/leave` exists only in HR mode (other staff had no leave page before HR). `teacher/leave` shows HR's form in HR mode
and the school's own form otherwise. The phone apps use the same shared modules (`apps/mobile/src/screens/admin/LeaveToApprove.tsx`,
`teacher/Leave.tsx`, `lib/useHrLeaveAccess.ts`).

**Leave to approve, in detail.** HR sends each waiting application: its id, the employee (number, name, `external_id`),
leave type, dates, days, half day, reason, the step this approver decides, the chain so far (step, status, who, comment),
and up to two document links (`document`, `followup_document`) that are valid **5 minutes** and opened directly.

The admin can read it, open a document, and **approve** or **decline**. A decline needs a comment (HR answers 422
otherwise; the button waits for one). Approving is final.

**Who decides whose turn it is.** Two parties, two questions:

- Schools decides who may **see the page**: the `approver` flag above, and `status = available`.
- **HR decides which applications wait on this person**, by its own chain and delegation, and answers `403
  not_your_approval` for a step that is not theirs and `409 already_decided` for a decided one. Schools does not model the
  chain.

HR's refusals, as `my-hr` words them:

| HR | `my-hr` answers |
|---|---|
| 404 `not_linked`, or 200 `{"status":"pending_hr"}` | 404 "Your HR record isn't ready yet. Ask the school's HR administrator." |
| 409 `approver_not_linked` | 409 `approver_not_linked`: "Open HR & Payroll once to connect your HR account." |
| 422 `leave_rules` | 422 `leave_rules`, HR's sentence and `problems[]` (one per rule, at most 20) |
| other 422 | 422 with HR's code and sentence |
| 400 | 400 `bad_request` |
| 409 `not_cancellable`, `already_decided`; other 409 | 409 with that code, or `conflict` |
| 403 `school_not_linked`, 401 `invalid_token` | 502 `hr_not_connected` |
| 403 `approver_no_access`, `not_your_approval`; other 403 | 403 with that code, or `hr_forbidden` |
| 413 | 413 `document_too_large` |
| 429 | 429 `rate_limited` |
| 503 `my_hr_off` | 503 `hr_off` |
| 5xx, unreachable, timeout, no token | 503 `hr_unavailable` |

**How HR's decision gets back.** HR emits `hr.leave.approved` and `hr.leave.cancelled`. The platform relays them, signed,
to the `platform-events` function. That writes the same `leave_requests` row the office's approval writes
(`source = 'hr'`, HR's application id, employee number, leave type, half day, days), so cover planning, the "Needs cover"
card and the timetable flags work unchanged. It sends the teacher the usual in-app notice, undoes cover for a cancelled
leave, and writes an audit event. Each delivery is applied once. Events of one application apply in order (an older event is
`stale`). A date change arrives as a cancel plus an approval of the same application, in either order. Leave that overlaps
other approved leave of the person is refused (409 `leave_overlaps`) for a person to look at. Switches: `PLATFORM_EVENTS_ENABLED`
and `HR_LEAVE_ENABLED`; until both are on the event is verified, recorded and acknowledged, not applied.

**What is audited in Schools.** The handoff (above) and the applied inbound events. **A decision made through `approval_decide`
is not audited in Schools**: the function logs nothing HR sends, and "HR audits every call".

### 1.3 Which page needs which call

| Page or control | Needs |
|---|---|
| `admin/leave-to-approve` | leave access (status and approver), `approvals`, `approval_decide`; the "HR & Payroll" button for `approver_not_linked` |
| `teacher/leave`, `staff/leave` (HR mode) | leave access, `leave_form`, `leave_applications`, `leave_apply`, `leave_cancel` |
| the "HR & Payroll" item (admin, teacher and staff shells) | `hr_handoff_status`, `open-hr` |
| (not here) `*/my-hr` | the My HR work |

On the API build today: `fetchHrLeaveAccess()` returns "off" when `onApi()`, `leaveCapabilities().hrLeave` is `false`,
`admin/leave-to-approve` is not registered, and `ApiConsole` passes no `sideActions`. So the school's own leave form is all
there is, and neither the item nor the approvals page shows.

## 2. The platform contract, as the code shows it

Names of settings only. No value is in the repo.

**Two upstreams, one token.**

1. The **Figbloom platform** API (`PLATFORM_API_URL`). Schools calls it for the handoff, school registration and events.
2. **Figbloom HR**'s integration API (`HR_MY_HR_URL`, e.g. `https://<hr>/api/integrations/my-hr`). It accepts the platform's
   token plus two headers.

**Authentication.** The client-credentials grant at the platform's Cognito token endpoint (`PLATFORM_TOKEN_URL`): `POST`,
`Authorization: Basic base64(PLATFORM_CLIENT_ID:PLATFORM_CLIENT_SECRET)`, form body
`grant_type=client_credentials&scope=platform/tenants.read platform/tenants.write`. The client is `schools-service-<env>`.
The answer's `access_token` and `expires_in` (3600 if missing) are cached until 60 seconds before expiry. A 401 from either
API drops the token and retries once. Errors from the token endpoint never carry the secret.

**Platform calls these two features use.**

| Call | Payload | Answer |
|---|---|---|
| `POST {PLATFORM_API_URL}/handoffs` | `{target: "hr", tenant_local_id: <the school's id>, person: {external_id: <the person's id>, name, email: <real e-mail or null>, role}, return_to?}` | 201 `{url, expires_at}` |

Refusals: `409 target_not_enabled`, `409 target_not_linked`, `409 target_no_handoff_url`, `404` (school not registered), `429`,
`5xx`. Platform error body: `{error: {code, message}}`. Timeout 10 seconds. Redirects are never followed.

**HR calls these two features use.** Every call: `Authorization: Bearer <platform token>`, `accept: application/json`,
`x-figbloom-school: <the school's id>`, `x-figbloom-person: <the person's id>` (left out for school-level calls). Methods are
`GET` and `POST` only. Timeout 15 seconds, 45 seconds with a document. Redirects are never followed. HR's JSON is passed on
as HR sent it. HR's refusal body is `{error: {code, message}}` (also read: `{code}`, `{error: "<code>"}`, `{message}`).

| Route | Answer (the fields Schools reads) |
|---|---|
| `GET leave/form` | `{leave_types: [{id, name, half_days, max_days_per_request, min_notice_days, earliest_start, available_from, one_per_month, document: {name, when, required_if_longer_than}, balance: {available_days}}], balances, approval_chain: [{label, waiting_on, skipped}], reason_min_length, document_max_bytes}` |
| `GET leave` | `{balances, applications: [{id, leave_type, start_date, end_date, days, half_day, status, reason, cancellable, approval: {steps: [{label, status, waiting_on, actor_name}]}}]}` |
| `POST leave/applications` | 201 `{application}`; 422 `leave_rules` `{problems: []}` |
| `POST leave/applications/<id>/cancel` | `{application}`; 409 `not_cancellable` |
| `GET approvals` | `{approvals: [{application_id, employee: {employee_number, name, external_id}, leave_type, start_date, end_date, days, half_day, reason, step_label, document: {name, url, expires_at}, followup_document, approval: {steps: [...]}}]}` |
| `POST approvals/<id>/decide` | `{request_status, application}`; 409 `approver_not_linked`, 409 `already_decided`, 403 `approver_no_access`, 403 `not_your_approval`, 422 (decline without comment) |

**Rate limits.** HR and the platform both answer `429`. The code holds **no numbers** (the web text says "in the last minute"
for the handoff and "in the last few minutes" for HR). I could not find them.

**Inbound, platform to Schools (`platform-events`).** `POST`, no session. Headers `x-figbloom-event`, `x-figbloom-delivery`
(the same on every retry), `x-figbloom-timestamp` (Unix seconds, within 5 minutes), `x-figbloom-signature`
(`sha256=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"`, secret `PLATFORM_WEBHOOK_SECRET`, compared in constant time).
Body at most 32 KB: `{event: {type, id, occurred_at, tenant_local_id, data}}`. For `hr.leave.*`, `data` is
`{application_id, external_id (the person), employee_number, leave_type, start_date, end_date, half_day, days, status}`.
2xx only once applied; a database failure is 500 so the platform retries.

**What is cached.** The platform token (until 1 minute before expiry); a platform "no" about HR (1 hour for the handoff
item, until the next answer for leave); the browser's last access answer (60 seconds). Nothing else.

**What Supabase stores for this.** `platform_settings` (switches `PLATFORM_HANDOFF_ENABLED`, `MY_HR_ENABLED`,
`HR_LEAVE_ENABLED`, `PLATFORM_EVENTS_ENABLED`, `PLATFORM_STAFF_EVENTS_ENABLED`, `PLATFORM_DECISIONS_ENABLED`), `platform_links`
(a school the platform knows), `platform_module_status` (the last platform answer about HR per school),
`platform_event_deliveries` (each delivery once), and the HR columns on `leave_requests`.

**What HR needs to know already.** HR answers only for an employee it has linked to the person. That link comes from the
`schools.staff.created/updated/left` events Schools sends (`platform-sync` queue), and an HR user comes from the handoff.
So HR knowing a school and its people depends on **school registration and staff events**, which the API does not have
(`PLATFORM-CONSOLE.md`, question Q1).

## 3. Port design for `apps/api`

### 3.1 What the API already is, and what that changes

- **Platform state.** My HR's migration 108 adds `platform_school_links` (tenant-scoped, forced RLS, `SELECT` only for the
  API). No row means `not_linked`. A row never asked about (`hr_enabled` NULL) means `available`: ask HR on each call. Only an
  explicit "no" in the last hour (`target_not_enabled`, `target_not_linked`) means `not_enabled`. **Nothing writes the row**: an
  operator does, until question 2 is decided, and migration 108 leaves the write grant to the slice that learns HR's state
  from the handoff. There are no `platform_settings` or event tables. `external_identities` (provider `supabase_auth`) maps a
  user to a Supabase user id, but there is no legacy school id.
- **Ids.** The API sends **its own** `tenants.id` and `users.id` (`x-figbloom-school`, `x-figbloom-person`), not the Supabase
  ones. HR and the platform know the Supabase ids, and `scripts/supabase-to-api` creates new ids over HTTP. Whether HR and the
  platform learn the API's ids is open: `MY-HR.md` Q1b. See risk R1 and question 3.
- **Org admins have no school powers** unless delegated (`ORG-ADMIN-POLICY.md`). Supabase lets any org admin of the school's
  organisation open HR & Payroll. On the API that needs a delegation or a decision.
- **Fees area.** `FEES_AREA_IMPLIED` is `resource.finance.read` and `.write`. The implied sets are exported so tests can pin
  them, and widening one is a security change, so HR permissions are **new codes**, not additions to those sets.
- **`leave_requests`** (migration 055) has `start_on`/`end_on`, status `declined`, `staff_user_id`, and two triggers that
  clash with HR rows: a reviewed request is final, `reviewed_by` is required and cannot be the staff member, and the identity
  fields are immutable once reviewed. Also `figbloom_app` may only `INSERT` and update five columns. HR events need a
  definer function and relaxed guards for `source = 'hr'`.
- **Request body limit is 64 KiB.** A 3 MB document does not fit in a JSON body. See slice L3.
- **No transaction across the HR call.** Transactions are bounded (statement 15 s, idle in transaction 15 s, pool 10). HR
  takes up to 15 s (45 s with a document). So: check permission and status in a short tenant transaction, release it, call
  HR, then open a second short one to record. Never hold a connection while waiting. My HR does the same: its rule and rate
  limit commit before any network call.
- **The "not configured" pattern.** Bloom, storage and reporting answer `503` with `{status: "not_configured", reason}` (for
  example `routes/ai.ts`, `routes/storage.ts`). E-mail (Resend) reports `not_configured` as a delivery result instead. The
  settings are all optional in `config.ts`; unset means off; a value that is set but unusable stops the start (names only).

### 3.2 Settings (names only)

Reuse the My HR work's names. Add only what these slices need, under the Supabase names.

| Name | Used by | Notes |
|---|---|---|
| `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET`, `PLATFORM_TOKEN_URL` | all | read by the My HR work (`MY-HR.md`). The secret is an ECS task secret in production. |
| `PLATFORM_API_URL` | handoff, leave | My HR reads and checks it but does not use it. The handoff needs it (`PlatformTokenClient.call("POST", "/handoffs", ...)`), and leave lists it as required too, as the Supabase config required all four platform settings. |
| `HR_MY_HR_URL` | leave | as My HR. https only. |
| `MY_HR_ENABLED` | My HR | not used here. My HR is off when it is not `true`. The handoff and leave have **their own** switches, as on Supabase, so My HR can be on while they are off. |
| `PLATFORM_HANDOFF_ENABLED` | handoff | **new**, boolean, default false, as `MY_HR_ENABLED` is read |
| `HR_LEAVE_ENABLED` | leave | **new**, boolean, default false |
| `PLATFORM_EVENTS_ENABLED`, `PLATFORM_WEBHOOK_SECRET` | slice L4 only | **new**. The secret is an ECS task secret (at least 32 characters, like the other HMAC keys). |

A feature is **on** only when its switch is true **and** the settings it needs are all set. My HR: `MY_HR_ENABLED` plus
`PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET`, `PLATFORM_TOKEN_URL`, `HR_MY_HR_URL`. The handoff: `PLATFORM_HANDOFF_ENABLED`
plus the three platform settings and `PLATFORM_API_URL`. Leave: `HR_LEAVE_ENABLED` plus the four of My HR and
`PLATFORM_API_URL`. Anything less is off.

Off follows My HR's behaviour (`MY-HR.md`, "exactly what off does"). **Proposed** for these routes: the status route answers
`200 {"status":"off"}` to a staff member (`not_staff` to anyone else); an action route answers `403` with a code of its own
(`handoff_off`, `hr_leave_off`, the Supabase codes, added to the OpenAPI `Error` enum); a person who may not use the route gets
`403 forbidden`; a school with no `platform_school_links` row gets `409 school_not_linked`. Nothing is sent to the platform or
HR and the token endpoint is not asked. The start logs one line per feature (`outcome` `off`, `on` or `incomplete`, with the
names of missing settings, never a value). Addresses must be `https` (loopback `http` only in local and test), which
`config.ts` already checks.

Production: plain values (the addresses, the switches) go in the task definition; the two secrets go in ECS task secrets.
Nothing goes in `env.example` but commented names.

### 3.3 Database (migration 109, or the next free number)

Forward-only. Migrations 106 (school audit), 107 (HE section instructor) and 108 (My HR) are taken. One migration per slice
that needs one.

- **Slice H1:** **no new table.** The handoff records the platform's answer in My HR's `platform_school_links`
  (`hr_enabled`, `hr_reason`, `hr_checked_at`). H1's migration gives `figbloom_app` `UPDATE` on those three columns only. That
  closes `MY-HR.md`'s open point "Who writes `not_enabled`?". It also adds the permission `resource.hr.handoff` and the audit
  type `hr.handoff.opened` (below).
- **Slice L1:** the permission `resource.hr.leave_approvals` and the audit type `hr.leave.decided`. Permissions are catalogue
  rows, so this is a small migration of its own.
- **Slice L4 only:** `platform_event_deliveries` (`delivery_id` primary key, type, school, outcome, detail), HR columns on
  `leave_requests` (`source`, `hr_application_id` unique per school, `hr_employee_number`, `hr_leave_type`, `half_day`,
  `days`, `hr_event_at`), changes to the two triggers so an HR row may be approved with no reviewer and cancelled or
  re-dated by HR, and one `SECURITY DEFINER` function `platform_hr_leave_event(...)`. It follows the pattern of
  `org_my_audit_events` (migrator owner, `search_path = pg_catalog, pg_temp`, `EXECUTE` for `figbloom_app` only) and must be
  listed in `SECURITY-DEFINER-INVENTORY.md` and its tests. It takes the school from the verified event, never from a session.
- **A platform `404`** (it does not know the school) is answered `409 school_not_linked` and **not recorded**, as on
  Supabase. A school with no row is already `not_linked`. Who writes the row is question 2.
- **Which "no" hides what.** The handoff item hides for **any** refusal in the last hour (`target_not_enabled`,
  `target_not_linked`, `target_no_handoff_url`), as `hr_handoff_status()` does. My HR hides only for the first two. Leave
  never lets a "no" wear off, as `hr_leave_on()` does. All three read the same three columns.

**Permissions (proposed codes).**

| Code | Held by | Why |
|---|---|---|
| `resource.hr.handoff` | `school_admin`; implied by the Fees area | the same people as today, minus org admins |
| `resource.hr.leave_approvals` | `school_admin`; implied by the Leave area **and** the Fees area | `approver` today |

Neither is added to `FEES_AREA_IMPLIED` or `LEAVE_AREA_IMPLIED`. They are added next to them, with their own pinned tests.
Whether they are delegable to org admins is question 6. **A permission alone is not enough.** A platform super admin holds
every permission, and Supabase refuses them (HR has no account for them); My HR refuses them for the same reason
(`x-figbloom-authz: authenticated` plus a role check in code, `MY-HR.md`). So every route here also checks in code that the
caller is an active member of the school and not a super admin. The staff-side leave routes (`leave/access`, `leave/form`,
apply, cancel) use My HR's rule alone: an active `teacher`, `driver`, `staff` or `school_admin` of a school that is not
suspended, acting for their **own** record (HR still decides).

### 3.4 Endpoints (proposed)

Paths are relative to `/v1/tenants/{tenantId}/me/hr/`, the prefix My HR uses, and follow its rules: the school and the
person come from the verified session (the path's school must be the session's school), nothing in a body or header can
name another, and the OpenAPI file carries `x-figbloom-authz`. The person's own applications list is **not** a new route:
`leave_applications` is HR's `GET leave`, which is `GET .../me/hr/leave` already.

| Method and path | Permission | Body | Answer |
|---|---|---|---|
| `GET handoff-status` | `resource.hr.handoff` | none | `{status: off \| not_linked \| not_enabled \| available}` |
| `POST handoff` | `resource.hr.handoff` | none | `{url, expires_at}` |
| `GET leave/access` | any member; only staff get past `not_staff` (as My HR's status) | none | `{status: not_staff \| off \| not_linked \| not_enabled \| available, approver: boolean}` |
| `GET leave/form` | same | none | HR's form |
| `POST leave/applications` | same | `{type_id, start_date, end_date, half_day?, reason, document?}` | `201 {application}` |
| `POST leave/applications/{id}/cancel` | same | none | `{application}` |
| `GET leave/approvals` | `resource.hr.leave_approvals` | none | `{approvals: [...]}` |
| `POST leave/approvals/{id}/decide` | `resource.hr.leave_approvals` | `{decision, comment?}` | `{request_status, application}` |
| `POST /v1/platform/events` (slice L4) | none: the signature | HR event | `{ok, applied, outcome}` |

A person who may not have the handoff is refused with the same audited 403 as any missing permission, so the answer says
nothing about other schools. Validation is HR's rule copied from `my-hr` (reason 10 to 2,000 characters, comment up to 1,000,
dates `YYYY-MM-DD`, at most 366 days, a half day is one day, an application id matches `[A-Za-z0-9_-]{1,64}`), and anything
else is passed to HR unchanged. Errors use the API's shape `{error: {code, message, request_id}}`. HR's refusals go through the **one** mapper,
`refusalFromHr`, so the leave routes read like the My HR routes. It does not know the leave-only refusals yet. L1 and L3 add
them **to that function**, with their codes, and to the OpenAPI `Error` enum: 409 `approver_not_linked`, 422 `leave_rules`
(with `problems[]` as details), 409 `not_cancellable`, 409 `already_decided`, 403 `approver_no_access`, 403 `not_your_approval`,
413 `document_too_large`. The mapper now turns HR's 400 and 422 into 400 `validation_error` and every 409 into `conflict`,
so the specific rows must be matched **before** those generic ones. The handoff's own refusals are mapped next to its route,
from `PlatformError.status` and `.code`: `409 target_not_enabled`, `target_not_linked`, `target_no_handoff_url` as the
platform sent them, `404` as 409 `school_not_linked`, `429`, and `5xx`, no token or a non-https URL through
`hrUnavailable()` and `hrBadAnswer()`. No automatic retry. A POST that reaches HR is
never repeated by the API. HR refuses repeats itself (`already_decided`, overlapping leave).

Spend rate tokens as My HR does: `consume_rate_token`, in the same short transaction, before any network call (My HR uses
30 a minute per person, 300 per school and 1,500 for the platform token, answering 429 with `Retry-After`). The handoff and
leave get their own buckets and share the token bucket. The numbers are chosen in review.

### 3.5 How a person's identity reaches the platform and HR

- The school and the person are the caller's own, read from the verified session (`tenants.id`, `users.id`). The browser
  never supplies them.
- **Handoff:** `person = {external_id, name, email, role}`. `email` is the person's real address or `null`. Reuse the
  `realEmail` rule (trimmed, lower case, `null` for a malformed address or one ending `.internal` or `.invalid`). `role` is the
  school role (`school_admin`, `teacher`, `staff`, or `org_admin` for an acting org admin).
- **HR calls:** `x-figbloom-school` and `x-figbloom-person`.
- **Which ids.** They are the API's own: `x-figbloom-school` is `tenants.id` and `x-figbloom-person` is `users.id`, not the
  Supabase ids (`MY-HR.md`). Whether HR and the platform know them is open (`MY-HR.md` Q1b, risk R1, question 3). On Supabase
  the handoff is also what links an approver's HR user to the person id it sends, so with the API's ids that link would be made
  against the API's `users.id`. Until the ids are settled, nothing here can reach a real person.

### 3.6 What the API must never log

The platform token and the client secret; the handoff `url` and its code (not in logs, not in audit, not in any error);
every HR answer and request (approvals, reasons, comments, names, balances); documents and their base64; HR's document
links; e-mails. Log only the allowlisted fields (`outcome`, `reason`, `error_class`, `status`, `route`, `tenant_id`,
`user_id`). HR's own sentence is shown to the person but never logged. Errors from the token endpoint carry its status and
its error code only.

**Audit (new types).** `hr.handoff.opened` (actor, school, no code). `hr.leave.decided` (actor, school, HR's application id,
decision; **no comment text, no employee name**). This closes the gap in section 1.2: Supabase did not audit decisions
in Schools. `hr.handoff.refused` is not needed: the permission denial is already audited.

### 3.7 How the pages call it

- `packages/shared/src/hrHandoff.ts` and `hrLeave.ts` get an `onApi()` branch next to the Supabase one (as `leaveApi.ts`
  does). `fetchHrLeaveAccess()` stops returning "off" on the API. `requestHrLink` and the leave functions call the routes above,
  not `invokeEdge`, which throws `NotOnApiError` on the API build.
- `leaveCapabilities().hrLeave` follows the access answer.
- `useHrItem` goes into the API shells through `sideActions` (admin, teacher, staff).
- Each page is registered in **its own** file, `apps/web/src/api/pages/hr-leave.pages.tsx`, by the slice that builds it.
  **This note registers nothing.** My HR's pages are in `my-hr.pages.tsx`.
- The phone apps use the same shared modules. Moving them to the API is a separate piece of work.

## 4. Slices

API first, then web. One pull request each. "Stub" means a fake platform and a fake HR in the tests, with no credentials.
The Supabase fakes (`supabase/functions/_shared/fakePlatform.ts`, `fakeHr.ts`) are the model: they already know `/handoffs`,
the token endpoint, `leave/form`, `approvals`, `decide`, and the events HR would send. The My HR work has a fake HR and platform for its own tests
(`test/support/fakeHr.ts`, per `MY-HR.md`); extend it with the leave routes, `approvals`, `decide` and `/handoffs`, do not
write a second.

| # | Slice | Delivers | Tests | Stub or real |
|---|---|---|---|---|
| H1 | API: handoff | the handoff call through `PlatformTokenClient.call`; `handoff-status`, `handoff`; `PLATFORM_HANDOFF_ENABLED`; write grant on `platform_school_links`; permission; audit; migration 109 | Negative first: parent, teacher without Fees, another school (path and `X-Tenant-Id`), org admin without delegation, super admin, suspended school; off, unset settings, no token (401 retry once), 404, each 409, 429, 5xx, timeout, non-https URL; one audit row and no code in it; the URL never in a log line. Permission registry, RBAC matrix, grants matrix, RLS catalogue tests | **Stub: fully** |
| H2 | Web and shared: the item | `onApi()` branches; item in the API shells; tab opened inside the click | Vitest on the shared module; the browser spec against a throwaway API with the fake platform | **Stub: fully** |
| L1 | API: leave access, approvals, decide | the three routes, `HR_LEAVE_ENABLED`, permission `resource.hr.leave_approvals`, audit `hr.leave.decided`, the leave-only refusals added to `refusalFromHr` | Negative first: not an approver, not staff, an org admin, another school; `approver_not_linked`, `approver_no_access`, `not_your_approval`, `already_decided`, decline without a comment (422), `pending_hr`, off, HR 401 once then 502; no HR body in logs | **Stub: fully** |
| L2 | Web: Leave to approve | page in `hr-leave.pages.tsx`; the "connect once" message with the HR button; document links opened only if `https` and not expired | component tests; browser spec | **Stub: fully** |
| L4 | API: inbound events | `POST /v1/platform/events`, signature check, `platform_event_deliveries`, HR columns and relaxed guards on `leave_requests`, `platform_hr_leave_event`, notice, audit; migration | Signature wrong, timestamp old, replay, wrong school, person of another school, not staff, `stale`, date change in both orders, overlap (409), cancel before approve, off; the existing school leave flow unchanged | **Stub: fully** (the platform signs with a test secret) |
| L3 | API and web: staff apply, cancel | `leave/form`, apply, cancel (the list is `GET me/hr/leave`, already built); the HR mode of `teacher/leave` and `staff/leave` | rules (`leave_rules` with `problems[]`), half day, reason length, dates; documents see below | **Stub: fully** |
| X | Switch-on check (not code) | one real handoff, one real approvals read, one real decision on a test school | a written checklist | **Real platform and HR only** |

**Order and dependencies.** H1 then H2. L1 needs H1 (the "connect once" step and the "is HR on" knowledge). L2 needs L1.
**L4 must be done before L3 goes live for any school**, because once staff apply in HR the school's own leave list,
attendance and cover must see HR's approvals. L3 needs L1 and L4. **Do not switch `HR_LEAVE_ENABLED` on for a school before L3
and L4**: the switch flips the school's whole leave to HR (section 1.2). If the owner wants approvals only (question 8), L1 and
L2 can go first with a different access answer, but that is a product change.

**Documents (L3).** HR takes a document with the application, up to 3 MB through the Supabase function (HR itself takes 5 MB;
its production sits behind a ~4.5 MB request limit, and base64 adds a third). The API's body limit is 64 KiB. Options: a
route-specific limit of about 4.2 MB for this one route, or a first upload to object storage (migration 090) and a second call
that sends it on. The leave type "Sick leave" requires a document, so without one that type cannot be applied for on the
API. Recommendation: L3 first **without** documents (those types say "apply in HR"), and a separate L3b once the owner picks
an option.

Checks every slice must pass, not repeated above: the OpenAPI file and its drift check, the permission registry test, the
RBAC matrix through the annotations, the grants matrix, the RLS catalogue, the definer inventory (L4), negative tests before
positive ones, `Idempotency-Key` not needed (HR refuses repeats).

## 5. Interim state until the port exists

| Option | What the person sees | Cost |
|---|---|---|
| A. Leave hidden, with a written reason (today) | nothing: no item, no approvals page, the school's own leave form | none |
| B. Register the page with a "not connected on the new system yet" screen | a screen for every approver, including at schools that never use HR | a page that says nothing true about the school; the Supabase page is hidden unless HR leave is on, so showing it to all is noise |

**Recommendation: A, for both features.** It is what the build does today, it is honest, and it avoids a page that cannot tell
a school that uses HR from one that does not. The reason is written today in `docs/WEB_ON_THE_NEW_API.md` ("Leave screens")
and `docs/handoffs/WEB-ON-API-TODO.md`. Keep it there (or in a per-area file, as the web docs ask for new areas), add the
handoff item to it, and correct the TODO row for `admin/leave-to-approve`, which lists `/leave-requests/{id}/review`. That is
the school's own review (`admin/leave`), not HR approvals, and it can mislead.

Say plainly to a school that uses HR and moves to the API: HR still works at its own address, and approvers can decide
there. What is lost is the one-click sign-in and the approvals page inside the app. The staff leave form stays the school's
own, so the school's leave and cover keep working.

## 6. Questions for the owner

Each is answerable in a line. This note decides none of them.

1. **Port at all?** Should HR leave and the handoff move to the API now, or stay on the Supabase edge functions until cutover (so a school that uses HR cannot move yet)?
2. **Registration.** Who registers schools (and sends staff events) to the platform for API schools: the API, or the other console (`PLATFORM-CONSOLE.md` Q1, `MY-HR.md` Q1)? Until then an operator inserts `platform_school_links` rows by hand, and without a row every HR feature says `not_linked`.
3. **Ids.** The API sends its own school and person ids (`MY-HR.md` Q1b), but the platform and HR know the Supabase ids. Should the platform learn the API's ids at registration (and HR re-link people), or should we send the old ids (a column on `platform_school_links` for the school and a mapping for people)?
4. **Credentials.** Will you give the API's environment its own platform service client (a separate `schools-service` client from Supabase's), and put its secret and the webhook secret in ECS task secrets?
5. **Network.** Will the platform and HR accept calls from the API's address (any allow-list)? What are the real platform, HR and handoff addresses for staging and production?
6. **Who opens HR & Payroll.** School admin and Fees-area holders as today? May an org admin (Supabase: yes; API policy: only by delegation)? May that be delegated?
7. **Who sees Leave to approve.** School admins plus the Leave and Fees areas as today?
8. **Approvals only?** May "Leave to approve" go live before staff apply through HR (so staff keep the school form), or must HR leave be switched on for a school as one piece?
9. **Documents.** Allow leave documents up to 3 MB (a larger limit on one route, or storage first), or ship without and say "apply in HR"?
10. **Audit and retention.** May the school's audit record who decided which HR application (id and decision, never the comment)? How long are handoff and decision rows kept?
11. **HR rows in the school's leave.** May HR's approvals relax the rule that a reviewed leave request is final (an HR row can be cancelled or re-dated), and should HR still cancel the person's own overlapping pending requests as Supabase does?
12. **Switching a school on.** Who decides, school by school, when `HR_LEAVE_ENABLED` and `PLATFORM_HANDOFF_ENABLED` apply, given that leave flips for the whole school?
13. **Contracts.** Can you share `SCHOOLS_HR_HANDOFF_CONTRACT.md` and `SCHOOLS_HR_LEAVE_CONTRACT.md` (the `ERP` repo)? Section 2 is unverified until someone reads them against a real call.

## 7. Effort, and risks

Days of one person who knows this code, with the fakes ready. They include tests and review fixes, not waiting for answers.

| Slice | Days | Notes |
|---|---|---|
| H1 handoff API | 2 to 3 | the platform call is small; the tests are most of it |
| H2 web item | 1.5 to 2 | shared branches, shells, e2e |
| L1 approvals API | 3 | the leave-only refusals go into the shared `refusalFromHr` |
| L2 approvals page | 2 | documents and "connect once" |
| L4 inbound events | 4 to 5 | the hardest: signature, triggers, definer function, ordering |
| L3 staff leave | 3 to 4 | plus 1 to 2 for L3b (documents) |
| Fake HR leave routes | 1 | if the My HR fake does not have them |
| X real-platform check | 1 to 2 | only when credentials and a test school exist |
| **Total** | **about 16 to 22** | 8 to 10 of them before any staff leave or event |

**Risks.**

- **R1 Ids.** The API sends its own `tenants.id` and `users.id`. HR and the platform know the Supabase ids. Unless the
  platform learns the API's ids at registration, or we send the old ones, HR answers `school_not_linked` or `not_linked` and no
  real call works, My HR's included. Open as `MY-HR.md` Q1b and question 3. It is the largest risk and not a coding one.
- **R2 Unverified contract.** Section 2 comes from Schools' own code and fakes. HR's real shapes, document limits, link
  lifetimes and rate limits are unconfirmed.
- **R3 Database guards.** `leave_requests` was built to forbid exactly what HR events do. Relaxing the triggers for one source
  must not weaken the school's own leave (a reviewed request stays final for `source = 'schools'`).
- **R4 One switch flips a school.** A school turned on before L3 and L4 loses its leave form.
- **R5 Org admins.** Copying Supabase's "any org admin" would break the API's delegation policy. The default here is the
  stricter one.
- **R6 Secrets and links.** The handoff URL is a one-time sign-in; a logged copy within its minute is an account takeover.
  HR document links are personal data for 5 minutes.
- **R7 Held connections.** Calling HR inside a transaction would exhaust the pool of 10 under a slow HR.
- **R8 Dependence on My HR.** These slices reuse `src/platform/`, `hrRefusal.ts` and migration 108, which are on
  `feature/api-my-hr` and not yet merged. Start after that PR merges (or rebase on it). Both also touch `config.ts`,
  `env.example` and the OpenAPI `Error` enum.

## 8. Agreed with the My HR work

I checked the points I had for the My HR session against `MY-HR.md` and its code. Nothing in them contradicts it, and they are
now facts used above: the shared `PlatformTokenClient.call` and `callHr`; one refusal mapper, to which L1 and L3 add the
leave-only refusals; HR's `503 my_hr_off` is `503 hr_off` on every route; the 64 KiB body limit matters only for leave
documents.

Two differences from my first draft, both settled by `MY-HR.md`:

1. **"Unknown" reads `available`.** A school with a `platform_school_links` row that was never asked about HR is `available`
   (ask HR on each call), and a school with no row is `not_linked`. My first draft would have recorded a "not linked" row from
   the handoff's `404`. Dropped: the handoff writes only the "yes" and the explicit "no".
2. **The ids are the API's own.** `x-figbloom-school` is `tenants.id` and `x-figbloom-person` is `users.id`, not the Supabase
   ids. Whether HR and the platform learn them is `MY-HR.md` Q1b, open and unsolved. My first draft treated sending the old
   ids as the way forward; it is now one of two options in question 3.
