# Production readiness — to-do

From the full audit on 2026-10-21 (backend, web, both mobile apps, CI/ops).
Work top to bottom; tick an item in the same commit that fixes it.

## P0 — Security (nothing real goes live until these are done)

- [x] **Dev logins panel shown in production.** Gate the "Development logins" panel on the sign-in screen to dev builds only (`apps/web/src/screens/SignIn.tsx`).
- [x] **One shared password for every account.** Provisioning functions give every account `figbloom-dev`. Generate a random temporary password per account and force everyone (not just drivers) to choose their own at first sign-in, on web and both mobile apps (`supabase/functions/{invite-admin,invite-org-admin,provision-student,provision-guardian}`). `seed.ts` now uses a random password against remote projects, like `seed-cbe.ts`.
- [ ] **Production must be a fresh Supabase project, separate from the demo one.** Demo accounts keep `figbloom-dev` by design; no real school may be onboarded on the demo project. Deploy the four provisioning functions to production after the fix above.
- [ ] **Login-ID lookup leaks names.** `resolve-login-id` is public, unthrottled, and returns the full name for any sequential ID — stop returning the name, add rate limiting.
- [x] **M-Pesa callback can be forged.** Verify every callback against Daraja (STK Query) before marking success, never trust the posted `Amount`, add a secret callback path; stop clients inserting their own pending `payments` rows (`supabase/functions/mpesa-callback`, `payment_insert` policy). Set `DARAJA_CALLBACK_SECRET` on the project before deploying.
- [x] **Private documents readable by the whole school.** Scope `private-documents` storage reads and `student_documents_read` to staff + the student's own guardians/student.
- [x] **Student photos in a public, listable bucket.** Listing now needs someone from that school. Photos are still served by public URL to anyone who has the exact path (needs the student's UUID); moving them to signed URLs is a later step.
- [x] **Cross-school access via guardian links.** Triggers now refuse any row whose `student_id` (or guardian account, or invoice) belongs to another school, on every table that carries both, so the guardian read branches can only reach the guardian's own school.
- [x] **Higher-ed students can write their own grades.** Fix the `course_assessments` / `course_marks` / `course_grades` write policies (`… or tenant_id = my_tenant()`).
- [x] **Audit log is forgeable.** Anyone (even anon) can insert `audit_events`; restrict to service role.
- [ ] **Malware still in branch history.** Commit `ef569ed` on `origin/fleet-live-maps-and-portals` carries a payload (cleaned at the tip by `9ab54b4`). Delete or rewrite that branch; confirm the compromised machine was cleaned and its GitHub/npm/Supabase tokens rotated.
- [x] **`.gitignore` doesn't cover `.env.*`.** Add `.env.*` with `!.env.example`.

### P0 follow-ups (RLS should-fix)
- [ ] Targeted announcements readable school-wide (read policy ignores `audience`).
- [ ] Teachers can approve their own leave.
- [ ] Any teacher can edit any exam.
- [ ] Drivers can change their own vehicle's `speed_limit_kmh`.
- [ ] Suspended organizations keep full access.
- [ ] Teachers can overwrite/delete private documents and confirm payment proofs.
- [x] Admins can set `fee_invoices.paid_cents` directly with no audit trail. A trigger now refuses any change to paid_cents/status that isn't a recorded payment.
- [ ] Public endpoints (`signup-organization`, `resolve-login-id`, `search-schools`) have no rate limit/captcha; raw DB errors returned to clients.
- [ ] STK push: any guardian/staff can prompt any phone; throttle isn't atomic; pending payments never reconciled (a scheduled job could run the same Daraja STK query `mpesa-callback` now uses). Fixed: amounts must be whole shillings, CORS preflight, bad JSON → 400.

## P1 — Core flows that can't work end to end

- [x] **Fee invoices**: nothing but the seed creates `fee_invoices`. Build a per-term billing run from fee items. Admin Fees → "Bill learners" (re-runnable; only bills learners without an invoice).
- [x] **Record payments**: confirming a payment proof doesn't credit the invoice; no way to record cash/bank/cheque. `record_payment()` + admin Fees → "Record a payment" (cash, M-Pesa to the paybill, bank, cheque); confirming a proof records its payment.
- [ ] **Exams**: no screen creates `exams` (teachers are told to ask the admin, who has no screen).
- [ ] **Exam publishing**: `publishExam` publishes the whole exam school-wide, exposing other teachers' draft marks.
- [ ] **Assignments**: no web or mobile screen creates `assignments`.
- [ ] **Real M-Pesa**: replace the `setTimeout` simulation with `mpesa-stk-push` on web (parent + student Fees) and mobile (Pay). Needs Daraja credentials.
- [ ] **1000-row cap**: no query is paginated; reports, dashboards and people lists are silently truncated in large schools. Started: `fetchAllPages()` in shared; admin Fees and the billing run use it.
- [ ] **Attendance loss**: online submit shows success before the write finishes, and a failed write isn't queued.
- [ ] **Offline queue bugs**: flush loses items enqueued mid-flush; one bad item blocks the rest; not per-user; no flush on load.
- [ ] Deleting a learner hard-deletes and cascades to invoices, payments, marks — make it archive instead.

## P2 — Mobile store release

- [ ] `targetSdkVersion` 34 → 35+ (edge-to-edge, check 16 KB page size support).
- [ ] `versionCode 1` hard-coded in both apps — derive from CI.
- [ ] Driver GPS likely crashes: `react-native-geolocation-service` built against play-services-location 18 while maps pulls in 21. Set `playServicesLocationVersion` / replace the library; test on device.
- [ ] Drop `ACCESS_BACKGROUND_LOCATION` (foreground service is enough) or add the prominent disclosure + Play declaration.
- [ ] Teacher app: drop `READ_MEDIA_IMAGES`, use the system photo picker.
- [ ] Upgrade `@react-navigation/native-stack` 5.0.5 → ^7 and revisit the blanket Fabric keep rule.
- [x] Mobile typecheck fails inside `react-native-maps` 1.26.0's source. Fixed with a type shim (`apps/mobile/src/types/react-native-maps.d.ts`); delete it when the pin is lifted.
- [ ] CI doesn't write `MAPS_API_KEY`, so CI-built maps are blank.
- [ ] Offline launch lands on Sign-in (`auth.getUser()` needs network) — use the cached session.
- [ ] Driver: enforce `must_change_password`; restart tracking after process death; fix ping queue blocking after a trip ends.
- [ ] Sign-out should delete the device token, cached data and queue.
- [ ] Store collateral: real privacy-policy URL + contact email, Data safety form, teacher 512px icon, final feature graphics, student/driver screenshots.
- [ ] Account deletion request path (web URL at minimum).
- [ ] iOS: team, push entitlement, `GoogleService-Info.plist`, Firebase init, `PrivacyInfo.xcprivacy` data types.

## P3 — Ops

- [ ] CI on every PR: security grep from `.agents/SECURITY.md`, typecheck, lint, vitest, deno edge tests.
- [ ] Error reporting (web, both apps, edge functions). Done for one piece: `mpesa-callback` logs and answers 500 (so Safaricom retries) on DB or Daraja errors.
- [ ] Separate staging and production Supabase projects; scripted deploy of migrations + functions.
- [ ] Backups / point-in-time recovery, uptime check, runbook.
- [ ] Security headers (CSP, HSTS, frame/referrer) in `apps/web/vercel.json`.
- [ ] Release workflow: pin actions by SHA, add `permissions:`, run the security grep before the keystore is written.
- [ ] RLS tests for the tenant/role boundaries above. Started: `supabase/rls-checks/tenant_isolation.sql` (plain psql, rolled back); extend it and run it in CI.
- [ ] Delete stale `rls.sql` / `schema.sql` (they claim to be the source of truth but aren't).
- [ ] Retire `dev` and `dev-staging` branches.

## P4 — Missing features

- [ ] Report cards / result slips, printable fee statements and receipts.
- [ ] SMS (and email) notifications — several screens already promise SMS that never sends.
- [ ] Fees: arrears carry-forward, bursaries / waivers / discounts.
- [ ] Password reset for login-ID users (admin-initiated reset).
- [ ] Parents can reply in the inbox.
- [ ] Wire or remove buttons that only show a success toast (admin Dashboard "New announcement", People "Change class"/"Export", platform "Remind"/"Impersonate"/"Export").
- [ ] Remove hard-coded/illustrative content (TenantDetail charts, plan prices, `0722 118 004` phone default).
- [ ] Data protection: retention/purge for GPS history, data export, learner anonymisation.
- [ ] Exeats/leave-outs, discipline records, library, boarding, NEMIS.
- [ ] Update README "Next steps" (CSV import, crest replace, trip history, offline ping queue are now built).
