# Admin home (`AdminDashboard` and `AreasHome`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin` (`AdminDashboard` for full admins, `AreasHome` for area holders). Capability flags: `dashboardCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/adminOverviewApi.ts`.

## What works

- **Full admin (`AdminDashboard`):**
  - Term eyebrow, morning greeting, attendance submission summary, and **Needs you** cards (classes without today's attendance, outstanding term fee balances).
  - Stat cards: **Attendance today** (morning + afternoon counts when afternoon registers are enabled, in the school's percentage mode), **Fees collected** (percentage, paid and billed in minor units), **Learners** (total active learners and class count), **Teaching & admin staff** (`school_admin` and `teacher` classifications).
  - **Attendance by class** for today: submitted marks breakdown (`late` / `absent`), fraction button opening the **AttendanceDetail** modal (`who wasn't here`, morning + afternoon marks, early sign-outs with collector details, sign out early and void actions), and **Remind teacher** (creates and publishes an `in_app` user announcement to the class teacher's linked account).
  - **Fee collection · this term** progress bars (`Paid in full`, `Part paid`, `Nothing paid`).
  - **Early sign-outs** daily table, **Present in the morning, missing in the afternoon** report, and **Attendance settings** panel (`afternoon_enabled`, `percentage_mode`).
- **Area holders (`AreasHome`):**
  - Area cards with links filtered to the pages available on the API build (`API_ADMIN_PAGES`); areas whose pages are not on the API yet show `"Not on the new system yet."` instead of dead links.
  - **Early sign-outs**, **Latest registers** (`fetchRegisterDays` + `AttendanceDetail`), **PM missing report**, and **Attendance settings** for holders of the relevant areas.

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| **Waiting for your signature** (`PendingSignatures` on `AdminDashboard`) | Electronic document signatures wait on C12 (`FIG-1880`) |
| **Needs cover this week** (`CoverageCard` on `AdminDashboard`) | Per-period cover for approved leave has no API counterpart (`attendance-coverage` is by class and day; finding 44) |
| **Overdue medication** (`OverdueMedication` on `AreasHome` for `medical` area holders) | School-wide medication schedules and doses have no API endpoint (`medicalCapabilities().medicationRound`) |
| Unported area links on `AreasHome` cards | Filtered to `API_ADMIN_PAGES` until each remaining admin page is ported |

## How the model is mapped

- **Fee totals (`feeTotalsFromInvoices`):** `apps/api` has no `term_fee_totals` RPC, so `apiFetchOverviewBasics` reads non-voided live invoices for the current term (`GET /finance/invoices?termId=...`) and aggregates `billed`, `paid`, `invoices`, `nothing_paid`, `part_paid`, `full_paid`, and `owing` using the same bucket rules as Supabase.
- **Class teacher IDs:** A class carries `class_teacher_staff_id` (a staff directory record ID), whereas `AttendanceDetail` checks `classTeacherId === profile.id` (a user ID) and announcements target `{ kind: "user", user_id }`. `apiRemindClassTeacher` and `apiFetchClassAttendanceDetail` resolve the staff record to its `userId` and throw a clear message if the staff member has no sign-in account yet.
- **Latest register date (`apiFetchRegisterDays`):** `GET /attendance-registers` returns newest `taken_on` first, so `limit: 1` fetches the latest morning and afternoon dates; a failed afternoon read falls back to `null` so morning figures still show.
- **PM missing learners (`apiFetchPmMissingLearners`):** When `/learners` returns 403 (e.g. an attendance-only area holder), IDs are kept with `"Learner (restricted)"` instead of hiding the missing-PM alert.

## API findings (`dashboard-1`, `dashboard-2`)

- **dashboard-1:** `area.attendance` grants `resource.attendance.read`, `resource.attendance.write`, and `resource.early_sign_out.read`, but **not** `resource.academics.read` or `resource.learner.read`. A non-teacher holding only the Attendance area therefore gets 403 on `/classes`, `/class-memberships`, and `/learners` in `AreasHome` (seeing no classes in `LatestRegisters` and `"Learner (restricted)"` in `PmMissingReport`).
- **dashboard-2:** `area.visitors` grants `resource.visitor.read` and `resource.visitor.write`, but **not** `resource.early_sign_out.read`. A staff member or teacher holding only the Visitors area sees the `EarlySignOutList` card (`maySeeSignOutList`) but receives 403 from `GET /early-sign-outs`.
