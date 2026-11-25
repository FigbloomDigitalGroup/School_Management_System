# Student pages (student/*)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file. The API side is
`apps/api/docs/STUDENT-ACCOUNTS.md` (owner decisions of 25 November 2026, the endpoints, findings `student-1` to `student-14`).

A learner signs in with the login the school office made (`ST-0001` and a one-time password) and opens the **student console**: **Today**,
**Timetable**, **Work**, **Learning materials**, **Results**, **Sports & activities**, **Notices** and **My items** (and, in the second
part of this slice, **Fees**, **Exams & tests**, **Chats** and **Ask Bloom**). The pages are registered in
`apps/web/src/api/pages/student.pages.tsx`, under the `student` kind (`StudentPageDef` in `pages/types.ts`, `studentPageDefs` and
`API_STUDENT_PAGES` in `pages/index.ts`). The shell is the learner's own console, `ApiStudent.tsx` (it also holds Today), picked by role in
`ApiConsole.tsx`. The screens are the Supabase app's own (`screens/student/*`): the data behind them branches on `onApi()` in
`packages/shared`, and what the API cannot do is hidden by `studentCapabilities()`, as for the parent pages.

## Signing in

Sign-in on the API build has two ways in now, picked at the top of the form (the e-mail form is unchanged and is the one shown first):

- **School login ID:** the school's address (the `alliance` of `/s/alliance/...`; a pasted address of the school's pages or the school's UUID
  also work), the login ID and the password. The address is trimmed and lower-cased (the server refuses upper case with a 400) and turned
  into the school's UUID by `GET /v1/public/schools/{slug}` (PR #414, `apps/api/docs/PUBLIC-SCHOOL-LOOKUP.md`: unauthenticated, exact slug, no
  list and no search; `{ tenant_id, name }` for an active, trial or overdue school, one 404 for every other case, so the form says only "we could
  not find a school with that address"), then `POST /v1/auth/login/login-id` signs in. It is not only for learners: a parent, a teacher or a
  driver whose school gave them a login ID uses it the same way. A wrong ID, school or password gives one answer ("Check the school address, the
  login ID and the password.").
- **The lookup is rate limited** (about 5 at once, then 2 every 5 seconds per network address, 429 with `Retry-After`): the form says "Too many
  attempts. Try again in N seconds." The device **remembers a school it has found** (address, school id and name, for a week, in `localStorage`
  inside a try/catch, never an answer of "not found"), so a computer room behind one address asks once, not once per learner. A school's id never
  changes, so a kept answer cannot send a password to a new place.
- **A one-time password is changed first.** The office's password has `must_change_password` set, and until it is changed the server answers
  every route but `GET /v1/auth/me`, the sign-out and the password change with 403 "Password change required", the two-step status
  included. `continueSignIn` (`api/signInFlow.ts`) used to ask for the two-step status before it looked at that flag, so a handed-out password
  failed with that 403 instead of showing the "Choose your own password" step (finding student-web-3). It now stops at the password step
  without asking, and the step checks the server's rule (10 characters, letters and numbers) before it sends anything. After the change the
  one-time password no longer works, and a learner is never asked for two-step (the API refuses to configure it for the role).

The code is `packages/shared/src/api/schoolLookupApi.ts` (`apiLookupSchool`, `apiLoginWithSchool`, `schoolFromInput`) and the form in
`apps/web/src/api/ApiSignIn.tsx`.

## What works

- **Today:** the learner's class, the period that is on now and the rest of the day (from the published timetable), the work coming up
  (due today or later, soonest first) and its count.
- **Timetable:** the class's newest **published** timetable as a Monday to Friday grid with the room and the teacher (`GET .../me/children/{l}/timetable`),
  the period now highlighted. A class with no published timetable shows the screen's empty state. A period is named by its subject (the API
  has no free-text period names, so there is no "Break" or "Games" unless the school makes them subjects).
- **Work:** the class's homework due in the last three weeks or later, in two lists ("Coming up" and "Past due date"), with the instructions.
- **Learning materials:** by subject, the title, the date and the teacher's note. The files are not opened (see below), and the page says so once.
- **Results:** the exams the learner has published marks for, newest first with a switcher: each mark with the school's own grade, "40 / 50" for a paper
  not marked out of 100, the class mean (the server gives one only when 3 or more learners have a mark), the mean grade and points; CBE strand
  results; the published **report cards** as a summary (term, class, average, grade, strand levels and competency ratings).
- **Sports & activities:** the clubs and teams the learner is in, with their role and patrons.
- **Notices:** the notices that reach the learner (the whole school, their role, their class, their year group or them by name), newest first.
  A notice of the learner's class is "Class teacher", every other one "School office" (the inbox carries no author name).
- **My items:** what the school has lent the learner, what is out, what is overdue and what came back.

Everything is read for the learner's own learner: the id comes from `GET /v1/tenants/{t}/me/learner`, and the server answers 404 for any other
(`apps/api/docs/STUDENT-ACCOUNTS.md`). A login with no live learner behind it (the office revoked it, or the learner was archived) gets 404 on that
read and every page says "No learner record". A learner with no class opens every page with its empty state.

## What is hidden on the API build, and why (`studentCapabilities()` in `capabilities.ts`)

| Hidden | Why |
|---|---|
| "Mark as handed in", the Done tab, "overdue" and "late" (Work, Today) | the API records no hand-in or done state. Work is listed by its due date ("Coming up", "Past due date") and the page says it does not know what was handed in |
| Attach a file to hand in; the teacher's worksheets and videos on a piece of work | files wait on object storage (A5, FIG-1873) |
| The teacher's name and the hand-in method on a piece of work | the family read has neither (finding `parent-5`) |
| Open a learning material's file | files wait on A5: the title, subject, date and note are shown, with a note saying so |
| The live-class banner on Today | online classes are not on the API (C13) |
| A higher-education learner's timetable and course results (credits, GPA) | no read of a learner's own sections or grades on the API (student-10, finding `student-web-4`); the two pages say so |
| "Progress over time" under Results; missed or excused papers | no history read and no absence read for a learner |
| Report card PDF | the read gives the learner's own summary, not the subject rows; the PDF is made per class |
| Unread marks on notices; notice attachments | the inbox does not say what was read; files wait on A5 |
| Fixtures, trips and awards under Sports & activities | the family read has clubs and teams only (finding `parent-5`) |

## How the model is mapped

- The learner's class has no education level (finding `parent-1`), so it is read from the class name and year as for a parent (`levelOfChildClass`); it picks the grading scheme.
- A mark becomes a percentage (`score / max_score`) and keeps the raw score and the school's grade. An exam is the assessments of one title in one term.
- `fetchClassTimetable(classId)` on the API is the learner's own class (the id passed is ignored: the server reads the learner's), and `fetchOwnLearnerInventory` is the learner's own issues.
- The reads that look a child up in a parent's list (`apiFetchChildren`: CBE results, issued items) serve a learner from their own record. The shared code
  knows which of the two it serves from the person's role in the school of the tab (`api/ownLearner.ts`, set by the school session as the
  active school is), so it never asks a learner for the parent-only list (a 403 that the server audits).

## Checked on a real API (lighter checks)

A school with one learner who has a login (the office's one-time password), a class teacher, a published timetable (two periods a day), three pieces of
work (one past its due date), a material, a notice to the learner's class and one to another class (not shown), a published exam in two subjects (one
out of 50), a club and an issued textbook. In Edge: school address + login ID sign-in (a wrong password, an unknown school, a pasted address), the
forced password change (a weak password refused, then a good one), then every page above. Not tried: a school with a published report card, a CBE
learner, a higher-education school, two academic years, a revoked login mid-session, and the phone apps.

## Where the code is

- `apps/web/src/api/ApiStudent.tsx` (the console), `pages/student.pages.tsx` (the pages), `ApiSignIn.tsx` (the sign-in form and the password step).
- `packages/shared/src/api/studentApi.ts` (the learner's data, timetable and items), `ownLearner.ts` (the role and the learner's own record),
  `schoolLookupApi.ts` (the address lookup and the login), `signInFlow.ts` (the password step first).
- `packages/shared/src/studentData.ts`, `timetable.ts`, `inventory.ts`, `courses.ts` and `courseGrades.ts`: the `onApi()` branches.
- `apps/web/src/components/FamilyMaterials.tsx` (the materials list, moved out of `parent/Materials.tsx` so both pages share it).

## Things found while doing this (numbered `student-web-1` and up so that no other area shares a number)

student-web-1. **The school lookup is not in `dev-joe` yet.** `GET /v1/public/schools/{slug}` is its own API change (PR #414, branch
    `feature/api-public-school-lookup`), so `dev-joe`'s generated client has no such path and `schoolLookupApi.ts` calls it through an untyped cast and
    checks the answer by hand (`parseSchoolLookup`). Until that change is merged and deployed, the login-ID form against an API without the
    endpoint answers "We could not find a school with that address" for every address (the API's 404): the e-mail form, and a school's UUID typed
    in the address field, are not affected. When the path is in `schema.d.ts`, the cast can go.
student-web-2. **A learner cannot read the school profile** (`GET /school-profile` is a 403 for a learner, as for a parent: finding `parent-3`), and the
    session asks for it on every page load, so each load is an audited denial and the console has no accent colour, country, level or school type
    of the school: it shows the default green, assumes Kenya and a secondary school, and reads the school type from the school record. Adding
    `accent`, `country` and `level` to `GET /v1/tenants/{id}` (readable by every member), or a member-readable subset of the profile, would fix both.
student-web-3. **The sign-in flow asked for the two-step status before the password change** (fixed in this slice, `signInFlow.ts`): the server answers that
    status with 403 while `must_change_password` is set, so a handed-out password could not reach its change step. The existing unit test did not see it
    because its fake server answered the status.
student-web-4. **A higher-education learner has no read of their own sections or grades.** `GET /me/learner` has a class (null for them, probably) and
    the family reads are per class, so their timetable (the sections' periods) and course results (credits, GPA) are hidden. A learner's own
    `GET /me/learner/sections` (with the section's periods) and `.../course-results` would bring both pages back. (`student-10` on the API side.)
student-web-5. **Who set a piece of work, and who wrote a notice, is not in the reads.** A piece of work has no teacher name and a notice has no author, so
    the screens show a class notice as "Class teacher" and everything else as "School office", and a piece of work with no "set by". `teacher_name` and
    `author_name` on the homework and inbox rows would restore them.
student-web-6. **Login-ID sign-in is looser than the lookup** (finding `lookup-1`, `apps/api/docs/PUBLIC-SCHOOL-LOOKUP.md`): `login/login-id` refuses only a
    suspended school, the lookup finds only active, trial and overdue ones. The form follows the lookup, so a learner at a school that is still onboarding
    or stalled is told "school not found" (and someone who types that school's UUID in the address field would still get in). Owner decision on aligning them.
