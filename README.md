# Figbloom School Systems

Multi-tenant school management for Kenyan secondary schools. Five roles, one
codebase, one deployment.

## What is here

```
apps/web/          React + Vite + TS + Tailwind — desktop console for every role
                   (platform, school admin, teacher, parent, student)
apps/mobile/       React Native (Android + iOS) — the parent, student and driver
                   mobile apps. apps/web also keeps a phone-mockup preview of the
                   parent/student screens (ParentApp.tsx / StudentApp.tsx, wrapped
                   in <PhoneFrame>) for design reference — it isn't routed to; the
                   desktop screens are the real web app
apps/teacher-mobile/  React Native (Android only — iOS deferred, see its own
                   README) — the teacher app, a separate binary from apps/mobile
                   since a teacher's workflow doesn't fit that app's role union
packages/shared/   Domain logic used by all three apps: types, grading scale, fee
                   maths, attendance register, M-Pesa helpers, offline write queue
supabase/          Schema, row-level security, seed script, M-Pesa edge functions
e2e/               Playwright tests over the five critical flows
tests/integration/ Vitest tests against the local Supabase: sign-in per role, school isolation, who may record payments, billing
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
| `npm run test:unit` | Vitest on `packages/shared` (pure logic) | nothing |
| `npm run test:edge` | Deno tests for `supabase/functions` | Deno |
| `npm run test:integration` | Vitest in `tests/integration`: signs in as each of the seven roles above, then checks school isolation (rows, storage, edge functions), who may record a payment, and the fee billing run | the local stack, seeded with `db:fresh`; `edgeFunctionIsolation.test.ts` also needs the edge functions from `main` |
| `npm test` | Playwright over `e2e/flows.spec.ts`, desktop then phone, one worker | the local stack, seeded, and the edge functions running |

`test:integration` refuses to start unless the Supabase URL is `127.0.0.1` or `localhost`
(`tests/integration/support/localGuard.ts`), so it cannot be pointed at the demo or a production project by mistake.
Only the URL and the anon key from `.env` reach those tests, never the service-role key. A new role or login goes in
`TEST_ROLES` in `tests/integration/support/signInAs.ts`; the smoke test picks it up.

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

## SEO for the marketing page

Only `/` (and `/privacy.html`) is meant to be found on Google; everything else is
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
