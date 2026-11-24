# Handover: put every web page on the new API

Written 2026-11-24 against `dev-joe` at `19c0852`. For the next engineer or AI model on this work.

## The goal

Every page of the web app (`apps/web`) must work on the **API build** (`VITE_BACKEND=api`, talking to `apps/api`), with
nothing on Supabase. Only then is the production site (`schoolmanagement.figbloom.org`, Vercel) switched to the API build.
**The owner's rule: no switch until every page is on the API.**

**Done for one page** means all of these:

- It opens from the API build's menu.
- Everything it shows comes from `apps/api`.
- Every control either works on the API or is hidden with a written reason ("not in the API yet: …").
- It has unit tests and a browser check against a real local API.
- It is described in its area's file in `docs/web-on-api/` (see `docs/WEB_ON_THE_NEW_API.md`).

**Done overall** means:

- All 97 menu pages below, plus the pages outside the menu (sign-in, sign-up, password reset, the org picker), are done.
- `apps/web` no longer needs `App.tsx`'s Supabase screens: either `ApiApp` covers everything, or the screens are moved over.

## Read these first (in this order)

1. `CLAUDE.md` and **`.agents/SECURITY.md`**. Run `sh scripts/security-scan.sh` before any build, lint or commit. This is mandatory: the repo was attacked through config files.
2. **`docs/WEB_ON_THE_NEW_API.md`** covers:
   - how the API build works;
   - what is already ported;
   - what is hidden and why;
   - where the code is;
   - how to run it locally;
   - API findings.

   **This TODO does not repeat it.**
3. `apps/api/README.md` and `apps/api/docs/API-CONVENTIONS.md`, `AUTHZ-CONVENTIONS.md`, `TENANT-ISOLATION.md`. Read these before you add or change any API endpoint.
4. `apps/api/openapi/openapi.yaml`: the contract, 254 paths. `packages/shared/src/api/schema.d.ts` is generated from it (`npm run api:types`), so a path not in the contract does not compile.
5. `infra/README.md`, only for context on production. **Deploying is not part of this work.**

## Where things stand

### On the API build today: 8 of 97 menu pages

- School admin (7): `admin` (overview), `admin/people`, `admin/fees` (office side), `admin/settings`, `admin/classes`, `admin/subjects`, `admin/announcements`. These are listed in `API_ADMIN_PAGES` in `apps/web/src/api/ApiConsole.tsx`.
- Teacher (1): `teacher/attendance`, plus the teacher home. These are in `API_TEACHER_PAGES`.
- Each of these is partial. The hidden controls and the reasons are in `docs/WEB_ON_THE_NEW_API.md`.
- Account pages in `apps/web/src/api/ApiApp.tsx`: `/signin` (email and password with two-step), `/accept-invite`.
- **PR #353** (open, not merged when this was written) adds `/forgot-password` and `/reset-password`, and Resend e-mail for invitations and resets.

### Shared data code

`packages/shared/src`:

- **14 modules have an API branch:** adminAnnouncements, adminFees, attendanceSession, earlySignOut, feeStructure, learnerBio, learners, materials, medical, peopleRoster, schoolSetup, session, studentHealth, teacherData.
- **56 are Supabase only.** The table below says which pages need which modules.

### The web layer

`apps/web` no longer calls `supabase()` directly; every call goes through `packages/shared`. ESLint enforces this. So the work is in shared modules, not screens, apart from hiding controls.

### Production

- The API is being deployed to AWS at `https://sms-api.figbloom.org`.
- The database exists. The API service waits on #353 and a redeploy.
- **Do not touch production.** Do not use it for testing, and do not run the demo seed (`scripts/api-seed`) against it: that seed has fixed passwords.

## Working rules (the owner's, from earlier sessions)

- **Work in a git worktree.** Use `C:\Users\Admin\Desktop\Projects\sms-wt\<name>` with a branch off `origin/dev-joe`. The main checkout stays on `dev-joe`.
- **One slice (one area) per PR into `dev-joe`.**
  - Merge method: squash.
  - **The owner merges. Never merge, approve or enable auto-merge yourself.** Pushing straight to `dev-joe` is blocked anyway.
  - Open the PR yourself after pushing.
- **Linear:** the owner updates it himself. Put paste-ready text in your final message.
  - **Leave the FIG id out of PR titles and commits for partial slices.** Linear auto-closes the issue on merge, and that has already happened by mistake.
  - Parent issue: FIG-1868. Web issues: W2 FIG-1891 through W5 FIG-1894. API asks: FIG-1869 to FIG-1883. The project is P-FIG-32.
- **The API may be changed** (`apps/api`). The "don't edit the API" rule ended on 2026-11-24. Follow its conventions:
  - Migrations are forward-only and numbered. Never edit an applied migration: their checksums are verified.
  - Every tenant table has RLS (forced) plus a `figbloom_app` policy.
  - Grants are minimal. See `docs/RUNTIME-DATABASE-SECURITY.md` and `test/grants.matrix.test.ts`.
  - Permissions come from `requirePermission`.
  - Update OpenAPI, then `npm run api:types`.
  - Add tests in `apps/api/test`.
  - Put API changes in their own PR, separate from web slices, and say clearly what changed and why.
- **Do not touch:**
  - the owner's dev server on `:5173`;
  - the `supabase_db_figbloom` database, as an API test target;
  - Ancel's `figbloom-operations` stack (`:8080`, `:5439`);
  - any AWS resource.
- **Plain, short wording** in UI text, docs and PRs, as the rest of the repo is written.

## How to port a page: the pattern, with examples to copy

The screens stay. What changes is the shared function under them.

1. **Find the screen and its data functions** in the table below. Then open the screen and list every `@figbloom/shared` function it calls, including from its local components.
2. **For each function, add an API branch.**
   - Put `if (onApi()) return <area>Api.fn(...)` at the top. `onApi()` is in `packages/shared/src/backend.ts`.
   - Write the API side in `packages/shared/src/api/<area>Api.ts` with `apiClient()`, which is typed by `schema.d.ts`.
   - **Keep the exported signature and the domain types** (`packages/shared/src/types.ts`), so the screen does not change.
   - Read lists with `listAllPages` (cursor paging, `limit=200`). Run bulk writes a few at a time with `settlePool` (`api/pool.ts`).
   - Examples:

     | File | PR |
     |---|---|
     | `setupApi.ts` | #334 |
     | `peopleApi.ts` | #337 |
     | `feesApi.ts` | the fees slice |
     | `announcementsApi.ts` | the announcements slice |
     | `attendanceApi.ts` | #348 |

3. **When the API has no endpoint for something:**
   - Add a flag in `packages/shared/src/capabilities.ts`, one flag per missing endpoint.
   - The shared function throws `NotOnApiError`.
   - The screen hides the control when the flag is off.
   - Record it in the "what the API cannot do yet" table in your area's file in `docs/web-on-api/`.
   - Or build the endpoint in `apps/api`, in a separate PR.
4. **Turn the page on.**
   - For admin and teacher pages, add `apps/web/src/api/pages/<area>.pages.tsx`, which exports `pages` (see `pages/types.ts` and any existing `*.pages.tsx`). Do not edit `ApiConsole.tsx`: `pages/index.ts` picks the file up and builds `API_ADMIN_PAGES`, `API_TEACHER_PAGES` and the routes.
   - The other roles (parent, student, staff, driver, org, platform) have **no shell on the API build yet**. Add one to `ApiApp.tsx`, modelled on `ApiConsole.tsx`.
   - Lazy-load the page as the existing ones are.
5. **Tests:**
   - Unit tests for every API function, using `packages/shared/src/testing/fakeApi.ts` (`createFakeApi`), as `announcementsApi.test.ts` does.
   - Then run the full `npx vitest run`.
   - Then `npm run typecheck`. It checks shared, web, web tests, **mobile** and mobile node tests. The phone compiles `packages/shared` with no DOM: never use a bare `window`, `document` or `crypto` in shared code.
   - Then `npx eslint .`.
   - Add an `e2e/api/<area>.spec.ts` for the CI job `browser-api`.
6. **Browser check against a real local API.** Use a throwaway API, seed it, run Vite on your own port, then script the checks (recipe below). Check both:
   - the new behaviour on the API build;
   - that the Supabase build still works, read-only, against the local demo.
7. **Docs and PR:**
   - Add `docs/web-on-api/<area>.md` (see the existing files): what works, what is hidden and why, and your API findings, numbered inside that file with the area as a prefix (`parent-1`, `parent-2`). Do not edit `docs/WEB_ON_THE_NEW_API.md` or another area's file: that is what made pull requests conflict.
   - The PR says what was verified and what was not.

## Local API and browser checks (recipes that worked)

### Throwaway API

Takes about 10 minutes.

1. Start Postgres:
   ```sh
   docker run -d --name <x> -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=figbloom_api -p 127.0.0.1:59823:5432 postgres:16
   ```
2. Build: `npm run build --workspace @figbloom/api`.
3. With `MIGRATION_DATABASE_URL` set:
   - `node apps/api/dist/db/migrate.js`
   - `ALTER ROLE figbloom_app LOGIN PASSWORD '…'`
   - `node apps/api/scripts/session-hmac.mjs provision --key-id x --generate-to <file>`
   - `BOOTSTRAP_ADMIN_EMAIL=… FIGBLOOM_BOOTSTRAP_CONFIRM=yes node apps/api/scripts/bootstrap-admin.mjs`, then `POST /v1/auth/password-reset/complete`
4. Start `node apps/api/dist/index.js` with these settings:
   - `APP_ENV=local`
   - `API_PORT=4199`
   - `CORS_ALLOWED_ORIGINS=http://localhost:5199`
   - `SESSION_MINT_HMAC_KEY` set to the generated key
5. Remove the container when done.

### Seeding

- `scripts/api-seed/seed.ts` (`npm run api:seed`) builds the "Alliance" demo school over HTTP. It is local only.
- For a page's own data, write a small seed script over HTTP, as earlier slices did.
- `scripts/supabase-to-api/` (extract and load) can copy the local Supabase demo into a throwaway API.

### Web

- Run `VITE_BACKEND=api VITE_API_URL=http://127.0.0.1:4199 npm run dev --workspace @figbloom/web -- --port 5199 --strictPort`.
- Drive it with Playwright using `channel: "msedge"`. This machine lacks the bundled Chromium.

### API test suite

`npm run test --workspace @figbloom/api` needs a designated disposable database. See `apps/api/docs/TEST-DATABASE-SAFETY.md`. It takes about 21 minutes for 143 files.

### Traps already hit

- **Two-step codes:**
  - A TOTP code works once per 30 s window. Wait for the next window before a second sign-in.
  - Every code attempt, right or wrong, spends one of the account's 5 attempts (one comes back a minute). A run that signs in as the same admin many times (the `browser-api` job does) can run out and get 429 "Too many attempts".
  - On a local or CI API, raise it with `MFA_ATTEMPT_RATE_CAPACITY` and `MFA_ATTEMPT_RATE_REFILL`. Staging and production refuse a value looser than the default.
  - A fresh database needs `session-hmac.mjs provision` again, or sign-in answers 401 "Unable to create session".
- **Worktree resolution:**
  - In a worktree, `@figbloom/shared` resolves to the **main checkout** through the `node_modules` junction, for both tsc and vitest.
  - Use a temporary `tsconfig.wt.json` with **absolute** `paths` to the worktree's `packages/shared/src/index.ts`.
  - Use a scratch vitest config as a plain object with an alias.
  - Make the `node_modules` link a PowerShell junction. Git Bash `ln -s` copies instead.
  - Delete the temporary configs before committing.
- **Port 5173:**
  - Something else may already listen on `:5173`, and Playwright's `reuseExistingServer` will silently test old code.
  - Always use your own `--strictPort` port.
- **Playwright selectors:**
  - Scope clicks to `main`: toasts hold clickable text.
  - Wait for a toast that appeared *after* the action.
- **Stale e2e specs:** `e2e/reports.spec.ts` is stale and its `afterAll` deletes platform data. Do not run it against data you care about. CI runs only `e2e/flows.spec.ts`.
- **API behaviour:**
  - The API cuts requests at 30 s and bodies at 64 KiB.
  - CORS takes exact origins only.
  - Any holder of the Fees area must use two-step.
  - `X-Tenant-Id` picks the school on each call.

## The TODO, page by page

### Key

| Column | Meaning |
|---|---|
| Ready | The API has the endpoints; port the shared module. |
| Partial | Some of it can be ported; the rest is hidden behind a capability, or needs an API change. |
| Blocked | Needs API work first (the issue is named). Build it, or leave the page hidden. |

"Data modules" are the `packages/shared/src` modules the screen uses that touch the database:

- `[sb]` means Supabase only.
- `[both]` means it already has an API branch for some of its functions.

`platform` and `parentData` appear on many pages because they also export general helpers. Check what is really called before porting them.

### Recommended order

Each step builds on the last.

1. **The rest of school admin and teacher work.** This is the daily school use (W2 to W4).
2. **Staff and driver.**
3. **The org and platform consoles.**
4. **Parent and student**, which are blocked on family reads.
5. **Cross-cutting work** throughout, as each area needs it: files, polling, the offline queue, CSP.

### School admin (28 menu pages, 7 done)

| Page | Screen | Data modules to port | API to use | Status |
|---|---|---|---|---|
| `admin` | inline `AdminHome` → overview | adminOverview | `/reports/overview` | **Done** (ApiOverview) |
| `admin/people` | admin/People.tsx | (see doc) | learners, guardians, staff, imports | **Done**, partial |
| `admin/fees` | admin/Fees.tsx | adminFees, feeStructure; paymentProofs[sb] | `/finance/*` | **Done**, office side. Payment-proof files need storage |
| `admin/settings` | admin/TermSetup.tsx | schoolSetup | years, terms, school-profile | **Done**, partial |
| `admin/classes` | admin/Classes.tsx | schoolSetup; timetable[sb] | classes, timetable-slots | **Done**, partial. No class edit or delete |
| `admin/subjects` | admin/Subjects.tsx | schoolSetup; curriculum[sb] | subjects, teaching-assignments | **Done**, partial. No subject edit |
| `admin/announcements` | admin/Announcements.tsx | adminAnnouncements, materials | `/communications/*` | **Done**, partial |
| `admin/reports` | admin/Reports.tsx | adminOverview[sb], performanceData[sb] | `/reports/overview`, `attendance-daily`, `finance-summary`, `academics-summary`, `export`; `/attendance-counted` | Ready |
| `admin/performance` | admin/Performance.tsx | performanceData[sb], teacherData | `/reports/academics-summary`, `/assessments/{id}/marks` | Ready |
| `admin/exams` | admin/Exams.tsx | exams[sb], teacherData | `/assessments` (publish, close, marks), `/grading-schemes`, `/cbe-assessments` | Ready. Use the API's `max_score`, not the fixed 100 in `exams.ts` |
| `admin/report-cards` | admin/ReportCards.tsx | reportCards[sb], competencies[sb]; signatures[sb], ai[sb] | `/report-cards` (+export), `/competency-ratings`, `/rubric-configs` | Partial. Signatures blocked (C12, FIG-1880); AI helper → `/ai/query` |
| `admin/papers` | teacher/ExamPapers.tsx | examPapers[sb], examExtensions[sb], homework[sb], files[sb] | `/online-exam-papers`, `/online-exam-attempts/{id}/submit` | Partial. Files need storage (A5, FIG-1873) |
| `admin/materials` | teacher/LearningMaterials.tsx | materials, onlineClasses[sb], files[sb] | `/learning-materials`, `/live-classes/token` | Partial. Files need storage; materials can't carry a file (B11) |
| `admin/courses` | admin/Courses.tsx | courses[sb], adminAreas[sb], timetable[sb] | `/he-courses`, `/he-sections`, `/he-enrolments` | Ready |
| `admin/leave` | admin/Leave.tsx | leave[sb] | `/leave-requests` (review, cancel) | Ready. Check whose leave the screen shows |
| `admin/leave-to-approve` | leave/LeaveToApprove.tsx | hrLeave[sb], myHr[sb], hrHandoff[sb], edge[sb] | `/leave-requests/{id}/review` | Partial. The HR (bloomHR) handoff is blocked (C13) |
| `admin/inventory` | admin/Inventory.tsx | inventory[sb], feeCharges[sb] | `/inventory/items`, `/inventory/issues`; charges under `/finance` | Ready |
| `admin/chats` | admin/Chats.tsx | chat[sb], calls[sb] | `/chat/conversations` (messages, read) | Partial. No realtime: poll (B7 `since` cursors, FIG-1875). Voice calls blocked (C13) |
| `admin/account` | admin/Account.tsx | profile[sb] | `/v1/auth/me`, `/v1/auth/password/change`, `/v1/me/notification-preferences`, MFA endpoints | Ready |
| `admin/my-hr` | myhr/MyHr.tsx | myHr[sb], edge[sb] | none | Blocked (HR, C13) |
| `admin/activities` | admin/Activities.tsx | activities[sb] | `/activities` (+patrons, members) | Ready. Edit and remove a member are missing (B11) |
| `admin/visitors` | admin/Visitors.tsx | visitors[sb] | `/gate-visits` (+advance) | Ready. Poll for updates |
| `admin/medical` | admin/Medical.tsx | medical, studentHealth (both partly ported) | `/health/*` (sick bay, medical settings, medication) | Nearly ready: finish, then enable |
| `admin/access` | admin/AccessRoles.tsx | adminAreas[sb] | `/v1/rbac/permissions`, `PUT /v1/rbac/staff-areas`, `/v1/rbac/guardian-access`, `/v1/rbac/org-delegations` | Ready |
| `admin/audit` | admin/AuditLog.tsx | audit[sb] | none (no read endpoint) | Blocked (C12, FIG-1880) |
| `admin/fleet` | inline `DeliveryModeGate` | fleet[sb], routePlanning[sb], routeTrace[sb] | `/vehicles`, `/transport-routes`, `/trips` (events, location), `/learner-transport` | Partial. Poll positions (B7); vehicle and route edits are missing (B11) |
| `admin/assistant`, `admin/study-helper`, `admin/bloom` | admin/Assistant.tsx, admin/StudyHelper.tsx, bloom/BloomChat.tsx | guide[sb], aiHelper[sb], ai[sb], aiChat[sb], edge[sb] | `/ai/query`, `/ai/status` (contract `bloom-school/1`, chat only, 4,000-character prompts) | Partial. Lesson plans and paper import are not in the contract (C13) |

### Teacher (21 menu pages, 1 done)

| Page | Screen | Data modules to port | API to use | Status |
|---|---|---|---|---|
| `teacher/attendance` | teacher/Attendance.tsx | attendanceSession, earlySignOut, teacherData, medical, studentHealth | attendance registers, coverage, settings | **Done** |
| `teacher/gradebook` | inline `GradebookRouter` | exams[sb], teacherData | `/assessments/{id}/marks`, `/cbe-assessments`, `/competency-ratings`, `/he-enrolments/{id}/grade` | Ready. Bulk marks write is missing (A4): send a few at a time |
| `teacher/timetable` | teacher/Timetable.tsx | timetable[sb], coverage[sb], calls[sb] | `/timetable-slots`, `/timetable-publications`, `/attendance-coverage` | Ready. Slots can't be edited |
| `teacher/classes` | teacher/Classes.tsx | teacherData | `/classes`, `/class-memberships`, `/teaching-assignments` | Ready |
| `teacher/sections` | teacher/MySections.tsx | courses[sb] | `/he-sections`, `/he-enrolments` | Ready |
| `teacher/messages` | teacher/Messages.tsx | adminAnnouncements, materials, signatures[sb], ai[sb] | `/communications/*` | Mostly ready (same gaps as announcements) |
| `teacher/notices` | teacher/Notices.tsx | materials, parentData[sb] | `/communications/announcements/inbox`, `/notifications` | Ready |
| `teacher/homework` | teacher/Homework.tsx | homework[sb], files[sb], ai[sb] | `/homework-items` | Partial. Files need storage |
| `teacher/exams` | teacher/ExamPapers.tsx | as `admin/papers` | as `admin/papers` | Partial |
| `teacher/materials` | teacher/LearningMaterials.tsx | as `admin/materials` | as `admin/materials` | Partial |
| `teacher/report-cards`, `teacher/performance` | admin/ReportCards.tsx, admin/Performance.tsx | same screens as admin | same as admin | Port once for both roles |
| `teacher/leave` | teacher/Leave.tsx | leave[sb], hrLeave[sb], myHr[sb] | `/leave-requests` | Partial. The HR parts are blocked (C13) |
| `teacher/loans`, `teacher/my-hr` | staff/Loans.tsx, myhr/MyHr.tsx | myHr[sb], edge[sb] | none | Blocked (HR, C13) |
| `teacher/items` | teacher/Items.tsx | inventory[sb] | `/inventory/issues` | Ready |
| `teacher/buses` | inline `DeliveryModeGate` | fleet[sb] | `/trips`, `/me/transport` | Partial. Poll (B7) |
| `teacher/chats` | chat/MyChats.tsx | chat[sb] | `/chat/*` | Partial. Poll (B7) |
| `teacher/account` | teacher/Account.tsx | profile[sb], calls[sb] | as `admin/account` | Ready (calls blocked) |
| `teacher/activities` | admin/Activities.tsx | activities[sb] | `/activities` | Ready |
| `teacher/visitors` | teacher/Visitors.tsx | visitors[sb] | `/gate-visits` | Ready |
| `teacher/bloom` | bloom/BloomChat.tsx | ai[sb], aiChat[sb] | `/ai/*` | Partial |

### Staff (8) and driver (1)

There is no shell on the API build yet: add one to `ApiApp.tsx` (step 4).

| Page | Screen | Data modules | API | Status |
|---|---|---|---|---|
| `staff`, `staff/visitors`, `staff/notices`, `staff/account` | staff/Staff.tsx | otherStaff[sb], visitors[sb], profile[sb], teacherData | `/staff`, `/gate-visits`, `/communications/announcements/inbox`, `/v1/auth/me` | Ready |
| `staff/chats`, `staff/items` | chat/MyChats.tsx, teacher/Items.tsx | chat[sb], inventory[sb] | `/chat/*`, `/inventory/issues` | Ready, chat polls |
| `staff/leave` | inline `StaffLeave` | leave[sb] | `/leave-requests` | Ready, HR parts blocked |
| `staff/loans`, `staff/my-hr` | staff/Loans.tsx, myhr/MyHr.tsx | myHr[sb] | none | Blocked (C13) |
| `driver`, `driver/profile` | driver/Trip.tsx, driver/Profile.tsx | fleet[sb], queueSend[sb], files[sb], profile[sb] | `/driver/assignments`, `/driver/trips`, `/trips/{id}/driver-location`, `/trips/{id}/events`, `/trips/{id}/complete` | Partial. The offline queue must send idempotency keys (see below). The phone session length (B10) matters more on the phone |

### Parent (13) and student (12): blocked on family reads

**A1, FIG-1869.**

- On the API, the `parent` and `student` roles can read only:
  - their identity, session, school and permissions;
  - transport family-reads;
  - medication consent.
- `assertMayPayFor` always answers 403, so parents cannot pay.

Each page below needs family-scoped reads first. Those are either `/me/children/{learnerId}/…` endpoints, or guardian-link checks on the existing lists:

- attendance, marks and results, report cards (+export);
- homework, materials, timetable;
- invoices and payments (M-Pesa or PayHero needs the payer link);
- notices and inbox, chat;
- activities, items, health, bus.

Endpoints that already exist for families:

- `/v1/me/guardian-links`
- `/me/transport` (+notifications)
- `/v1/guardian-invitations/preview` and `/accept`
- `/notifications`
- `/v1/me/notification-preferences`
- `/v1/me/device-tokens`

| Pages | Screens | Data modules |
|---|---|---|
| `parent`, `parent/fees`, `parent/results`, `parent/homework`, `parent/materials`, `parent/bus`, `parent/inbox`, `parent/chats`, `parent/items`, `parent/settings`, `parent/activities`, `parent/health`, `parent/study-helper` | `screens/parent/*`, chat/MyChats.tsx | parentData[sb], examResults[sb], cbeData[sb], reportCards[sb], homework[sb], mpesaPay[sb], paymentProofs[sb], signatures[sb], routePlanning[sb], calls[sb], aiHelper[sb] |
| `student`, `student/timetable`, `student/work`, `student/materials`, `student/exams`, `student/results`, `student/study-helper`, `student/fees`, `student/chats`, `student/notices`, `student/activities`, `student/items` | `screens/student/*` | studentData[sb], courseGrades[sb], examPapers[sb], examExtensions[sb], timetable[sb], mpesaPay[sb] |

Also needed:

- **Student accounts.** Learners have no sign-in on the API (A4).
- **Guardian invitations.** The API has them; the People page does not offer them yet.

### Org admin (4) and platform admin (10)

On the API build today, both are told "not on the new system yet" and signed out.

| Pages | Screens | API today | Status |
|---|---|---|---|
| `org/dashboard`, `org/schools`, `org/schools/:id`, `org/admins`, `org/audit` | `screens/org/*` (organizations[sb], passwordReset[sb]) | `/v1/org/schools`, `/v1/rbac/org-delegations` | Partial. Org-admin management and the audit read are missing (C12) |
| `platform/tenants` | platform/Tenants.tsx | `POST /v1/platform/schools` (create only) | Partial. List and suspend are missing (C14) |
| `platform/organizations`, `usage`, `incidents`, `subscriptions`, `invoices`, `impersonation`, `audit` | platform/pages.tsx, Organizations.tsx | `/v1/platform/ops/status`, `/v1/platform/finance/unmatched-callbacks` | Mostly blocked (C14) |
| `platform/curriculum` | platform/Curriculum.tsx (curriculum[sb]) | `/academics/cbe/curriculum-catalogue/*` (import batches, entry review) | Partial. The D-5 verifier is undecided |
| `platform/health` | platform/pages.tsx | `/v1/platform/ops/status` | Ready |

### Pages outside the menu

| Page | Status |
|---|---|
| `/signin` | Done (email). Sign-in by school ID is blocked: there is no public school search or login-ID lookup (A3, FIG-1872) |
| `/accept-invite` | Done |
| `/forgot-password`, `/reset-password` | In PR #353 |
| `/signup` | Blocked. There is no self-service sign-up on the API (C15) |
| `/org-picker` | Port with the org console |
| `/` (landing) | Static, nothing to port |

### Cross-cutting work

Do each item when the first page needs it.

- **Files (storage).**
  - The API has presigned uploads: `/storage/objects` → PUT → `/storage/objects/{id}/complete`, plus `download-url`.
  - Write the API branch of `files.ts`. Records store object IDs, not bucket paths.
  - S3 is not configured anywhere yet, and the storage owner types cover only a few uses (A5, FIG-1873).
  - Payment proofs, homework, materials, exam files, avatars and logos all wait on this.
- **Polling instead of realtime.**
  - The API has no realtime. Add `packages/shared/src/api/poll.ts` with the same signature as the `subscribe*` helpers in `fleet.ts`, `chat.ts`, `calls.ts`, `parentData.ts` and `visitors.ts`.
  - Intervals: about 10 s for buses, 4 to 5 s for an open chat, 20 to 60 s for lists.
  - Pause when the tab is hidden and after 10 minutes without input, so polling does not keep the idle timer alive forever.
  - `since` cursors would make this cheaper (B7, FIG-1875).
- **Offline queue** (`queueSend.ts`): on the API, each queued write becomes `{op, params, body, idempotencyKey}`, so a retry never doubles attendance, pings or payments. Ask which POSTs honour `Idempotency-Key` (FIG-1872).
- **Content-Security-Policy:** `connect-src` must list the API origin and, once storage is used, S3's (`apps/web/vercel.json`).
- **E2E on the API build.** The CI job `browser-api` already exists in `.github/workflows/ci.yml`. It runs Postgres, migrate, the API, the seed, then Vite with `VITE_BACKEND=api`, and today has one spec, `e2e/api/signin-and-console.spec.ts`. Add a spec under `e2e/api/` for each ported area. The ESLint ban on `supabase()` in `apps/web` is already in `eslint.config.js`.

## Not part of this work, but needed before the switch

- **API deployment.** It is in progress; see `infra/README.md`.
- **Copying the real schools' data** from Supabase: `scripts/supabase-to-api/`.
  - Passwords cannot move, so everyone gets an invite.
  - Learners with no gender recorded are blocked until the school supplies one.
  - Finance history and marks are not handled yet.
- **The phone app:** all of it, `apps/mobile`, has the same work to do.
- **The switch itself:** the Vercel production build gets `VITE_BACKEND=api` and `VITE_API_URL=https://sms-api.figbloom.org`. Then the API's `ACCOUNT_LINK_BASE_URL` links (accept-invite, reset-password) start to work.

## What to put in your final message for each slice

- The PR link.
- What was verified: tests with counts, typecheck, lint, browser checks with counts, and which builds.
- What was **not** verified.
- What is hidden on the API build and why.
- API findings.
- Paste-ready Linear text for the owner.
