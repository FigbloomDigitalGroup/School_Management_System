# Student pages (student/*)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file. The API side is
`apps/api/docs/STUDENT-ACCOUNTS.md` (owner decisions of 25 November 2026, the endpoints, findings `student-1` to `student-14`).

A learner signs in with the login the school office made (`ST-0001` and a one-time password) and opens the **student console**: **Today**,
**Timetable**, **Work**, **Learning materials**, **Results**, **Sports & activities**, **Notices**, **My items**, **Fees**, **Exams & tests**,
**Chats** and **Ask Bloom** (all 12 student pages). The pages are registered in `apps/web/src/api/pages/student.pages.tsx` (the ones that only
read) and `student-actions.pages.tsx` (Fees, Exams & tests, Chats, Ask Bloom), under the `student` kind (`StudentPageDef` in `pages/types.ts`, `studentPageDefs` and
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
- **Fees:** the balance of "this term's invoice" (the newest one that is not voided: the API has no current term for a learner, finding `parent-4`),
  what it is made of (the invoice's lines stand in for the term's fee structure, which a learner cannot read), charges, receipts and the proofs of
  payment already sent with their status and reason. **Pay with M-Pesa** asks `POST /finance/mpesa/prompts` for the learner's own invoice (allowed
  for the learner only, by decision 4) and reads the payment back from their own fees (`me/children/{l}/fees`) until the provider says it settled; where
  M-Pesa is not set up for the school the dialog says so and shows nothing was charged.
- **Exams & tests:** the online papers **published** for the learner's own class (`GET /me/learner/online-exams`; another class's paper is never listed).
  **Start** makes the learner's own attempt, the questions load without the answer key, the answers save as the learner goes (Save and leave, Carry on),
  and **Hand in** submits them; the server marks them against the key and tells the learner no score. One attempt per paper.
- **Chats:** one-to-one chats with the school's administrators and the teachers of the learner's own class (class teacher or a teaching assignment), listed
  from `GET /me/chat-contacts` and the usual `/chat/conversations`, polled while a thread is open. Nobody else is offered (no learner-to-learner, no parents:
  owner decision 3). The wording says so ("Chat with your class teachers and the school office."), where Supabase says "your parents and guardians".
- **Ask Bloom:** the study helper reads `GET /ai/status` (on when Bloom is on for the school) and asks `POST /ai/query` with the **public** scope, the
  only one the API gives a learner, the whole chat packed into the one 4,000-character prompt. Where Bloom has no provider (a local API) it says "Bloom AI
  is not available on this server yet".

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
| Send a proof of payment (Fees) | the proof's file needs object storage (A5); the proofs already on the invoice are listed, and the page says why it cannot send one |
| "How to pay" (paybill, till, bank) and invoice and receipt signatures (Fees) | a learner cannot read the school profile (finding `student-web-2`); signatures wait on C12 (FIG-1880) |
| An exam's window, time limit, deadline, "missed", resits and extra time; read-only PDF and typed papers; a paper's kind | the API's online exam has none of them (finding `student-web-7`); a paper is open once published and has one attempt |
| "Your score", released results and a review of a marked paper (Exams & tests) | the API marks the attempt and gives the learner no score; the page says "Your teacher has your answers" instead |
| The study helper's opt-in check at an opt-in school, and its lock while an exam is open | `/ai/query` does neither (finding `student-web-8`) |
| Files and calls in chats, unread marks and counts | files wait on A5, calls on C13, and the API does not say what a learner has read |

## How the model is mapped

- The learner's class has no education level (finding `parent-1`), so it is read from the class name and year as for a parent (`levelOfChildClass`); it picks the grading scheme.
- A mark becomes a percentage (`score / max_score`) and keeps the raw score and the school's grade. An exam is the assessments of one title in one term.
- `fetchClassTimetable(classId)` on the API is the learner's own class (the id passed is ignored: the server reads the learner's), and `fetchOwnLearnerInventory` is the learner's own issues.
- Online exams (`api/studentExamsApi.ts`): a paper is mapped to the screens' own paper (`mode: online`, open from the day it was published, no end, no
  limit), the learner's attempts to their standing (not started, in progress, handed in), and the answer to a question is the **text of the chosen
  option**, which is what the server compares with the key (ignoring case and spaces); the screens keep the option's number, so the shared code turns
  numbers into text on the way out and back on the way in. A true or false question lists no options of its own, so "True" and "False" are offered. A
  paper with no questions cannot be sat online (the API answers 409) and is left out of the list. Starting a paper twice at once (a page that
  renders twice) is one start, and a 409 "already started" is carried on from the attempt that is there.
- Fees (`api/studentApi.ts`, `apiLoadStudentFeeData`) is the family fees read of the learner's own id, shaped as the screen's own `StudentFeeData`.
- Chats: a learner's list of people is `GET /me/chat-contacts` (as a parent's), not the staff list (`chatDirectoryFor` in `api/chatApi.ts`).
- The reads that look a child up in a parent's list (`apiFetchChildren`: CBE results, issued items) serve a learner from their own record. The shared code
  knows which of the two it serves from the person's role in the school of the tab (`api/ownLearner.ts`, set by the school session as the
  active school is), so it never asks a learner for the parent-only list (a 403 that the server audits).

## Checked on a real API (lighter checks)

Part B: the same school, with the term billed (one invoice of KSh 25,000), a published online paper of two questions (multiple choice and true or false)
for the learner's class and one for another class (not listed), the school's study helper settings made, and the class teacher. In Edge, as the learner:
Fees (balance, what it covers, the proofs note, then Pay with M-Pesa: this API has no M-Pesa provider, so the dialog says online M-Pesa is not available and
nothing was sent); Exams & tests (only the learner's class's paper listed, Start, answer, Save and leave, Carry on with the saved answer ticked, Hand in with
the confirm, then Done 1 and no score anywhere); Chats (the picker lists the class teacher and the school office and nobody else, a message to the class
teacher is sent and shows, and the teacher's own conversation list has it); Ask Bloom (the page opens, the question is sent with the public scope, and the
local API with no provider answers "Bloom AI is not available on this server yet"). Not tried: a real M-Pesa prompt, a real Bloom answer, a reply from the
teacher in the browser, a paper with a true or false key that is not "true" or "false", two learners sitting at once, and the phone apps.

Part A:

A school with one learner who has a login (the office's one-time password), a class teacher, a published timetable (two periods a day), three pieces of
work (one past its due date), a material, a notice to the learner's class and one to another class (not shown), a published exam in two subjects (one
out of 50), a club and an issued textbook. In Edge: school address + login ID sign-in (a wrong password, an unknown school, a pasted address), the
forced password change (a weak password refused, then a good one), then every page above. Not tried: a school with a published report card, a CBE
learner, a higher-education school, two academic years, a revoked login mid-session, and the phone apps.

## Where the code is

- `apps/web/src/api/ApiStudent.tsx` (the console), `pages/student.pages.tsx` (the pages), `ApiSignIn.tsx` (the sign-in form and the password step).
- `packages/shared/src/api/studentApi.ts` (the learner's data, timetable and items), `ownLearner.ts` (the role and the learner's own record),
  `schoolLookupApi.ts` (the address lookup and the login), `signInFlow.ts` (the password step first).
- `packages/shared/src/api/studentExamsApi.ts` (exams and the sitting), `chatApi.ts` (the learner's contacts) and `aiApi.ts` (`apiAskTutor`).
- `packages/shared/src/studentData.ts`, `studentExams.ts`, `examPapers.ts`, `ai.ts`, `timetable.ts`, `inventory.ts`, `courses.ts` and `courseGrades.ts`: the `onApi()` branches.
- `apps/web/src/components/FamilyMaterials.tsx` (the materials list, moved out of `parent/Materials.tsx` so both pages share it).

## Things found while doing this (numbered `student-web-1` and up so that no other area shares a number)

student-web-1. **The login-ID form needs the deployed lookup.** `GET /v1/public/schools/{slug}` (#414) is merged, and `schoolLookupApi.ts` calls it typed. Against
    an API that has not been deployed with it, the form answers "We could not find a school with that address" for every address (the API's 404): the
    e-mail form, and a school's UUID typed in the address field, are not affected.
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
student-web-7. **The API's online exam is minimal, and the Exams page shows what that leaves** (`student-4` on the API side). No window, time limit or deadline (so no timer and
    no "missed"), no resit or extension, no excusal, no kind (every paper is labelled "Exam"), no instructions, no read-only PDF or typed paper, no "results
    released" state, so a learner never sees a score or a review. A paper with no questions cannot be sat online and is not listed. A learner who leaves a paper
    can carry on, but cannot start it again once handed in. A true or false question is offered as "True" and "False" and is marked by comparing that text with
    the teacher's key, so a key written any other way ("yes") can never be matched.
student-web-8. **The study helper has no learner rules on the API** (`student-6`): `/ai/query` does not check the learner's opt-in at an opt-in school and does not refuse while an
    exam is open, so the page offers neither. Built as the API allows; an owner decision whether the opt-in gates learners and whether an exam locks the helper.
student-web-9. **The chat notice "The school's administrators can read this chat" has no read behind it** (`student-5`). Owner default, kept: a learner is still told it, on the API as on Supabase
    (`ChatThread`, learners only; the API build hides it for every other role because `chatCapabilities().oversight` is off). No administrator can read a chat they are
    not in, for any role. Either the words change or an audited oversight read is built: an owner decision.
student-web-10. **A learner cannot chat with their guardians** (owner default, `student-1`): the chat wording on the API build lists class teachers and the school office only. Owner question whether
    a learner may also reach their own guardians, and whether office staff (role `staff`) count as "the office" (`student-2`).
student-web-11. **A learner has no read of the school's payment details, and no term.** "How to pay" is not shown (finding `parent-3`), and "this term's invoice" is the newest invoice that is not
    voided, so a past term's balance can stand in until the new term is billed (finding `parent-4`). Paying reads the payment back by re-reading the learner's fees every 3
    seconds for up to 90 (finding `parent-6`).
