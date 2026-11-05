# Figbloom School Systems

Multi-tenant school management for Kenyan secondary schools. Five roles, one
codebase, one deployment.

## What is here

```
apps/web/          React + Vite + TS + Tailwind — desktop console for every role
                   (platform, school admin, teacher, parent, student)
apps/mobile/       React Native (Android + iOS) — the parent, student and driver
                   mobile apps. apps/web also keeps a phone-mockup preview of the
                   student screens (StudentApp.tsx, wrapped in <PhoneFrame>) for
                   design reference — it isn't routed to; the desktop screens are
                   the real web app
apps/teacher-mobile/  React Native (Android only — iOS deferred, see its own
                   README) — the teacher app, a separate binary from apps/mobile
                   since a teacher's workflow doesn't fit that app's role union
packages/shared/   Domain logic used by all three apps: types, grading scale, fee
                   maths, attendance register, M-Pesa helpers, offline write queue
supabase/          Schema, row-level security, seed script, M-Pesa edge functions
e2e/               Playwright tests over the five critical flows
tests/integration/ Vitest tests against the local Supabase: sign-in per role, school isolation, who may record payments, billing
tests/security/    Vitest static checks (no database): HTML sinks and secrets in the client code, which edge functions are public, web headers, workflow hardening, and scripts/security-scan.sh run against seeded attacks
tests/integrity/   Vitest static checks (no database) on the migration files: naming and versions, the split organizations migration, row-level security on every table, and that the old schema.sql and rls.sql stay deleted (the migrations are the only schema)
```

## Running it

The web app talks to a real local Supabase — there is no mock-data mode anymore.

```bash
npm install
cp .env.example .env         # then fill in the values `supabase start` prints below
npx supabase start           # Postgres, Auth, Studio etc. in Docker — first run pulls images
npm run db:seed              # seeds the demo data (the first `supabase start` has already applied supabase/migrations)
npm run db:seed-org          # adds the org admin login (see "Seeded logins" below)
npm run dev                  # web on :5173 (or the next free port — Vite will say which)
npm run dev:mobile           # Metro, then `npm run android` or `npm run ios` -w @figbloom/mobile
```

`supabase start` prints `API_URL` and `ANON_KEY` — put those in `.env` as
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, and `SERVICE_ROLE_KEY` as
`SUPABASE_SERVICE_ROLE_KEY` (used only by `supabase/seed.ts`, never shipped to
the browser). `supabase/config.toml` moves every service off Supabase's usual
54321-54329 port block, onto 58321+ instead — Windows machines commonly reserve
54278-54377 and 54411-54510 for Hyper-V/WSL NAT (`netsh interface ipv4 show
excludedportrange protocol=tcp`), and Docker can't bind to those from the host.
If your machine doesn't have that reservation you can move the ports back.

## Seeded logins

`npm run db:seed` creates the demo schools and one login for each role below, and `npm run db:seed-org` adds the
org admin (it seeds the Kijani Ridge Group). Every one of them uses the same local-only password, `figbloom-dev`.
Against a hosted project the seed scripts refuse to run unless `ALLOW_REMOTE_SEED=1` is set, and then give every
login a random password instead.

| Role | Sign in as | School | Seeded by |
|---|---|---|---|
| Platform staff | `joyce@figbloom.co.ke` | none | `db:seed` |
| Org admin | `group@kijaniridge.sc.ke` | none (the Kijani Ridge Group owns the school) | `db:seed-org` |
| School admin | `principal@alliance.sc.ke` | Alliance High School | `db:seed` |
| Teacher | login ID `TC-0002` | Alliance High School | `db:seed` |
| Parent | login ID `PT-0002` | Alliance High School | `db:seed` |
| Student | login ID `ST-0002` | Alliance High School | `db:seed` |
| Driver | login ID `BD-0001` | Alliance High School | `db:seed` |

Staff with an email sign in with it. Everyone else picks their school and types their login ID; behind the scenes
that becomes `<id>@login.<school>.figbloom.internal` (`loginIdEmail()` in `packages/shared/src/auth.ts`). The seed
also creates a guard (`GD-0001`) and a receptionist (`RC-0001`).

## Resetting the local database

These only touch the Supabase running on this machine.

| To get | Run |
|---|---|
| Back to the full seeded state, from scratch | `npm run db:fresh` (that is `db:reset`, then `db:seed`, then `db:seed-org`) |
| Every migration re-applied and the data emptied | `npm run db:reset` |
| A freshly reset database seeded | `npm run db:seed`, then `npm run db:seed-org` |

The seeds only add data, so reset first on a database that is already seeded. `db:reset` can take about 15 minutes
when the Supabase CLI wants a newer Postgres image than the one on your machine: it re-pulls about 1.7 GB and the
log looks stuck, so check Docker before cancelling.

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `npm run test:unit` | Vitest on `packages/shared` (pure logic, including every mark from 0 to 100 against the KCSE, CBC and GPA grade tables typed out by hand in `gradeTables.test.ts`, and a seven-learner report card worked out on paper in `reportCardFigures.test.ts`, down to the text the PDF prints, the date a register is filed under at the Nairobi midnight boundary in `attendanceDates.test.ts`, and the CSV helpers and the learner import's every rule in `csv.test.ts` and `apps/web/src/lib/studentImport.test.ts`; also `tests/security`: what the code and configuration say about HTML sinks, secrets shipped to a browser or phone, the five public edge functions, the web host's headers and the two GitHub workflows, and `scripts/security-scan.sh` run in throwaway git repositories against every attack it promises to catch, then six it does not; needs `sh`, `git` and `node`, otherwise those tests are skipped; and `tests/integrity`: what the migration files say about themselves) | nothing |
| `npm run test:edge` | Deno tests for `supabase/functions` (including that `provision-student`, `provision-guardian` and `invite-admin` roll back a half-made account at every step, and that they should say so when the audit entry fails) | Deno |
| `npm test` inside `apps/mobile` or `apps/teacher-mobile` | Jest and React Native Testing Library: the child and exam switchers (parent app), and the "could not be sent" notice the queue-sync hook and the Homework due-date box (teacher app); each test asserts what the person sees, not just that it renders | Jest, nothing else running (no phone, no database) |
| `npm run test:integration` | Vitest in `tests/integration`: signs in as each of the seven roles above, then checks school isolation (rows, storage, edge functions), who may record a payment, the fee billing run and its audit trail, what a parent's Fees screen is built from, how the M-Pesa functions answer as deployed, what the server (not the screens) enforces for sign-in, tokens and sessions, the three public endpoints, entering and publishing marks per exam, class and subject (what a parent and a learner see, class means, withdrawing), and report cards from the marks to the card a family downloads (preparing, comments, who may read or change one, sending, withdrawing, the audit entries), and attendance (one row per learner and day, corrections, a register held on a phone and sent for real, the parent's and the report card's figure), and school setup (which schools can sign in by status, what a timetable save that is refused part-way leaves, what a cover assignment tells the substitute, why a grade changes with the class's level), and uploads (a name that climbs out of a school's folder, what the public bucket serves and to whom, who may overwrite a logo or a photo); one file at a time, because they share one database | the local stack, seeded with `db:fresh`; `edgeFunctionIsolation.test.ts` also needs the edge functions from `main` |
| `npm test` | Playwright over `e2e/` (`flows.spec.ts`; `reconciliation.spec.ts`, which reads every money figure on the admin, parent, student and group screens and compares it with the database; `signin.spec.ts`, wrong passwords, wrong portal and the emailed reset link, which uses the local mail catcher; `gradebook.spec.ts`, the grade, the means and the Publish button on the teacher gradebook as marks are typed, saving nothing; and `reportCards.spec.ts`, which prepares Form 2 West's 43 report cards, compares every row on the screen and every page of the PDF with the marks in the database, then sends one card to the parent and removes it again, desktop only; and `attendance.spec.ts`, which reads the admin Dashboard and Reports and the parent's Home against the attendance rows, submits and corrects a register, and holds one on a phone while someone else signs in; and `learners.spec.ts`, desktop only, which adds, imports (a real file through the file chooser), archives, restores and promotes learners on the People and Classes screens and checks a school of more than 1,100 learners; and `setup.spec.ts`, desktop only, which starts a new term, deletes a class and books a teacher into two classes through the Settings and Classes screens, and compares a one-level school with a mixed one; and `reports.spec.ts`, desktop only, which re-derives every figure on Reports, Performance, the CBE report, every platform page (Tenants, Organizations, Curriculum, Usage, Subscriptions, Invoices, System health, Incidents, Impersonation log, Audit trail) and the group dashboard from the database, drives the billing and payment dialogs, then archives learners, opens an empty school, adds 1,200 learners to pass 1,000 rows and signs in as each role to see who may open each screen; and `xss.spec.ts`, desktop only, which puts a hostile string into a learner, teacher, parent, school, class, subject, fee item, announcement, homework, incident, organization and a CSV cell, opens every screen that shows it as each role and checks nothing ran and nothing was injected; and `a11y.spec.ts`, desktop only, which opens every screen of all seven roles and the public pages at 1280, 768 and 390 px wide, runs axe-core (WCAG 2.0 and 2.1, A and AA) at 1280 and 390, and records anything cut off, scrolling sideways or logging a console error; and `usability.spec.ts`, desktop only, the keyboard (sign-in, focus rings, dialogs), every dialog and sign-in view at two widths, failed and slow requests, a double click on Pay, Submit register, Bill learners and Record payment, very long names (it renames a few rows and puts them back) and the accessibility settings. Both list each known bug as a test that is expected to fail, tagged `QA16-...` and its FIG id, and fail on any finding that no known bug accounts for), desktop then phone, one worker | the local stack, seeded, and the edge functions running |

`test:integration` refuses to start unless the Supabase URL is `127.0.0.1` or `localhost`
(`tests/integration/support/localGuard.ts`), so it cannot be pointed at the demo or a production project by mistake.
Only the URL and the anon key from `.env` reach those tests, never the service-role key. A new role or login goes in
`TEST_ROLES` in `tests/integration/support/signInAs.ts`; the smoke test picks it up.

Since the fee-record guards (an invoice with a payment, its term, its learner and its proof file cannot be deleted), the tests
that pay invoices cannot clean up after themselves: they use a term year of their own per run so they can run again, and
`npm run db:fresh` clears what they leave. The browser specs answer the app's own confirm box with `e2e/support/confirm.ts`.
`e2e/reports.spec.ts` seeds 1,200 learners with paid invoices to pass 1,000 rows and cannot remove them; run `npm run db:fresh` after it
and before `e2e/reconciliation.spec.ts` (which also differs from Reports once an archived learner has an invoice: FIG-1501).
The audit's final report and release recommendation are in `QA_REPORT.md`.

Playwright clears the local login-lookup log before it starts (sign-in by login ID is limited to 30 lookups per 10
minutes), so runs can follow each other. After a reboot or a Docker restart the edge-function container stays down,
and sign-in then fails in Playwright:
`docker restart supabase_edge_runtime_figbloom`. The first Playwright run after Vite starts can time out on the first
desktop test (a cold page load), which makes the rest of the desktop block show "did not run": run it again.

## Routes

| Route | Who |
|---|---|
| `/signin` | everyone, four methods behind one door |
| `/platform/*` | Figbloom staff — tenants, health, usage, incidents, subscriptions, invoices, impersonation, audit |
| `/s/:slug/admin/*` | school admin — dashboard, people, fees, announcements, fleet, term setup |
| `/s/:slug/teacher/*` | teacher — attendance, gradebook, timetable |
| `/s/:slug/parent/*` | parent — home, fees, results, inbox, account |
| `/s/:slug/student/*` | student — today, timetable, work, results, notices |
| `/s/:slug/driver` | driver — one full-screen start/end-trip page, no console shell |

Tenants resolve by **path**, not subdomain: one deployment, no wildcard DNS, and
a school's URL survives a domain change. Mobile bakes the slug into the session.

## Production database: `schools-db.figbloom.org` (self-hosted, since 5 Nov 2026)

Figbloom Schools runs on self-hosted Supabase on AWS (figbloom-platform,
"Figbloom Schools' database"), at `schools-db.figbloom.org`. Supabase Cloud is
no longer production. Wherever a section below says `supabase db push` or
`supabase functions deploy`, apply it to schools-db instead: bundle
`supabase/` (`supabase/migrations`, `supabase/functions`,
`supabase/config.toml`) as a `.tgz` in the platform's backups bucket under
`migrations/`, and run `sudo /opt/figbloom/supabase/apply-migrations.sh
<bundle>.tgz` on the host (SSM Run Command or Session Manager; the
figbloom-platform README has the steps). It applies only the migrations the
database hasn't run. Function secrets on that host live in the functions
container's environment, not `supabase secrets set`.

The edge functions there sit behind the ALB and Envoy, so the per-caller rate
limits need `CLIENT_IP_HEADER=x-forwarded-for` and `TRUSTED_PROXY_HOPS=2`
("Rate limits on the public functions").

## Figbloom console (`platform-schools`)

Figbloom's own console (console.figbloom.org) lists every school and can suspend
or reactivate one. Its backend (bloomHR's `/api`) calls the edge function
`platform-schools` server to server; no browser calls it.

- **What it answers:** `{"action": "list"}` gives each school's id, name, slug,
  status (as stored, e.g. `active`, `trial`, `suspended`), status reason, group,
  created date, the first school admin's email (`admin_email`), the school's
  admins (`admins: [{email, name, role: "school_admin"}]`: every school admin
  who is not archived and has a real email, synthetic login addresses dropped,
  oldest first, at most 20; the console invites them to Figbloom HR;
  `20261105610000_console_school_admins.sql`), counts of learners, teachers and
  parents, and the latest sign-in at that school. Nothing else personal.
  `{"action": "set_status", "school_id", "status": "suspended" | "active",
  "reason", "actor_email"}` suspends (reason required) or reactivates a
  suspended school. Only a school that is `active`, `trial` or `overdue` can
  be suspended from the console; `onboarding` and `setup_stalled` answer 422
  (`20261104800000_console_suspends_working_schools.sql`). `"active"` means reactivate: the school gets back the
  status it had before it was suspended (`trial`, `overdue`, ...), or `active`
  if none was recorded, and the returned row shows it. Errors are
  `{"error": {"code", "message"}}`: 400 bad input, 404 no such school, 409
  already suspended / not suspended, 422 a status the console can't set.
- **Same suspension as our own console.** It updates `tenants.status`, so the
  school's users lose access and are banned in Auth exactly as when Figbloom
  staff suspend it here (`20261026080000_suspended_tenants_and_orgs.sql`).
  Every suspension, from either console, remembers the previous status in
  `tenants.status_before_suspension`. The SQL is in
  `20261104600000_platform_console_schools.sql`; only the service role can run it.
- **Reasons are written for the school to read.** The reason is shown to the
  school (`tenants.status_reason`, and its audit log, where the change is by
  "Figbloom (via Figbloom console)"). The Figbloom staff member's email is
  never on the school's side: it is kept only in an audit event with no
  school, which only Figbloom staff (super admins) can read.
- **What the school's people see.** Sign-in on the web and both phone apps
  says "Your school's account is suspended. Please contact your school's
  administrator or Figbloom support." (with `FIGBLOOM_SUPPORT_EMAIL` from
  `packages/shared/src/legalLinks.ts`), never the reason: for a login ID at a
  suspended school (resolve-login-id answers `school_suspended` before looking
  at the ID), for Auth's `user_banned`, and for a session that was already
  open (`my_school_suspended()`). The school picker lists suspended schools so
  their people can be told.
- **The secret.** JWT verification is off for this function; instead the
  `x-platform-secret` header must equal the function secret
  `PLATFORM_CONSOLE_SECRET` (compared in constant time). Unset, or shorter
  than 32 characters, refuses everything with 401. Generate it, set it, and
  give the same value to the console backend as `SCHOOLS_PLATFORM_SECRET`.
  Never commit it:

  ```bash
  openssl rand -hex 32                                     # copy the output
  supabase secrets set PLATFORM_CONSOLE_SECRET=<that value>
  ```

- **Deploy:** apply the migration, then the function.

  ```bash
  supabase db push                                         # 20261104600000_platform_console_schools
  supabase functions deploy platform-schools --no-verify-jwt
  ```

  Checks: `deno test --allow-env --config supabase/functions/deno.json supabase/functions/platform-schools`
  and `supabase/rls-checks/platform_console.sql` against a seeded local database.

## Figbloom platform registration

Figbloom Schools registers its organisations and schools with the Figbloom
platform, and follows the platform's organisation decisions (design 5.8;
the platform side is figbloomHR-platform, "Organisations and product
registration (5.8)"). On the platform an organisation is the unit Figbloom
staff approve, reject, suspend and reactivate.

- **Every school belongs to an organisation** (`20261104920000`): a single
  school has its own, named after it. A school created without one (staff
  onboarding, a seed, a script) gets its own first, by a trigger;
  `tenants.organization_id` is NOT NULL, and an organisation with schools
  can't be deleted. Staff take a school out of a group with "A new
  organization of its own" (`give_school_own_organization()`). The migration
  gives every school that has none today its own; to see which before
  deploying: `select name, slug from tenants where organization_id is null`.
- **Suspending an organisation locks out all its schools**
  (`20261104910000`). When it becomes `suspended` or `rejected`, each of its
  schools that isn't already suspended is suspended through the school's own
  status (Auth ban, `my_tenant()`), exactly as a single suspended school, and
  is recorded as held by the organisation. When the organisation is
  reactivated, only those schools come back, each to the status it had. A
  school suspended on its own (before, or by Figbloom staff while the
  organisation was suspended) stays suspended; a new school added to a
  suspended organisation starts suspended; a school moved out of one into a
  working organisation is restored. One school of a suspended organisation
  can't be reactivated on its own (reactivate the organisation).

- **Registering** never blocks Schools. Creating an organisation or school,
  or changing its name, slug or organisation, queues it in
  `platform_sync_queue` (triggers, same transaction). `platform-sync` sends
  the queue every minute (pg_cron + pg_net), organisations before their
  schools, with retries and backoff (1, 2, 4… minutes, at most an hour).
- **Decisions** arrive at `platform-decisions`, signed (HMAC-SHA256,
  `PLATFORM_WEBHOOK_SECRET`, ±5 minutes). They are applied through
  `organizations.status`, the same column Schools' own console sets and
  every check reads. The organisation's schools see "Figbloom" and the
  reason in their audit log; who decided is kept in an event only Figbloom
  staff can read.
- **Safety net:** Schools' own `organizations.status` stays the enforcement,
  and nothing calls the platform on a request. Every hour `platform-sync`
  asks the platform about the organisations most likely to have missed a
  decision, and fixes any difference (logged).

**Secrets** (`supabase secrets set …`; never committed):

| Secret | What |
|---|---|
| `PLATFORM_CLIENT_ID`, `PLATFORM_CLIENT_SECRET` | the `schools-service-<env>` client (`SchoolsServiceClientId` output; its secret from Cognito) |
| `PLATFORM_TOKEN_URL` | the platform's `TokenEndpoint` output (`…/oauth2/token`) |
| `PLATFORM_API_URL` | the platform's `PlatformApiUrl` output |
| `PLATFORM_WEBHOOK_SECRET` | the 64 characters in `figbloom/platform/webhook/schools` (platform Secrets Manager) |
| `PLATFORM_SYNC_KEY` | the key that calls `platform-sync` (pg_cron and staff): at least 32 characters, e.g. `openssl rand -hex 32`. The same value goes in the Vault secret `platform_service_key` below |
| `PLATFORM_WEBHOOK_URL` (optional) | where the platform should send decisions, if not `<SUPABASE_URL>/functions/v1/platform-decisions` (a self-hosted stack whose `SUPABASE_URL` is internal) |

And two **Vault** secrets, for pg_cron to call `platform-sync` (SQL editor, as postgres):

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'platform_functions_url');
select vault.create_secret('<the PLATFORM_SYNC_KEY value>', 'platform_service_key');
-- already created with the service-role key? replace it:
-- select vault.update_secret((select id from vault.secrets where name = 'platform_service_key'), '<the PLATFORM_SYNC_KEY value>');
```

`platform-sync` accepts `PLATFORM_SYNC_KEY` in an `x-platform-sync-key`
header (preferred, and what pg_cron sends) or as `Authorization: Bearer`. It
also accepts a key the runtime injected (`SUPABASE_SERVICE_ROLE_KEY`, or an
`sb_secret_…` key from `SUPABASE_SECRET_KEYS`). Don't rely on the dashboard's
legacy `service_role` key: on Supabase Cloud the injected
`SUPABASE_SERVICE_ROLE_KEY` turned out not to be that value, and it got 401.
A refusal is logged in the function's logs with what was sent (its kind and
length) and what is configured, never a key.

**Deploy, in this order** (`$KEY` is the `PLATFORM_SYNC_KEY` value, `$F` is `https://<ref>.supabase.co/functions/v1`):

1. Migrations: `supabase db push` (`20261104900000_platform_registration`,
   `20261104910000_organization_suspension_reaches_schools`,
   `20261104920000_every_school_has_an_organization`, `20261104930000_platform_sync_key`).
2. Functions: `supabase functions deploy platform-sync --no-verify-jwt` and
   `supabase functions deploy platform-decisions --no-verify-jwt`; the secrets
   (including `supabase secrets set PLATFORM_SYNC_KEY=<value>`) and the Vault
   secrets above, with the same value in `platform_service_key`.
3. Register the webhook:
   `curl -X POST "$F/platform-sync" -H "x-platform-sync-key: $KEY" -d '{"action":"register_webhook"}'`
4. Dry-run the backfill and read what it would do: every organisation with
   the status it will copy, and every school (the migration has already given
   each lone school its own organisation, so none is left to create):
   `curl -X POST "$F/platform-sync" -H "x-platform-sync-key: $KEY" -d '{"action":"backfill"}'`
5. Run it: `… -d '{"action":"backfill","dry_run":false}'`. It registers
   every organisation with today's status (`backfill: true`), then every school. Running it again only
   re-sends names; a status Figbloom staff have decided on the platform is
   kept.
6. Switch on (below).

**`PLATFORM_DECISIONS_ENABLED`** is a row in `platform_settings`, off by
default; until then nothing changes for anyone. While it is off, decisions
are verified and acknowledged but not applied (Schools' own staff console
still decides), and the reconcile doesn't run. Turn it on once the
backfill has run:

```sql
update platform_settings set value = 'true', updated_at = now() where key = 'PLATFORM_DECISIONS_ENABLED';
```

From then on organisation status comes only from the platform: the database
refuses any other change, Schools' staff console shows the status (and
"decided on the Figbloom platform") instead of an Approve button, a new
organisation takes the platform's decision when it is registered (pending,
or active with the platform's auto-approve), and the hourly reconcile runs.
Turning it off again hands organisation status back to Schools' console.
Checks: `supabase/rls-checks/platform_registration.sql` and `supabase/rls-checks/organization_suspension.sql`.

## Figbloom HR: staff events (Schools + HR phase 1)

Once Figbloom staff switch HR & Payroll on for a school (the console, on the platform), HR keeps a draft employee
for each of the school's staff, and an exit completed in HR archives the Schools account
(SCHOOLS_HR_PHASE1_CONTRACT.md, section 3; `20261105600000_platform_staff_events`).

- **Staff events** go through the same outbox. Triggers on `profiles` queue a `staff` row for teachers, drivers,
  other staff and school admins: `schools.staff.created` (hired, or restored), `.updated` (name, phone, title, role,
  or a real email; a synthetic login address `…@login.<slug>.figbloom.internal` is sent as `email: null`) and
  `.left` (archived, removed, or no longer a staff role; with `left_on`). `platform-sync` sends them as
  `POST /events` after the organisations and schools, `tenant_local_id` the school's id, with the same retries.
- **Two gates on sending.** `PLATFORM_STAFF_EVENTS_ENABLED` (`platform_settings`, off by default): while it is off
  nothing is queued at all, so no personal data piles up, and `staff_backfill` for real is refused (409
  `staff_events_disabled`; the dry run still lists). And only schools the platform knows: a school whose registration
  has been delivered (`platform_links`, kind `tenant`); otherwise nothing is queued and the backfill answers 409
  `school_not_linked`. If the platform still answers 404 for a staff event, the row ends as `skipped_unlinked` (done,
  not retried) and `platform-sync` logs it.
- **Archiving staff** (`archive_staff()` / `restore_staff()`, like learners): the account is kept, its login banned
  and its sessions ended; restoring lifts the ban.
- **`hr.employee.left`** arrives at `platform-events`, signed like decisions (`PLATFORM_WEBHOOK_SECRET`). The person
  must belong to the school the event names. It archives them (not sent back to HR as `.left`); each delivery once.
  **`PLATFORM_EVENTS_ENABLED`** (`platform_settings`, off): until it is on, events are verified, recorded in
  `platform_event_deliveries`, logged and acknowledged, not applied.

**Deploy**, on the database and the functions host of the environment:

1. Apply the migration `20261105600000_platform_staff_events`.
2. Deploy the `platform-sync` and `platform-events` functions (`platform-events` is public: JWT verification off,
   like `platform-decisions`; its own check is the signature).
3. Function settings: set `PLATFORM_EVENTS_URL` to `<public functions URL>/platform-events`. `PLATFORM_WEBHOOK_SECRET`
   (the platform's `figbloom/platform/webhook/schools` value) and the existing `PLATFORM_*` client settings are reused.
4. Register the event webhook: call `platform-sync` (with `PLATFORM_SYNC_KEY` in `x-platform-sync-key`) with
   `{"action":"register_event_webhook"}`.
5. Switch sending on, only on a database whose platform should receive its staff:

   ```sql
   update platform_settings set value = 'true', updated_at = now() where key = 'PLATFORM_STAFF_EVENTS_ENABLED';
   ```

6. After HR is switched on for a school: `{"action":"staff_backfill","school_id":"<tenants.id>"}` lists its staff;
   with `"dry_run":false` it queues `schools.staff.created` for each, and the next minute's sync sends them.
7. Switch receiving on (`hr.employee.left` archives accounts):

   ```sql
   update platform_settings set value = 'true', updated_at = now() where key = 'PLATFORM_EVENTS_ENABLED';
   ```

Turning either setting back to `'false'` stops it again (rows already queued are still sent).
Checks: `supabase/rls-checks/platform_staff_events.sql`.

## Figbloom HR: one-click sign-in ("HR & Payroll")

The web console's sidebar has **HR & Payroll**: one click opens Figbloom HR in a new tab, signed in
(SCHOOLS_HR_HANDOFF_CONTRACT.md, section 3; `20261105700000_platform_hr_handoff`, the `open-hr` function).

- **Who sees it:** the school's admin, an org admin acting for a school of their organisation, and a teacher or other
  staff member holding the **fees** area (the bursar). Not Figbloom staff. HR decides real access; Schools only hides
  the item from people who can't use it. The rule is the database's `hr_handoff_status(school)`, used by the sidebar and
  by `open-hr` alike; it refuses (42501) anyone else.
- **Whether HR is on for the school:** learned from the platform's answer to `POST /handoffs` itself (the platform
  doesn't relay `platform.module.enabled` to Schools, and its tenant lookup is console-only). `open-hr` records each
  answer in `platform_module_status`: the item shows while the answer is unknown or yes, hides for an hour after a 409
  (`target_not_enabled`, `target_not_linked`, `target_no_handoff_url`), then shows again and the next click asks
  again. A school the platform doesn't know yet (no `platform_links` row) never shows it.
- **The click** opens a blank tab at once (so no popup blocker), calls `open-hr`, which checks the rule again and asks
  the platform for a one-time link with the caller's id, name, role and real email (a synthetic login address is sent
  as `null`), and sends the tab there. A refusal closes the tab and says why.
- **Switch:** `PLATFORM_HANDOFF_ENABLED` (`platform_settings`, off by default): while off nobody sees the item and
  `open-hr` refuses.

**Deploy**, on the database and the functions host of the environment:

1. Apply the migration `20261105700000_platform_hr_handoff`.
2. Deploy the `open-hr` function (JWT verification on). It reuses the existing `PLATFORM_*` client settings.
3. Once HR has registered its handoff URL with the platform, switch it on:

   ```sql
   update platform_settings set value = 'true', updated_at = now() where key = 'PLATFORM_HANDOFF_ENABLED';
   ```

Checks: `supabase/rls-checks/platform_hr_handoff.sql`.

## Figbloom HR: "My HR" (Schools + HR phase 2, step 1, view only)

Teachers, other staff and the school's own admins see **My HR** in their console: their own payslips (each one laid
out from HR's figures, with Print / Save as PDF through the browser: HR has no server-side payslip PDF), leave balances
and applications with their approval steps, attendance (by month) and KPIs from Figbloom HR, read only
(SCHOOLS_HR_PHASE2_CONTRACT.md, section 3; `20261105710000_my_hr`, the `my-hr` function).

- **Where:** `teacher/my-hr`, `staff/my-hr`, and `admin/my-hr` (only for a `school_admin`, as staff; not for an org
  admin acting for the school). Drivers have no console yet; `my-hr` already accepts them for the teacher app later.
- **Who and when:** the database's `my_hr_status()` (about the signed-in person only, no arguments) is the rule for the
  sidebar and for `my-hr`: an active, non-archived staff profile (teacher, driver, staff, school admin) of a school that
  isn't suspended; `MY_HR_ENABLED` on; the school known to the platform (`platform_links`); and no
  `target_not_enabled` / `target_not_linked` answer from the platform about HR in the last hour (what `open-hr` records
  in `platform_module_status`; `target_no_handoff_url` doesn't hide My HR). Whether the person's own HR record is
  ready is HR's answer, shown on the page: "Your HR record isn't ready yet. Ask the school's HR administrator."
- **`my-hr`** takes `{route, payslip_id?, from?, to?}` and calls `HR_MY_HR_URL/<route>` with Schools' platform token and
  `x-figbloom-school` / `x-figbloom-person` set from the caller's own profile, never from the request. A payslip is
  `payslips/<id>` (every saved figure; HR's `payslips/<id>/pdf` answers 501 and is never called). HR's refusals become
  sentences (`not_linked` and `pending_hr`: not ready; 403 `school_not_linked` or 401: HR isn't connected to the
  school; 503 `my_hr_off`: HR's switch is off; 429: 120 calls per person per 10 minutes; 400: HR's own sentence;
  anything else: try again shortly).
- **Switch:** `MY_HR_ENABLED` (`platform_settings`, off by default): while off nobody sees the page and `my-hr` refuses.

**Deploy**, on the database and the functions host of the environment:

1. Apply the migration `20261105710000_my_hr`.
2. Set the function secret `HR_MY_HR_URL` (HR's `https://<hr host>/api/integrations/my-hr`). It reuses the existing
   `PLATFORM_*` client settings.
3. Deploy the `my-hr` function (JWT verification on).
4. Once HR's `/api/integrations/my-hr/*` is live (`MY_HR_API_ENABLED` on in HR) and the school's staff are linked, switch
   it on:

   ```sql
   update platform_settings set value = 'true', updated_at = now() where key = 'MY_HR_ENABLED';
   ```

Checks: `supabase/rls-checks/my_hr.sql`; `supabase/functions/my-hr/index.test.ts` (against a fake HR shaped like bloomHR's `my_hr_routes.js`).

## Figbloom HR: leave run by HR (Schools + HR phase 2, step 2a)

At a school whose leave is HR's, staff apply for leave in Schools but HR keeps it: HR's types, rules, balances,
documents and approval chain (SCHOOLS_HR_LEAVE_CONTRACT.md, section 3; `20261105800000_leave_via_hr`).

- **When:** `HR_LEAVE_ENABLED` (`platform_settings`, off; one switch for the database) **and** HR on for the school:
  known to the platform (`platform_links`) and the platform's latest answer about HR for it (`platform_module_status`,
  from `open-hr`) isn't a `target_not_enabled` / `target_not_linked` "no". Unlike My HR, a "no" doesn't wear off after
  an hour (which form a school uses mustn't flip). `hr_leave_access()` (the caller's own, no arguments) answers
  `{status, approver}`.
- **Leave page** (`teacher/leave`; `staff/leave`, new, shown only then): the form comes from HR (`my-hr` routes
  `leave_form`, `leave_applications`, `leave_apply` with a reason of 10+ characters and a document up to 3 MB sent as base64 (HR production sits behind Vercel's ~4.5 MB request limit), `leave_cancel`, shown only when HR says `cancellable`). The old
  Schools-only form is hidden there, and the database refuses a Schools-only request from an older app. Everywhere else
  the old form and the office's Leave requests page work exactly as before. The teacher phone app says to apply on the web.
- **Leave to approve** (`admin/leave-to-approve`): for the school's admins and staff holding the leave or fees area
  (head teacher, deputy, bursar); HR decides who actually has items (`approvals`, `approval_decide`, done in HR as that
  person's HR user). Someone HR can't match yet sees "Open HR & Payroll once to connect your HR account", with the
  HR & Payroll button when they have it.
- **HR's decision comes back** as `hr.leave.approved` / `hr.leave.cancelled` on `platform-events`:
  `platform_hr_leave_event()` writes the person's `leave_requests` row (`source = 'hr'`, `hr_application_id` unique per
  school) as approved, so cover planning (approved leave_requests), the affected lessons, the Needs-cover card and the
  usual "Your leave request was approved" notice work unchanged. A cancel cancels the row, removes the cover arranged
  for the days ahead (telling the substitute, as the office's change of cover does) and tells the person. Each delivery
  once; each application in order (older events and a cancel of dates the row no longer has are `stale`, so a date
  change works in either order). Overlap with other approved leave is refused (409, not recorded) for a person to sort
  out. Applied only while `PLATFORM_EVENTS_ENABLED` and `HR_LEAVE_ENABLED` are both on; before that, recorded only.
- **History export:** `platform-sync {"action":"leave_history_import","school_id":"..."}` lists (dry run, the default)
  the school's approved Schools leave not yet exported, for staff whose `schools.staff` event was delivered;
  the dry run also asks HR's own dry run (per-record `would_import`, `not_linked`, ...); `"dry_run":false` sends it to HR's `import/leave-history` (up to 5000 per call) and marks what HR answered `imported` or `already_imported` (`hr_exported_at`; `not_linked`, `skipped`, `invalid`, `refused` are listed, not marked), so it can be
  run again safely.

**Deploy:** apply `20261105800000_leave_via_hr`; deploy `my-hr`, `platform-events` and `platform-sync`
(`HR_MY_HR_URL` is already set for My HR; platform-sync now reads it too); check the platform subscribes Schools to
`hr.leave.approved` / `hr.leave.cancelled` (contract section 1); for each school moving to HR leave, run the history
export (dry run first); then switch it on:

```sql
update platform_settings set value = 'true', updated_at = now() where key = 'HR_LEAVE_ENABLED';
```

Checks: `supabase/rls-checks/leave_via_hr.sql`; `supabase/functions/my-hr/leave.test.ts`,
`supabase/functions/platform-events/leave.test.ts`, `supabase/functions/platform-sync/leave.test.ts`;
`apps/web/src/screens/leave/HrLeaveViews.test.ts`, `packages/shared/src/hrLeave.test.ts`.

## Rate limits on the public functions

`search-schools`, `resolve-login-id`, `request-password-reset` and
`signup-organization` answer anyone, so each limits calls per caller address
(`supabase/functions/_shared/rateLimit.ts`), plus an overall or per-school
limit no request can change. The address is read from **one** header, at a
fixed distance from its right-hand end, because everything else in these
headers is whatever the caller chose to send:

| Where it runs | `CLIENT_IP_HEADER` | `TRUSTED_PROXY_HOPS` | Why |
|---|---|---|---|
| Supabase Cloud (today) | `cf-connecting-ip` (default) | `1` (default) | Cloudflare sets CF-Connecting-IP itself. X-Forwarded-For keeps what the caller sent and appends. |
| Self-hosted on AWS (figbloom-platform: ALB, Envoy gateway, edge runtime) | `x-forwarded-for` | `2` | The ALB appends the caller, then Envoy (`use_remote_address: true`) appends the ALB: the caller is second from the right. |

Set them as edge function secrets/environment (`supabase secrets set
CLIENT_IP_HEADER=x-forwarded-for TRUSTED_PROXY_HOPS=2` on a stack that takes
secrets that way; on the self-hosted host, the functions container's
environment). **Never set more hops than there are proxies of ours that
append**: one too many reads an address the caller wrote. One too few only
makes everyone behind the load balancer share one allowance. A request with
no usable address shares one "unknown" allowance per function; it is never
let through unlimited.

## SEO for the marketing page

Only `/` (and `/privacy`, served from `public/privacy.html`, and `/delete-account.html`) is meant to be found on Google; everything else is
the signed-in app.

- **Metadata lives in `apps/web/index.html`** (title, description, canonical, Open
  Graph, Twitter, Organization/WebSite/SoftwareApplication JSON-LD) so crawlers and
  link-preview bots that don't run JS still see it. `RouteSeo` swaps in a title and
  `noindex` for app routes at runtime; `vercel.json` sends the same `X-Robots-Tag`.
- **The FAQ and its FAQPage markup share one list** in `landing/Faq.tsx`. Keep
  structured data true to what's on the page: no `offers`/`aggregateRating` until
  there is real pricing or review data.
- **The production origin is hard-coded** in `index.html`, `public/robots.txt` and
  `public/sitemap.xml`. If the domain changes, search for `schoolmanagement.figbloom.org`.
- **Adding an app route? Add a rewrite to `vercel.json`.** The SPA fallback only
  covers known prefixes, so unknown URLs get a real 404 (`public/404.html`) instead
  of the homepage shell. A new route without a rewrite will 404 in production.
- **Adding a public page?** Give it its own title, description and canonical, and add
  it to `public/sitemap.xml` (update `<lastmod>` when content changes).
- `/` boots from its own entry (`main.tsx`) without loading the app bundle; keep
  `landing/*` free of imports from the app (router, Supabase, `components/`).
- Use WebP for landing images and keep each well under ~150 KB.

## The decisions worth knowing before you change anything

**One accent per school, and nothing else.** A tenant's colour enters the system
as two CSS variables (`--accent`, `--accent-deep`) and touches the header band,
primary buttons and the active nav marker. Layout, type and spacing never vary
per tenant — support staff have to navigate 248 schools without relearning the
interface. Status colours are system-owned: red means the same thing everywhere.

**Attendance is the 60-second screen.** Everyone starts present; the teacher taps
only the exceptions. Rows are 56px, mark buttons are 44px, and submitting with no
network queues the register and says *saved*, not *retry*. Attendance taken at
08:00 in a dead spot must never be lost.

**One grading scale.** `packages/shared/src/grading.ts` is the only place a score
becomes a letter. The same mark must never render as two different grades.

**Money is cents, always.** `KES()` formats; nothing else does. No floats.

**Payment copy states whether money moved.** Every M-Pesa failure in
`PAYMENT_FAILURES` says plainly whether the account was debited — that is a
parent's actual fear, and a generic "payment failed" causes a phone call to the
bursar.

**Students see marks, not rank.** No class position anywhere in the student app.
Marks are shown against the class mean instead. If your schools require rank,
that is a deliberate change, not a missing feature.

**Parents pay in instalments.** Part payment is a normal state, not an error —
families pay as harvests and salaries come in.

## Accessibility floor

Visible focus rings everywhere (never remove the `:focus-visible` rule), 44px
minimum touch targets via the `.hit` utility, 13px minimum body text on console
and 14px in the parent app, and every form error written as a sentence rather
than "Invalid". The parent user base includes people who do not use apps daily.

## Next steps

1. Fill in Daraja credentials (including `DARAJA_CALLBACK_SECRET`) in `.env`
   and deploy the two edge functions — the parent app's M-Pesa prompt is still
   a client-side simulation, since there is no sandbox account wired up in
   local dev. Only `mpesa-stk-push` creates payments rows, and only
   `mpesa-callback` marks one `success`, after checking the callback's secret
   token and confirming the result with Daraja's STK query.
2. ~~Wire FCM for the parent and student apps~~ — done on Android (device
   tokens + `send-push` edge function, FIG-293). iOS push is still open,
   blocked on Apple Developer push credentials (FIG-154).
3. ~~Build out the remaining admin tabs (reports, classes detail)~~ — done;
   also built out teacher Classes and Messages (the latter reuses
   `announcements`, not a new table).
4. ~~Add a timetable/periods table~~ — done for web and mobile
   (`timetable_slots`, editable per class from admin Classes; teacher/
   student/parent web screens and the mobile student app all read the real
   thing). `DEMO_TIMETABLE` in `packages/shared/src/demo.ts` is seed-only
   now, used by `supabase/seed.ts` to populate `timetable_slots` for local
   dev/demo data.
5. The platform console's own SaaS metrics (MRR, incidents, subscriptions,
   invoices, system health) have no backing tables — they model Figbloom's
   internal ops, which this schema doesn't cover yet, and stay illustrative
   until that's built.
6. `e2e/flows.spec.ts` predates real auth and real (seeded, but no longer
   frozen-in-source) data — several tests `page.goto()` straight to a
   protected route and now hit the sign-in redirect, and a few assert exact
   figures that came from the old mock arrays. It needs a sign-in step per
   flow and assertions rebased on `supabase/seed.ts`'s actual numbers.
7. **Fleet tracking (buses) is phase 5 of 5, alerts just landed.** Schema,
   RLS, and admin CRUD for vehicles/routes/drivers are real
   (`apps/web/src/lib/fleet.ts`, `/s/:slug/admin/fleet`); a driver's phone
   reports GPS for real through a plain browser page (`/s/:slug/driver`,
   `driver` role) using `navigator.geolocation.watchPosition` — which only
   reports while that page is open and in the foreground; locking the phone
   stops it. The admin Fleet screen and the parent's `/s/:slug/parent/bus`
   screen both show a live map (`apps/web/src/components/VehicleMap.tsx`,
   real Google Maps via `@vis.gl/react-google-maps` — needs
   `VITE_GOOGLE_MAPS_API_KEY` in `.env`, or the map shows a "not configured"
   message instead of failing silently) that updates over Supabase Realtime,
   no refresh needed. Every incoming ping is also checked server-side, in a
   trigger on `vehicle_locations`
   (`supabase/migrations/20260903000007_fleet_alerts.sql`), for speeding
   (per-vehicle `speed_limit_kmh`, default 80) or straying more than 1.5km
   from every stop on its assigned route; either raises a row in
   `vehicle_alerts` that streams onto the admin Fleet screen live and can be
   acknowledged there. Not yet built: trip history/replay, and an offline
   ping queue for dead zones reusing the pattern `apps/web/src/lib/queue.ts`
   already built for attendance.
8. Document/photo uploads (Supabase Storage, `apps/web/src/lib/uploads.ts`)
   cover student/staff photos, student records, assignment hand-ins, fee
   payment proof and school crests — all real, RLS-scoped per tenant and
   role. Not yet built: a school-crest replace flow after onboarding (only
   the onboarding wizard itself uploads one today) and a bulk/CSV path for
   student records.
