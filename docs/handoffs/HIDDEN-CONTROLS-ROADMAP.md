# Roadmap: switch on the hidden controls on the API build

Written 2026-11-26 against `dev-joe` at `8c046627`. This is the first bullet of section 8 of `WEB-ON-API-ROADMAP.md` ("hidden
controls on connected pages") turned into a plan. That file counted 163 flags in 25 areas; the count below is made from the
code today and replaces it.

**This file is the plan. It holds no status.** Status lives in the working notes and in each slice's PR. Slice PRs must not
edit this file (that is what made earlier PRs conflict). It is refreshed in a docs PR when a wave ends.

## 1. The 179 controls, sorted by what each one needs

Method: every `false` in the `*_ON_API` constants of `packages/shared/src/capabilities.ts`, counted by script on 2026-11-26:
**179 controls in 28 areas**. Each is `true` on the Supabase build, so each is a real difference. Numeric limits (Bloom prompt
length, report range) and per-person gates (`canManageHomework` and the like) are not counted.

The flag comments say why each control is hidden, but **many are stale**: the API has gained endpoints since. Two agents
checked every flag against `apps/api/openapi/openapi.yaml`, the design notes and `docs/web-on-api/`, and I spot-checked the
surprising results. Appendix A is the full register; Appendix B lists the stale comments.

| Class | What it means | Flags | Handled in |
|---|---|---|---|
| **A** web only | The API already does it. The flag only needs its shared function wired and flipped. | 19 | Wave 0 |
| **B** API and web | The API lacks an endpoint or a field. Build it, then wire it. | 97 | Waves 1 and 2 |
| **C** file storage | Hidden only because it needs an upload or a download. The storage endpoints exist; the rest does not. | 16 | Wave 3 |
| **D** decision or outside dependency | Needs an owner decision, or something not built and not designed. | 28 | Wave 4 |
| **E** stays hidden | Hidden on purpose, closed by decision, or a flag no screen reads. | 19 | Appendix A, and W0.7 |

What the check found that changes the plan:

1. **A bug.** `examPapersApi.ts` sets a new paper's `publishedAt` to its creation time and never calls
   `POST /online-exam-papers/{id}/publish`. A new paper starts unpublished (migration 110) and learners only read papers
   where `published_at IS NOT NULL` (`apps/api/src/modules/student/exams.ts`). So papers made from the API build are
   probably invisible to learners. Read from the code, not yet run. It is slice W0.1, first.
2. **19 controls need no API work.** Classes, subjects and teaching assignments can already be edited and archived
   (migration 101, `docs/web-on-api/api-gap-fixes.md` says only the web branch is missing). Learner logins
   (migration 110), learner fees, early sign-outs, mark corrections and the family results trend are the same.
3. **File storage is further along than it looked.** The API has `POST/GET/DELETE /storage/objects`, `complete` and
   `download-url`, with owner types for payment proofs, avatars, the crest, homework, materials and exam papers
   (`apps/api/docs/STORAGE-OWNER-TYPES.md`). Missing: an S3 bucket (configured in no deployed environment), the web
   `files.ts` API branch, the content security policy, and a file column on each record.
4. **Dead flags.** `People.bulkChangeClass`, `People.bulkExport` and `Timetable.classTimetableEditor` are read by no screen
   (the first two were toast-only stubs on Supabase; the third duplicates `Setup.classTimetable`). Flipping them changes nothing.
   Eight more (the four Platform flags, `Parent.sickBayNotices`, `Parent.busUpdates`, `Parent.schoolPaymentDetails`,
   `Fleet.speedAlerts`) are also read by no screen: they need a screen change as well as the flag.
5. **Seven Bloom controls share one blocker**, six signature controls share another, seven call controls a third. Each is
   one piece of work behind an owner decision, not 20 small ones.

## 2. Rules every slice follows

`WEB-ON-API-ROADMAP.md` section 2 applies in full. In short, and with what is new:

- **Security first.** `sh scripts/security-scan.sh` before any build, lint, test run or commit. A match is a stop.
- **Worktree per slice** under `C:\Users\Admin\Desktop\Projects\sms-wt\<name>`, off `origin/dev-joe`. The main checkout stays
  on `dev-joe`, clean.
- **One slice per PR, into `dev-joe`, squash.** The owner merges. Never merge, approve or auto-merge. Push the branch, then
  open the PR. An API change is its own PR and merges before the web PR that uses it.
- **`main` is production.** Read `CHANGELOG.md` in full before touching `supabase/` or `apps/api/`. Never remove, rename or
  change what it lists as live; add new objects beside the old. Add each PR's change under "Unreleased". Code that touches
  attendance (W0.3 early sign-outs, W2.21 cover) must work with and without the four pending attendance migrations.
- **Migrations:** forward-only, numbered. The newest on `dev-joe` is 123 and open PR #436 may take 124. Run `gh pr list`
  and take the next free number above `dev-joe` and every open PR. Forced RLS plus a `figbloom_app` policy on every tenant
  table, minimal grants, `requirePermission`, OpenAPI updated then `npm run api:types`, every new `throw new Error(` in the
  `errors.inventory` test, negative authorisation tests before positive ones.
- **Every slice that turns a flag on does all of this:** the shared function gets its `onApi()` branch (API side in
  `packages/shared/src/api/`), the flag turns `true` in the `*_ON_API` constant, the **flag's comment is corrected** (no
  stale reason left), the area's `docs/web-on-api/<area>.md` is updated, there is a unit test, and one browser pass runs
  against a throwaway API (recipe in `WEB-ON-API-TODO.md`). Controls that stay hidden keep a written reason.
- **Delete means archive** on the API (nothing is hard-deleted). Where a screen says "Delete", the API slice archives and the
  label or help text says so, unless N10 is answered differently.
- **Hot spots.** `capabilities.ts` and `peopleCapabilities`-style one-line constants are edited by almost every slice. Two
  slices that edit the same area's constant, the same API module (`higherEd.ts` holds online exam papers) or the same migration
  number run one after the other. Merge `dev-joe` into a branch before pushing it.
- **Checks** are the lighter set the owner chose on 2026-11-24 (section 2 of the other roadmap). No mutation testing, no long
  browser sessions, no new e2e specs.
- **Hands off:** the owner's dev server on `:5173`, the `supabase_db_figbloom` database as a test target, the
  `figbloom-operations` stack, production, and **any AWS resource**. A step that needs AWS (the bucket, F0) is a stop.
- **Linear:** the owner updates it. Each slice ends with paste-ready text. Leave the FIG id out of partial slices' PR titles.
- **Limits:** at most 2 background agents and about 5 local stacks at once.

## 3. What "done" means

A control is done when **one** of these holds:

1. **On.** Its flag is `true` on the API build, every control behind it works against `apps/api`, and it has a test, a
   browser pass and a line in its area doc.
2. **Hidden by decision.** The owner decided it should not exist on the API build, or should wait. Its flag stays `false`,
   its comment states the decision, and the decision is in its area doc.
3. **Deleted.** The flag was dead (read by no screen) and is removed.

The roadmap is finished when all 179 are done in one of these ways and the owner agrees the list. End state: 3 deleted, 17
hidden on purpose (class E), and the other 159 on at most. If the owner follows my suggested answers in section 8 (which keep
chat oversight, medicine requests, provider checks, school roles, People import, the optional leave reason and the four
person-to-person call controls hidden), about 149 are on.

Not part of this roadmap: the production switch itself, the M-Pesa allowlist and retry, the four pending attendance
migrations, renaming the `20261106*` migrations, and HR L3/L4 as a build. All are in section 8 of the other roadmap and some
need Mike. HR L3/L4 reappears here only as decision N5.

## 4. Order of work

```
Web track:   W0.1 > W0.2 > W0.3 > W0.4 > W0.5 > W0.6 > W0.7
API track:   W1.1 > W1.4 > W1.2 > W1.3 > W1.5 > W1.6 > W1.7 > W1.8 > W1.9 > W1.10   (each: API PR, then web PR)
After both:  Wave 2, in the order of section 6 (by what unblocks what)
Storage:     N15 (the bucket, the owner) > F1 > F2 > F3 > F4 > F5    (starts when a bucket exists)
Decisions:   N1 to N17 asked at the start; a G slice starts when its answer arrives
```

1. **Wave 0** first: no API change, lowest risk, and W0.1 fixes a bug. Run it beside the first API slices (one agent each).
2. **Wave 1** next: small endpoints in one pattern (edit, archive, one missing field), each a short API PR and a short web PR.
3. **Wave 2**: the larger gaps, one area at a time. Each opens with a short design note in `apps/api/docs/`.
4. **Wave 3** the moment the owner provides a bucket. Until then the paste-only payment proof (W2.20) is the one storage-adjacent
   thing that can ship.
5. **Wave 4** as decisions arrive. Start with the ones that unblock the most: N3 (Bloom, 7), N2 (calls, 7), N1 (signatures, 6).

**Start with W0.1 and W0.2** (one agent each). W0.2 is where the most controls are hidden (Setup, 11) and none of it needs the API.

Rough size: about 80 PRs before the decision-gated work (W0 about 8, W1 about 24, W2 about 44, W3 about 9). With two agents and
the owner merging within hours, I expect W0 in about 1 working day, W1 in 2 to 3, W2 in 6 to 8, and W3 in 2 to 3 once the
bucket exists: **11 to 15 working days, about three weeks**. That is an estimate from how long earlier slices took, and it
moves with merge speed and usage limits. Wave 4 cannot be sized until its decisions are made.

## 5. Waves 0 and 1

Sizes: S under 2 hours, M 2 to 4 hours, L about a day (API, web, tests and docs together).

### Wave 0: web only (19 controls, plus 3 dead flags)

| ID | Slice | Flags | What to do | Size |
|---|---|---|---|---|
| W0.1 | Exam papers: publish (**bug**) | `ExamPapers.draftWorkflow` | Reproduce first (create a paper on the API build, sign in as a learner). Call `POST .../publish`; show a draft state and a Publish button. There is no unpublish, so that control stays hidden. | S |
| W0.2 | Setup: classes and subjects | `Setup.changeClassTeacher`, `deleteClass`, `classRoom`, `editSubject`, `subjectDetails`, `changeSubjectTeacher` | `PATCH classes` (teacher, room), `POST classes/{id}/archive` (label it Archive; refused while a learner is in the class; no restore), `PATCH subjects` (code, name, level, years, core), `PATCH` and archive on teaching-assignments. Split "Add from KICD" off `subjectDetails` into its own flag that stays hidden (needs W2.16 and D6). | M |
| W0.3 | People: record tabs and logins | `People.learnerLogins`, `learnerFees`, `learnerEarlySignOuts`, `learnerActivities`, `unassignClass` | Logins from the student-account endpoints (the Login column costs one read per learner: read on demand or by page; bulk create returns one-time passwords). Fees from `GET finance/invoices` by term (needs the finance read). Early sign-outs: the function exists, filter by learner in the browser. Activities: compose activities and members (clubs only). Unassign: `POST class-memberships/{id}/archive`. Two PRs: logins, then the rest. | M |
| W0.4 | Grades: corrections and CBE charts | `Grades.editPublishedMarks`, `cbeReports` | Published marks change through `POST mark-corrections` with a reason (5 to 500 characters; Academics write only), not a plain edit. CBE charts from `cbe-assessments` results grouped by learning area: check a plain teacher's read scope first; one results read per assessment. | M |
| W0.5 | Family: trend and bus | `Parent.progressOverTime`, `Student.progressOverTime`, `Parent.busUpdates` | Build "progress over time" from `GET me/children/{id}/results` (all terms, 500-row cap). Bus: `GET me/transport/notifications` and mark-read exist; no screen reads the flag, so the screen changes too. | M |
| W0.6 | Consoles on reads that exist | `Org.openSchoolConsole`, `Platform.tenantFiguresAndBilling` | Verify an org admin holds `tenant.read` in a delegated school, then open the school console on the API build. Tenants page: headcounts and invoice balances from `usage`, `invoices`, `subscriptions`; MRR and seats stay off (D3). No screen reads the platform flag yet. | L |
| W0.7 | Flag clean-up | `People.bulkChangeClass`, `bulkExport`, `Timetable.classTimetableEditor` | Delete the three dead flags from both constants and the interface. Correct the stale comments in Appendix B. Correct the 163/25 count in the other roadmap's section 8 and in `WEB_ON_THE_NEW_API.md` if it repeats it. | S |

### Wave 1: edit, archive and small gaps (36 controls). Each: API PR, then web PR

| ID | Slice | Flags | API work | Size |
|---|---|---|---|---|
| W1.1 | Homework | `Homework.editHomework`, `deleteHomework`, `handInMethod`, `parentGuide`, `optionalInstructions`, `Student.homeworkDetails` | `PATCH` and archive on homework-items; columns `hand_in`, `parent_guide`; relax the minimum length of `body`; teacher name and hand-in method on the family homework read. | M |
| W1.2 | Learning materials | `Materials.draftWorkflow`, `editMaterial`, `deleteMaterial` | `PATCH`, archive, `published_at` and a publish route. An external-link column (`url`) can land here so links work before storage (then `filesAndLinks` splits). | M |
| W1.3 | Exam papers: edit and archive | `ExamPapers.editPaper`, `deletePaper` | `PATCH` and archive on online-exam-papers. Same API module as W2.12 and W2.13: run in sequence. | M |
| W1.4 | Activities | `Activities.editActivity`, `deleteActivity`, `listPatrons`, `editMemberRole`, `removeMember` | `PATCH` (details, close, reopen), archive, `GET` and `DELETE` patrons, `PATCH` and `DELETE` a member. | M |
| W1.5 | Exams | `Grades.renameExam`, `deleteExam`, `examMarkCounts` | `PATCH` and archive on assessments (an exam is one assessment per class, so N calls or one grouped route); `marks_entered` on assessment rows. | M |
| W1.6 | Inventory items | `Inventory.editItem`, `unretireItem`, `itemCostAndNotes` | `PATCH` on items (unit, consumable, reorder level, purchase date, unit cost, notes); unretire (the service already reads retired items). | M |
| W1.7 | Inventory issues and fees | `Inventory.issueHistory`, `issueNote`, `chargeToFees` | A status filter on issues; a note on issue; link an issue to its fee charge (`POST finance/invoices/{id}/charges` exists). | M |
| W1.8 | Higher-ed courses and sections | `Courses.courseDepartment`, `sectionRoomAndCapacity`, `sectionSchedule`, `dropEnrolment` | Department column and `PATCH he-courses`; room and capacity on sections; a section meetings table; a withdraw route (the status exists, nothing sets it). | L |
| W1.9 | Timetable slots | `Setup.classTimetable` | `PATCH` and `DELETE` on timetable-slots (list and add are live; the week-grid editor needs edit). | M |
| W1.10 | Small gaps (six S slices, one PR each) | `Chat.unreadCounts`, `Notices.readState`, `ReportCards.clearCompetencyRating`, `Visitors.escalateAfterArrival`, `Org.schoolKind`, `Leave.optionalReason` | Unread count and last message on conversations; `read_at` on inbox items; `DELETE` a competency rating; an escalate route on a visit; `institutionType` on the org school list; relax the 3-character leave reason only if N12 says so. | 6 x S |

## 6. Wave 2: records and reads the API lacks (60 controls)

Each slice starts with a short design note in `apps/api/docs/`, then the API PR, then the web PR. Order: top to bottom, with the
"after" column as the hard dependencies.

| ID | Slice | Flags | Work | Size | After |
|---|---|---|---|---|---|
| W2.1 | Homework hand-in | `Parent.homeworkDone`, `Student.homeworkDone`, `Homework.submissions` | Submissions table; done and hand-in for a family; counts for the teacher; `done` on the family homework read. | L | W1.1 |
| W2.2 | Sick bay: lists | `Medical.visitHistory`, `medicationRound`, `medicationRequests`, `reports` | Visits by date range; school-wide schedules and administrations; a list of authorizations. Reports are web-only once the lists exist. | M | |
| W2.3 | Sick bay: the visit | `Medical.editVisitTimeIn`, `visitMedications`, `markVisitAttendance`, `Inventory.sickBayUsesStock` | `time_in` with a correction reason; a `visit_medications` table that posts a `used` movement (`POST inventory/movements` exists); write the attendance mark. | L | |
| W2.4 | Sick bay: notices and audit | `Medical.guardianNoticesEmitted`, `recordOpenAudited`, `Parent.sickBayNotices` | Write guardian notices (account links exist now); audit health reads. Caution: `*.viewed` events are hidden from the school log by design, so the screen's promise may not hold. | M | |
| W2.5 | Buses: reads and undo | `Fleet.routeStops`, `routeRiders`, `assignments`, `undoRiderMark` | `GET` stops; riders; the office read of who drives which vehicle; a correction event for a child's mark. Optional web-only control: "Tell families" through `escalate` (`notify_guardians`), which the web never calls. | M | |
| W2.6 | Buses: alerts | `Fleet.speedAlerts`, `tripAlertCounts` | A speed limit setting, an alert table, the route line; an incident count on trips. | L | W2.5 |
| W2.7 | Learner profile | `People.learnerHome`, `learnerHealth`, `bioData`, `Parent.childProfile` | Address, landmark and map pin (also unblocks "rebuild stops from homes" in W2.5); the missing health fields; bio data with an approval flow; what a parent may see. Four PRs. | L | |
| W2.8 | Staff subjects | `People.staffSubjects` | A "subjects a teacher can teach" table, read and write. | M | |
| W2.9 | Report cards: options and comments | `ReportCards.selectExamsAndOptions`, `comments` | Accept assessment ids and the optional sections; a per-learner comment table. One design note for the three report-card slices. | M | |
| W2.10 | Report cards: lifecycle | `ReportCards.draftWorkflow` | Draft and send. Withdraw only if N11 allows it. | L | N11 |
| W2.11 | Family report card rows | `Parent.reportCardPdf`, `Student.reportCardPdf` | Subject rows in the family read so a PDF can be made. | M | |
| W2.12 | Online exams: paper fields | `ExamPapers.readMode`, `scheduling`, `examLink` | Mode and body for typed papers, instructions, window, duration and kind (enforced on attempts), and the link to an assessment so scores reach the Gradebook. PDF papers also need F3. | M | W1.3 |
| W2.13 | Online exams: attempts and marking | `ExamPapers.scripts`, `writtenQuestions`, `Student.examScores`, `Parent.examPapers` | List attempts, mark written answers, release, extensions and excusals; short and long questions with model answers; the score in the learner read; a parent read of papers. | L | W2.12, N17 |
| W2.14 | Absent or excused marks | `Parent.examAbsences`, `Student.examAbsences` | An absence field on marks and its family read. | M | |
| W2.15 | Class promotion | `Setup.promoteClass` | An atomic move or promote: end memberships, place learners in the next year's class, archive leavers. | L | W0.2 |
| W2.16 | CBE and GPA gradebooks | `Grades.cbeGradebook`, `gpaGradebook`, `Student.higherEdPages` | A subject-to-learning-area link (also lets "Add from KICD" return, subject to D6); section assessments and marks tables; the learner's own sections and course results. | L | |
| W2.17 | Account and access | `Account.editProfile`, `Access.schoolRoles`, `People.importByAreaHolders` | `PATCH /auth/me` (name lives in two places; no second-phone column); named school roles, only if N13 says build; People area added to the import right, only if N14 says so. | L | N13, N14 |
| W2.18 | Announcement reach | `Announcements.reachCounts` | An audience headcount read. | M | |
| W2.19 | AI records | `Ai.savedChats`, `studyHelperUsage`, `schoolSwitch`, `Setup.aiSettings` | Chat and message tables with list, open, rename, delete; a per-learner monthly counter; an explicit Bloom on/off setting. | L | |
| W2.20 | School payment details | `Setup.feeSetup`, `Parent.schoolPaymentDetails` | Paybill, till and bank fields on the school profile, readable by a family; fix `fetchTermSetup`, which hardcodes `feeItemsCount` to 0 on the API. Also ship paste-only payment proofs for parents and learners (the file part is F2). | M | |
| W2.21 | Cover | `Timetable.coverageFlags`, `Dashboard.periodCoverage` | Per-period cover records (finding 44). Touches attendance: must work with and without the four pending migrations. | L | |
| W2.22 | Activity events | `Activities.events`, `Parent.activityEvents` | Events, participants, results, telling families, and the family read. | L | W1.4 |
| W2.23 | Org and platform lifecycle | `Org.schoolAdmins`, `Org.createOrganization`, `Platform.tenantLifecycleActions` | An org-level read of a school's administrators; sign-up (S6, PRs #436 and #437 are open: check them first); suspend, reactivate and move (D2 answered; needs the R2 and R5 fixes and the `console.figbloom.org` contract, which is still open). | L | |

## 7. Wave 3: file storage (16 controls) and Wave 4: decisions (28 controls)

### Wave 3. Starts when the owner provides a bucket (N15)

| ID | Slice | Flags | Work | Size |
|---|---|---|---|---|
| F0 | The bucket (**the owner**) | none | An S3 bucket, CORS for the web origin, access for the API, a cost note. I do not touch AWS. A local MinIO stands in for browser checks. | owner |
| F1 | Web storage client | none | The API branch of `packages/shared/src/files.ts` (start, PUT with `requiredHeaders`, complete, download link, delete); the content security policy in `apps/web/vercel.json` (`connect-src` for the PUT, `img-src` for photos). | L |
| F2 | Payment slips | `Fees.proofFiles`, `Parent.paymentProofSubmit`, `Student.paymentProofSubmit` | A `storage_object_id` on proofs and the route that sets it. | M |
| F3 | Homework, materials and papers | `Homework.attachments`, `Materials.filesAndLinks`, `ExamPapers.fileAttachments`, `Parent.homeworkFiles`, `Parent.materialFiles`, `Student.homeworkFiles`, `Student.materialFiles` | An attachment link on each record, and a family read rule (families cannot read academic files today). A learner's hand-in needs a learner-writable owner type. Files over 25 MiB (videos) need multipart upload and a product decision; external links avoid it. | L |
| F4 | Photos, crest, documents | `People.photos`, `Account.photo`, `Setup.schoolCrest`, `People.learnerDocuments` | An avatar link on learners, staff and users and a URL on `/auth/me`; a logo link on the school profile; a document-to-file link. Lists need signed URLs in a batch or thumbnails. The staff photo review has no API. | L |
| F5 | Announcement and chat attachments | `Announcements.attachments`, `Chat.attachments` | Two new owner types, link tables, audience and member-only reads. | M |

### Wave 4. Each G slice starts when its decision is answered (section 8)

| ID | Slice | Flags | Gate |
|---|---|---|---|
| G1 | Signatures | `Announcements.signatures`, `Fees.invoiceSignatures`, `ReportCards.signatures`, `Dashboard.pendingSignatures`, `Parent.signatures`, `Student.signatures` | N1 |
| G2 | Calls and live classes | `People.staffCalls`, `Account.calls`, `Chat.calls`, `Timetable.liveClasses`, `Parent.liveClasses`, `Parent.calls`, `Student.liveClasses` | N2 |
| G3 | Bloom contract v2 | `Announcements.aiHelper`, `ReportCards.aiComments`, `Inventory.stockInsights`, `Ai.webSearch`, `Ai.chatAttachments`, `Ai.guideSetupPlans`, `Ai.aiDrafting` | N3 |
| G4 | SMS and e-mail for announcements | `Announcements.smsAndEmail` | N4 |
| G5 | Leave through HR (L3, L4) | `Leave.hrLeave` | N5 |
| G6 | Chat oversight | `Chat.oversight` | N6 |
| G7 | Medicine requests | `Parent.medicationRequests` | N7 |
| G8 | Organisation figures and org admins | `Org.schoolFigures`, `Org.inviteOrgAdmin` | N8 |
| G9 | Live provider checks | `Platform.liveProviderChecks` | N9 |
| G10 | Study helper rules | `Student.studyHelperChecks` | N16 |

## 8. Decisions I need from the owner

I do not decide product questions. A slice that reaches its gate without an answer is **parked** and I carry on. "Suggested"
is my answer; "none" means I would not guess. The ones ahead of a wave are listed first.

| ID | Question | Gates | Suggested answer |
|---|---|---|---|
| N10 | "Delete" on homework, materials, papers, activities and assessments: archive (nothing is lost, as everywhere else in the API)? | W1.1 to W1.5 | Yes, archive, and say so on the button |
| N11 | May a published report card be withdrawn? The API's principle is "a publication is final". | W2.10 | No: keep corrections only; the flag becomes "draft then send" |
| N12 | Keep the 3-character minimum on a leave reason, or allow none? | W1.10 | Keep it; hide the "optional" wording |
| N15 | The S3 bucket: who creates it, which region, CORS, cost. | Wave 3 | Owner creates it; none from me |
| N13 | Build custom school roles ("Exams officer"), or are per-person areas the replacement? | W2.17 | Per-person areas are the replacement: keep the flag hidden |
| N14 | May People-area holders import learners (today full administrators only)? An access change. | W2.17 | No |
| N17 | When are auto-marked online-exam results released to learners? | W2.13 | After the teacher releases them |
| N1 | Signatures (C12): what is signed, by whom, with what legal weight. | G1 | none; a design note first |
| N2 | Calls and live classes (C13): the provider (the LiveKit token route exists and answers 503), recording, cost. | G2 | Live classes first; person-to-person calls later or never |
| N3 | Bloom: ask for a contract v2 (instructions, a structured answer, bigger prompts, tools, metering)? Who owns the contract? | G3 | Yes, as one request covering all seven controls |
| N4 | SMS and e-mail for announcements: provider and cost per message (Stage 12). | G4 | none |
| N5 | HR: ids, credentials, network (D7), and build L3 and L4 before `HR_LEAVE_ENABLED` is on for any school. | G5 | As D7 |
| N6 | May the office read every chat in the school? A privacy question. | G6 | No: keep it hidden |
| N7 | Medicine requests: guardian asks first, or the school authorises first (the API's flow)? | G7 | Keep the API flow; hide request and withdraw |
| N8 | Which figures may an organisation admin see; who may add an organisation admin (`ORG-CONSOLE.md` decisions 1, 2, 4)? | G8 | As that note suggests |
| N9 | Should the console ping live providers (Q7)? | G9 | No: keep it hidden |
| N16 | Study helper: enforce the school's opt-in and an open exam in `/ai/query` (finding student-6)? | G10 | Yes |

## 9. How I work through it

1. Start W0.1 and W0.2 together (one agent each), then W1.1 when a slot frees.
2. Per slice: worktree, security scan, design note (API) or flag corrections (web), authorisation tests first, code, checks, one
   browser pass, area doc, `CHANGELOG.md` entry, push, open the PR into `dev-joe`.
3. When the owner merges a PR, bring `dev-joe` into every open branch (merge, no force-push) before the next PR.
4. Every report ends with one table: the slice, its flags, `done` / `in PR` / `in progress` / `parked (decision)`, the PR
   numbers, what was verified, what was not, and paste-ready Linear text. The status tracker lives in the working notes,
   not here.
5. **I stop and tell the owner** when: the security scan matches; a conflict needs `main`'s behaviour undone (Mike); a test
   fails and I cannot explain it; a step would touch production or AWS (F0); or a usage limit is reached.
6. Close-out: re-run the count, correct the other roadmap's section 8 and `WEB_ON_THE_NEW_API.md`, hand over Linear text.

## Appendix A. The register: all 179 controls

Class: A web only, B API and web, C file storage, D decision, E stays hidden. Slice: where it is handled (`keep` means it stays
hidden on purpose; its reason is in the last column).

| Flag | Class | Slice | What it needs |
|---|---|---|---|
| `Setup.changeClassTeacher` | A | W0.2 | PATCH classes takes the class teacher (migration 101) |
| `Setup.deleteClass` | A | W0.2 | POST classes/{id}/archive; the screen must say Archive; refused while learners are in the class |
| `Setup.classRoom` | A | W0.2 | room is on create, update and read |
| `Setup.promoteClass` | B | W2.15 | a bulk move or promote endpoint (end memberships, place in next year's class) |
| `Setup.classTimetable` | B | W1.9 | PATCH and DELETE on timetable-slots (list and add already live) |
| `Setup.editSubject` | A | W0.2 | PATCH subjects |
| `Setup.subjectDetails` | A | W0.2 | level, years and core flag are live; "Add from KICD" needs W2.16's subject-to-learning-area link, so split it into its own flag |
| `Setup.changeSubjectTeacher` | A | W0.2 | PATCH and archive on teaching-assignments |
| `Setup.feeSetup` | B | W2.20 | payment-method fields on the school profile; the web hardcodes the fee item count to 0 |
| `Setup.schoolCrest` | C | F4 | school_logo owner type exists; the school profile has no logo link |
| `Setup.aiSettings` | B | W2.19 | an explicit Bloom on/off setting (shared with Ai.schoolSwitch) |
| `People.deleteLearner` | E | keep | the API archives only (an Archived view exists); hard delete is not in the model |
| `People.learnerLogins` | A | W0.3 | student-account endpoints (migration 110); page the Login column |
| `People.inviteGuardians` | E | keep | replaced by guardian invitations, which are already on |
| `People.guardianColumn` | E | keep | a fixed placeholder on both builds; no data behind it |
| `People.learnerFees` | A | W0.3 | GET finance/invoices by term (needs the finance read) |
| `People.bulkChangeClass` | E | W0.7 | no screen reads it: delete the flag (a real bulk move comes with W2.15) |
| `People.bulkExport` | E | W0.7 | no screen reads it: delete the flag (export jobs exist if one is wanted) |
| `People.learnerHome` | B | W2.7 | a learner has no address, landmark or map pin |
| `People.learnerHealth` | B | W2.7 | health profile lacks doctor, support needs, emergency contact, medicines |
| `People.bioData` | B | W2.7 | no birth certificate, UPI, nationality, religion, previous school or approval flow |
| `People.learnerDocuments` | C | F4 | documents are metadata only; link each to a stored file |
| `People.learnerEarlySignOuts` | A | W0.3 | the shared function exists; filter by learner in the browser |
| `People.learnerActivities` | A | W0.3 | compose activities and members (clubs only) |
| `People.photos` | C | F4 | avatar owner type exists; no avatar column; the staff photo review has no API |
| `People.passwordResets` | E | keep | staff and learner resets are separate API actions already on; the request queue is Supabase-only |
| `People.staffAccounts` | E | keep | staff are directory records; sign-in is by invitation instead (staffSignIn is on) |
| `People.staffSubjects` | B | W2.8 | a "subjects a teacher can teach" table, read and write |
| `People.staffCalls` | D | G2 | calls (C13) |
| `People.importByAreaHolders` | B | W2.17 | add People to the import right; needs the owner's sign-off (N14) |
| `People.unassignClass` | A | W0.3 | POST class-memberships/{id}/archive; the old trap was fixed in migration 101 |
| `Announcements.reachCounts` | B | W2.18 | an audience headcount read |
| `Announcements.attachments` | C | F5 | a new owner type, a link table, an audience-scoped read |
| `Announcements.signatures` | D | G1 | signatures (C12) |
| `Announcements.aiHelper` | D | G3 | Bloom drafting is not in the contract |
| `Announcements.smsAndEmail` | D | G4 | provider and cost decision (Stage 12) |
| `Fees.invoiceSignatures` | D | G1 | signatures (C12) |
| `Fees.proofFiles` | C | F2 | payment_proof owner type exists; proofs need a file link |
| `Account.editProfile` | B | W2.17 | no PATCH on /auth/me; the name lives in two places; no second-phone column |
| `Account.photo` | C | F4 | own photo via the avatar type; needs a link and a URL on /auth/me |
| `Account.calls` | D | G2 | calls (C13) |
| `Access.schoolRoles` | B | W2.17 | no write path for named roles; build it or retire the flag (N13) |
| `Leave.hrLeave` | D | G5 | staff apply in HR (L3) and HR events (L4); the approver side is already live (#435) |
| `Leave.optionalReason` | B | W1.10 | the 3-character rule is in the database; relax it or keep it (N12) |
| `ReportCards.selectExamsAndOptions` | B | W2.9 | POST report-cards takes term, class and scheme only |
| `ReportCards.draftWorkflow` | B | W2.10 | draft, send, withdraw; withdraw clashes with "publication is final" (N11) |
| `ReportCards.comments` | B | W2.9 | a per-learner comment table and write |
| `ReportCards.signatures` | D | G1 | signatures (C12) |
| `ReportCards.aiComments` | D | G3 | Bloom drafting is not in the contract |
| `ReportCards.clearCompetencyRating` | B | W1.10 | DELETE on competency-ratings |
| `Timetable.classTimetableEditor` | B | W0.7 | duplicate of Setup.classTimetable and no screen reads it: delete the flag |
| `Timetable.liveClasses` | D | G2 | live classes (C13) |
| `Timetable.coverageFlags` | B | W2.21 | per-period cover records |
| `Courses.courseDepartment` | B | W1.8 | a department column; no PATCH on he-courses |
| `Courses.sectionRoomAndCapacity` | B | W1.8 | room and capacity columns on sections |
| `Courses.sectionSchedule` | B | W1.8 | a section meetings table |
| `Courses.dropEnrolment` | B | W1.8 | a withdraw endpoint (the status exists, nothing sets it) |
| `Inventory.editItem` | B | W1.6 | PATCH on inventory/items |
| `Inventory.unretireItem` | B | W1.6 | unretire; the service already supports reading retired items |
| `Inventory.itemCostAndNotes` | B | W1.6 | purchase date, unit cost and notes columns |
| `Inventory.issueHistory` | B | W1.7 | a status filter on issues |
| `Inventory.issueNote` | B | W1.7 | accept a note when issuing |
| `Inventory.chargeToFees` | B | W1.7 | link an issue to its fee charge |
| `Inventory.stockInsights` | D | G3 | needs a new Bloom capability |
| `Inventory.sickBayUsesStock` | B | W2.3 | sick-bay medicine lines that take stock off by themselves |
| `Chat.attachments` | C | F5 | a new owner type, a message link, a member-only read |
| `Chat.calls` | D | G2 | calls (C13) |
| `Chat.oversight` | D | G6 | privacy decision first (N6) |
| `Chat.unreadCounts` | B | W1.10 | unread count and last message on conversations |
| `Grades.renameExam` | B | W1.5 | PATCH on assessments |
| `Grades.deleteExam` | B | W1.5 | archive an assessment |
| `Grades.examMarkCounts` | B | W1.5 | marks_entered on assessment rows |
| `Grades.withdrawResults` | E | keep | publication is final by design; corrections are the way to change a mark |
| `Grades.editPublishedMarks` | A | W0.4 | mark-corrections, with a reason dialog |
| `Grades.cbeGradebook` | B | W2.16 | a subject-to-learning-area link |
| `Grades.gpaGradebook` | B | W2.16 | section assessments and marks tables |
| `Grades.cbeReports` | A | W0.4 | cbe-assessments results grouped by learning area |
| `Parent.homeworkDone` | B | W2.1 | hand-in state, read and write |
| `Parent.homeworkFiles` | C | F3 | homework_attachment type exists; families cannot read it yet |
| `Parent.materialFiles` | C | F3 | learning_material type exists; families cannot read it yet |
| `Parent.liveClasses` | D | G2 | live classes (C13) |
| `Parent.signatures` | D | G1 | signatures (C12) |
| `Parent.calls` | D | G2 | calls (C13) |
| `Parent.childProfile` | B | W2.7 | date of birth, gender, home and health a parent may see |
| `Parent.progressOverTime` | A | W0.5 | build the trend from GET me/children/{id}/results (all terms) |
| `Parent.examPapers` | B | W2.13 | a family read of papers and attempts |
| `Parent.examAbsences` | B | W2.14 | an absent or excused field on marks |
| `Parent.reportCardPdf` | B | W2.11 | subject rows in the family report card read |
| `Parent.activityEvents` | B | W2.22 | activity events and a family read |
| `Parent.medicationRequests` | D | G7 | which side asks first is a clinical-flow decision (N7) |
| `Parent.sickBayNotices` | B | W2.4 | write guardian notices from the sick bay |
| `Parent.busUpdates` | A | W0.5 | GET me/transport/notifications and mark-read exist |
| `Parent.paymentProofSubmit` | C | F2 | a slip needs a file link; paste-only could ship earlier (W2.20) |
| `Parent.schoolPaymentDetails` | B | W2.20 | paybill, till and bank fields on the school profile, readable by a family |
| `Parent.childLogins` | E | keep | decided: the office makes and resets learner logins, parents do not |
| `Activities.editActivity` | B | W1.4 | PATCH on activities (details, close, reopen) |
| `Activities.deleteActivity` | B | W1.4 | archive or delete an activity (N10) |
| `Activities.listPatrons` | B | W1.4 | GET and DELETE patrons |
| `Activities.editMemberRole` | B | W1.4 | PATCH on a member |
| `Activities.removeMember` | B | W1.4 | DELETE on a member |
| `Activities.events` | B | W2.22 | events, participants, results and telling families |
| `Medical.visitHistory` | B | W2.2 | a visits list with a date range |
| `Medical.editVisitTimeIn` | B | W2.3 | time_in on create and patch, with a correction reason |
| `Medical.visitMedications` | B | W2.3 | a visit_medications table and route |
| `Medical.markVisitAttendance` | B | W2.3 | write the attendance mark from a visit |
| `Medical.medicationRound` | B | W2.2 | school-wide schedule and administration lists |
| `Medical.medicationRequests` | B | W2.2 | a list of pending authorizations |
| `Medical.reports` | B | W2.2 | web-only once the lists exist |
| `Medical.guardianNoticesEmitted` | B | W2.4 | write guardian notices (links exist now) |
| `Medical.recordOpenAudited` | B | W2.4 | audit health reads; they would be hidden from the school log by design |
| `Ai.savedChats` | B | W2.19 | chat and message tables with list, open, rename, delete |
| `Ai.webSearch` | D | G3 | needs a Bloom contract change |
| `Ai.chatAttachments` | D | G3 | needs a Bloom contract change and a Drive picker |
| `Ai.guideSetupPlans` | D | G3 | the contract has no tools |
| `Ai.aiDrafting` | D | G3 | lesson plans, paper import and comments are not in the contract (C13) |
| `Ai.studyHelperUsage` | B | W2.19 | a per-learner monthly counter |
| `Ai.schoolSwitch` | B | W2.19 | an explicit enabled setting |
| `Fleet.routeStops` | B | W2.5 | GET stops |
| `Fleet.routeRiders` | B | W2.5 | a riders read; "rebuild from homes" also needs W2.7's home pins |
| `Fleet.assignments` | B | W2.5 | an office read of who drives which vehicle |
| `Fleet.speedAlerts` | B | W2.6 | a speed limit setting, an alert table, the route line |
| `Fleet.undoRiderMark` | B | W2.5 | a correction event (a trigger refuses reversal today) |
| `Fleet.breakdownTellsFamilies` | E | keep | by design the report is record-only; the office can tell families through escalate (an optional new control, W2.5) |
| `Fleet.driverLiveFeed` | E | keep | a driver may not read the fleet by design; the phone's own position is used |
| `Fleet.tripAlertCounts` | B | W2.6 | an incident count on trips |
| `Org.schoolFigures` | D | G8 | which figures an org admin may see (owner decision 4) |
| `Org.schoolKind` | B | W1.10 | add institutionType to the org school list |
| `Org.addSchool` | E | keep | a school is provisioned by a platform super admin |
| `Org.openForSignIn` | E | keep | a school opens when its first administrator accepts the invitation |
| `Org.schoolAdmins` | B | W2.23 | an org-level read of a school's administrators |
| `Org.openSchoolConsole` | A | W0.6 | delegated permissions already exist; verify an org admin holds tenant.read |
| `Org.inviteOrgAdmin` | D | G8 | who may add an org admin (owner decisions 1 and 2) |
| `Org.createOrganization` | B | W2.23 | the sign-up route (S6; PRs #436 and #437 are open) |
| `Org.pageViewLog` | E | keep | the API records actions, not page views |
| `Dashboard.pendingSignatures` | D | G1 | signatures (C12) |
| `Dashboard.periodCoverage` | B | W2.21 | per-period cover (same work as Timetable.coverageFlags) |
| `ExamPapers.readMode` | B | W2.12 | a paper mode and body; PDF papers also need F3 |
| `ExamPapers.scheduling` | B | W2.12 | instructions, window, duration and kind columns, enforced on attempts |
| `ExamPapers.fileAttachments` | C | F3 | exam_paper owner type exists; papers need a file link |
| `ExamPapers.examLink` | B | W2.12 | link a paper to an assessment so scores reach the Gradebook |
| `ExamPapers.draftWorkflow` | A | W0.1 | BUG: the web never calls POST publish, so learners cannot see new papers. No unpublish exists |
| `ExamPapers.editPaper` | B | W1.3 | PATCH on online-exam-papers |
| `ExamPapers.deletePaper` | B | W1.3 | archive or delete a paper (N10) |
| `ExamPapers.writtenQuestions` | B | W2.13 | short and long questions, model answers, manual marking |
| `ExamPapers.scripts` | B | W2.13 | list attempts, mark, release, extensions, excusals |
| `Materials.filesAndLinks` | C | F3 | learning_material owner type exists; external links alone need only a url column |
| `Materials.draftWorkflow` | B | W1.2 | a published_at and a publish route |
| `Materials.editMaterial` | B | W1.2 | PATCH on learning-materials |
| `Materials.deleteMaterial` | B | W1.2 | archive or delete a material (N10) |
| `Visitors.escalateAfterArrival` | B | W1.10 | an escalate route on a visit |
| `Homework.editHomework` | B | W1.1 | PATCH on homework-items |
| `Homework.deleteHomework` | B | W1.1 | archive or delete a homework item (N10) |
| `Homework.handInMethod` | B | W1.1 | a hand_in field, written and read by families |
| `Homework.parentGuide` | B | W1.1 | a structured parent_guide field |
| `Homework.submissions` | B | W2.1 | a submissions table and the counts read |
| `Homework.attachments` | C | F3 | homework_attachment owner type exists; items need an attachment link |
| `Homework.optionalInstructions` | B | W1.1 | relax the minimum length on body |
| `Audit.fieldChanges` | E | keep | audit rows carry no detail by design (names, amounts, health) |
| `Audit.everyChange` | E | keep | the school log shows classified business events only, by design |
| `Platform.curriculumPage` | E | keep | closed by decision D6 |
| `Platform.impersonationPage` | E | keep | closed by decision D4 |
| `Platform.tenantFiguresAndBilling` | A | W0.6 | usage, invoices and subscriptions reads exist; MRR and seats stay off (D3) |
| `Platform.tenantLifecycleActions` | B | W2.23 | suspend, reactivate and move; needs R2 and R5 fixes and the console.figbloom.org contract |
| `Platform.tenantIllustrativeCharts` | E | keep | fixed numbers on the Supabase screen; never shown on the API (risk R6) |
| `Platform.liveProviderChecks` | D | G9 | owner question Q7: pings to providers from the console |
| `Student.homeworkDone` | B | W2.1 | the same hand-in state as the parent's |
| `Student.homeworkFiles` | C | F3 | teacher files like the parent's, plus a learner-writable hand-in type |
| `Student.homeworkDetails` | B | W1.1 | teacher name and hand-in method on the family homework read |
| `Student.materialFiles` | C | F3 | the same as Parent.materialFiles |
| `Student.liveClasses` | D | G2 | live classes (C13) |
| `Student.higherEdPages` | B | W2.16 | learner reads of own sections and course results |
| `Student.progressOverTime` | A | W0.5 | the same results read as the parent's |
| `Student.examAbsences` | B | W2.14 | the same absent or excused field |
| `Student.reportCardPdf` | B | W2.11 | the same subject rows |
| `Student.signatures` | D | G1 | signatures (C12) |
| `Student.paymentProofSubmit` | C | F2 | a slip needs a file link; paste-only could ship earlier (W2.20) |
| `Student.examScores` | B | W2.13 | a released state and a score in the learner read |
| `Student.studyHelperChecks` | D | G10 | opt-in and exam-lock checks in /ai/query (student-6) |
| `Notices.readState` | B | W1.10 | read_at on inbox items |

## Appendix B. Stale flag comments to correct, and flags no screen reads

Corrected in the slice that handles the flag (W0.7 for the rest).

- `Setup.changeClassTeacher`, `deleteClass`, `classRoom`, `editSubject`, `subjectDetails`, `changeSubjectTeacher`: all live since
  migration 101. `subjectDetails` also hides "Add from KICD", which is not live.
- `People.unassignClass`: the "cannot give the class back" trap was fixed in migration 101.
- `People.learnerLogins`: "learners have no accounts" is out of date (migration 110, `student-account` endpoints).
- `People.learnerEarlySignOuts`: the shared function already exists.
- `Setup.classTimetable`: misleading. Listing and adding periods are live (`Timetable.classPeriods`); only edit is missing.
- `Leave.hrLeave`: "Leave to approve" is live (#435). The flag now guards only staff applying through HR (L3, L4).
- `ExamPapers.draftWorkflow`: out of date. Since migration 110 a new paper is unpublished and `POST .../publish` exists.
- `Parent.progressOverTime`, `Student.progressOverTime`: "no history read" is wrong; the results read spans all terms.
- `Parent.busUpdates`: "not ported" is wrong; the endpoints exist.
- `Parent.childLogins`: cites A4, which is done. The real reason is the owner's decision that the office resets logins.
- `Medical.guardianNoticesEmitted`: cites deferred account linking; guardian links exist now.
- `Fleet.breakdownTellsFamilies`: `escalate` has `notify_guardians` and the web never calls it.
- `WEB-ON-API-ROADMAP.md` sections 1 and 8: "163 capability flags in 25 areas" should read 179 in 28.

Read by no screen, so flipping them does nothing until a screen reads them: `Parent.sickBayNotices`, `Parent.busUpdates`,
`Parent.schoolPaymentDetails`, `Fleet.speedAlerts`, `Platform.tenantFiguresAndBilling`, `tenantLifecycleActions`,
`tenantIllustrativeCharts`, `liveProviderChecks`, and the three dead flags in W0.7.
