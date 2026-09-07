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
packages/shared/   Domain logic used by both: types, grading scale, fee maths,
                   attendance register, M-Pesa helpers, offline write queue
supabase/          Schema, row-level security, seed script, M-Pesa edge functions
e2e/               Playwright tests over the five critical flows
```

## Running it

The web app talks to a real local Supabase — there is no mock-data mode anymore.

```bash
npm install
cp .env.example .env         # then fill in the values `supabase start` prints below
npx supabase start           # Postgres, Auth, Studio etc. in Docker — first run pulls images
npm run db:seed              # applies supabase/migrations (schema + RLS) via db reset, then seeds demo data
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

Development logins are listed on the sign-in screen — the password column
tells you what to type for each (a fixed password for staff, `OTP 000000` for
the seeded parent, a PIN for the seeded student).

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

1. Fill in Daraja credentials in `.env` and deploy the two edge functions — the
   parent app's M-Pesa prompt is still a client-side simulation, since there is
   no sandbox account wired up in local dev and a payment can only be marked
   `success` server-side, by the Safaricom callback (see `supabase/rls.sql`'s
   `payment_insert` policy).
2. Wire FCM for the parent and student apps.
3. ~~Build out the remaining admin tabs (reports, classes detail)~~ — done;
   also built out teacher Classes and Messages (the latter reuses
   `announcements`, not a new table).
4. ~~Add a timetable/periods table~~ — done for web (`timetable_slots`,
   editable per class from admin Classes; teacher/student/parent web screens
   read the real thing). `DEMO_TIMETABLE` in `packages/shared/src/demo.ts` is
   still what the Android app reads — that's tracked separately as part of
   replacing Android's hardcoded demo data with real Supabase queries.
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
