# Student accounts (A4)

Written 2026-11-25. How a learner signs in to the API, what they may read and do, how the school office makes and manages
their login, and what the 12 student web pages can and cannot be served yet. Migration 110; code in
`src/modules/student/`, `src/http/routes/studentAccounts.ts` and the student branches in `routes/family.ts`,
`routes/academicsHigher.ts`, `modules/finance/payer.ts` and `modules/storage/ownerTypes.ts`. Tests:
`test/student.accounts.test.ts` (negative first) plus the student principal in `test/rbac.matrix.test.ts`.

## Owner decisions (made by the owner on 2026-11-25)

1. **Login.** The school office makes a learner's login: a school administrator, or a teacher or staff member holding the
   People area (the same callers as the Supabase `provision-student` function). Login id like `ST-0001`; a random one-time
   password shown ONCE to the office; `must_change_password` forced at first sign-in; resets by the office. It works with no
   e-mail. No parent-made logins, no e-mail invitation.
2. **Session.** Like guardians: the same idle timeout (30 minutes) and the 8-hour absolute lifetime as the parent role. No
   two-step sign-in for students, never forced.
3. **Chat.** A learner may chat one-to-one with the teachers of their own class and the school office ONLY. No
   learner-to-learner. (The screens say the school's administrators can read every chat; see finding student-5.)
4. **Fees and exams.** A learner may read their OWN invoices and receipts and pay by M-Pesa (adult higher-education
   learners have no guardian), and may see the published online exam papers of their own class and submit ONLY their own
   attempts. Nothing about any other learner, ever.

## The design

### One rule decides "my learner"

`learner_accounts` (owner-only, like `guardian_accounts`) links a login to a learner record: one live login per learner, a
login belongs to one learner for ever (`user_id` is unique), revocable with a reason. `student_my_learner()` (a `STABLE
SECURITY DEFINER` function, no argument, `search_path = pg_catalog, pg_temp`, `EXECUTE` for `figbloom_app` only) returns the
caller's own learner in the school of the request when ALL of these hold, now:

| Check | What breaks it |
|---|---|
| a live link for this user in this school (`learner_accounts.revoked_at IS NULL`) | the office revokes it; the membership is archived (trigger revokes it for good) |
| the account is active (`users.status = 'active'`) | the account is disabled |
| a `student` membership of this school, not archived, school not suspended | the membership is archived (deactivated) |
| the learner is active (`learners.active AND archived_at IS NULL`) | the learner is archived (the link stays, but reaches nothing until the learner is restored) |

User and school come from the transaction settings the API sets after authorising the request, so nobody can ask about
another account. Nothing is cached in the token.

### Permission

`resource.student.self.read` ("a learner reads their own school records"), granted to the `student` role (and, like every
catalogued permission, to `super_admin`, who has no student membership and so no learner). It is not implied by any admin
area and cannot be delegated. The learner role holds no write, administer or manage permission: the few things a learner
does (pay, send a proof, start / save / submit their own exam attempt) are gated by the own-learner rule, like the parent's
payer path, not by a write permission.

A learner does NOT get `resource.family.read`. The per-learner reads are shared (below) through a **student branch of the
same resolver**: `inChild` in `routes/family.ts` takes the student branch for a `student` member (needs
`resource.student.self.read`, then `student_my_learner()`), and the family branch for everyone else (needs
`resource.family.read`, then `family_my_children()`). One learner id serves both roles, so the web modules are shared.

### Provisioning (the school office)

All four need `resource.learner.write` in the API (a school administrator, a People-area teacher or staff member, a super
administrator) and are re-checked in the database by `student_account_actor_may_manage()`: super administrator, school
administrator, or a teacher/staff member holding `people` directly (`staff_area_grants`) or through a school role. An
organisation administrator is refused even with a grandfathered `area.people` delegation (that area is no longer
delegable, owner decision 2026-11-17; finding student-3).

| Endpoint | What it does |
|---|---|
| `GET /v1/tenants/{t}/learners/{learnerId}/student-account` | status: `has_login, login_id, account_status, must_change_password, created_at, password_set_at, last_sign_in_at, revoked_logins`. Never password material. 404 for a learner not in this school |
| `POST .../student-account` | makes the login: a new account (no e-mail, the learner's name, `must_change_password = true`), a `student` membership with the next free `ST-NNNN` of the school, the link. **201 with `one_time_password` once**; `Cache-Control: no-store`. 409 when the learner already has a live login (never a second account), 409 for an archived learner, 404 for another school's learner |
| `POST .../student-account/reset-password` | needs a recently confirmed password (`/v1/auth/reauth`, like every administrator reset). A new one-time password once, `must_change_password = true` again, every session of the login ended, open reset tokens voided. A disabled login stays disabled (409). 404 without a login |
| `POST .../student-account/revoke` `{reason}` | needs a recently confirmed password. Final: link revoked, `student` membership archived (the login id stops signing in), every session ended. A new login is a new create (a new account and a new login id) |

- **The one-time password** is 12 characters from an alphabet without look-alikes (no 0/O, 1/l/I), always with a letter and
  a digit (the password policy). Only its Argon2id hash reaches the database (through the definer, so `password_hash`
  still appears in no API source file but `auth/service.ts`). It is never logged, never in an audit detail, never in a
  status read, and there is no Idempotency-Key replay of a create or reset (a replay would have to repeat it). If the
  answer is lost, the office resets the password.
- **Login ids** are allocated under the same per-school advisory lock as every other login id (072, 073): `max + 1` over
  every `ST-` membership of the school, archived ones included, so a number is never reused. Concurrent creates for one
  learner serialise on the learner row; the partial unique index `learner_accounts_live_learner_uidx` is the backstop.
- **Audit**: `student.account.created`, `student.account.password_reset`, `student.account.revoked` (also written by the
  membership-archive trigger with `cause: membership_deactivated`), each with the learner, the account and the login id.

### Signing in

The existing `POST /v1/auth/login/login-id` `{tenantId, loginId, password}` signs a learner in (the login id is
case-insensitive) and lands them in their school (`activeTenantId`, `authz.role = student` on `/v1/auth/me`). With the
one-time password every route but `GET /v1/auth/me`, `POST /v1/auth/logout` and `POST /v1/auth/password/change` answers
403 "Password change required" (the existing gate). After the change the one-time password no longer works.

- **Idle timeout**: `auth_session_idle_seconds` (replaced in 110) gives a student the guardian value, 30 minutes; an account
  that also holds a staff, organisation or platform role keeps 15. The 8-hour absolute lifetime is unchanged (all roles).
- **Two-step sign-in**: never required. `auth_mfa_state` requires MFA for a school role only when it is named in
  `MFA_REQUIRED_ROLES`, and the configuration now refuses `student` there (startup fails), so it cannot be switched on. A
  learner is never a school administrator, organisation or platform administrator or Fees-area holder.

### Reads for the learner's own learner

Shared with parents (the student branch of the same endpoint; `learnerId` must be the caller's own learner, every other id
is **404 "Learner not found"**, audited as `student.learner.denied`):

`GET /v1/tenants/{t}/me/children/{learnerId}/` `attendance`, `results`, `report-cards`, `homework`, `materials`,
`timetable`, `fees`, `activities`, `items`. Same shapes and rules as for parents (`FAMILY-READS.md`): published or closed
marks only (class mean only from 3 marks), the learner's own report-card slice, the newest published timetable, invoices
without voided charges and without any payer's phone number.

Parents only (a learner gets the audited 403): `GET /me/children` (the list), `GET /me/children/{id}/health` (no student page
shows health), `/me/transport`, medication consent.

Learner only (`resource.student.self.read`; a parent, teacher or administrator gets 403):

| Endpoint | Returns |
|---|---|
| `GET /v1/tenants/{t}/me/learner` | the learner's own record: `learner_id, full_name, admission_no, boarding, login_id, class` (current-year class or null). 404 when the caller has no live learner here |
| `GET /me/learner/online-exams` | published papers of the learner's own active current-year classes (at most 200): title, subject, class, `max_score`, `question_count`, `published_at` and the learner's own attempts. No question, key or score |
| `GET /me/learner/online-exam-attempts/{attemptId}` | one of the learner's own attempts: the paper's questions **without the answer key** (an allowlist: `id, prompt, kind, options, points`) and the answers saved so far |
| `PUT /me/learner/online-exam-attempts/{attemptId}/answers` `{answers}` | save answers while in progress (keys must be the paper's question ids; a submitted attempt is 409) |

Also open to a learner, unchanged in shape:

- `GET /communications/announcements/inbox` and `POST .../{id}/read`: `communications_audience_reaches` (replaced in 110)
  now lets a `class` notice reach a learner whose learner is an active member of that class, and a `form_level` notice a
  learner in an active current-year class of that level. Whole-school, `role: student`, `user` and `people` notices
  reached learners already. Staff and parent reach is unchanged.
- `GET /me/chat-contacts`: for a learner, the school's administrators and the teachers (class teacher or an active
  teaching assignment) of their own current-year class, with what they teach. Then `/chat/conversations...` as for
  everyone.
- `GET /ai/status`, `POST /ai/query`: see "AI study helper".

### Paying (decision 4)

`assertMayPayFor` (`modules/finance/payer.ts`) allows a `student` member for their OWN learner only (`mayPayFor`, the
same function the storage owner type uses). That opens, for the learner's own invoices only: `POST /finance/mpesa/prompts`
(the payment is read back through `/me/children/{id}/fees`, as for parents), `GET /finance/invoices/{id}/pdf`,
`POST /finance/proofs` (stored as `submitted_via: learner`, a new value), a `payment_proof` file upload through
`/storage/objects` and `PUT /finance/ai-helper/optins`. Any other learner's invoice, or an invoice that does not exist, is
the same 403. Staff and super administrators still cannot pay.

### Online exams (decision 4)

- `online_exam_papers.published_at` (new): a learner sees a paper only once staff publish it with
  `POST /online-exam-papers/{paperId}/publish` (`resource.academics.write`; publishing twice keeps the first time; no
  unpublish). Existing papers stay unpublished. `published_at` is now in the staff paper list too.
- The existing attempt endpoints take a learner branch: `POST /online-exam-papers/{paperId}/attempts` with
  `learner_id` = the caller's own learner only (another id is the audited 404); the paper must be published for one of the
  learner's own current classes (404) and have questions (409); **one attempt per paper for a learner** (409); the answer
  is the attempt with the questions without the key. `POST /online-exam-attempts/{attemptId}/submit`: the learner's own
  attempt only (404 otherwise), answers only (a `score` is 403), marked automatically against the key with `marked_by`
  null, and the answer carries **no mark**. No Idempotency-Key replay for a learner (a replay would return the mark).
- Staff keep their path unchanged (`resource.academics.write`).

### Chat (decision 3)

`may_talk` (replaced in 110) adds a student branch: a learner and a school administrator, or a learner and a teacher of
their own learner's class (class teacher or active teaching assignment, active current-year class, active membership).
Either side may start. The learner side needs a live link and an active learner, so a revoked login or an archived learner
closes the chat at once. Learner-to-learner, learner-to-parent and learner-to-any-other-staff (including People-area staff
with role `staff`) are refused. Staff-to-staff and every parent rule are exactly as in 100.

### AI study helper

`POST /ai/query` already treats `student` as a public-only role (`BLOOM_PUBLIC_ONLY_ROLES`): when the school has AI-helper
settings a learner may ask with `scope: public` only (`school` and `internal_figbloom` are 403, audited `ai.bloom.denied`);
when it has none, everything is 403. Nothing was changed. What it does not do that Supabase's `ai-assist` does is in
finding student-6.

## Endpoint list per student page (what the web will call)

`{t}` is the school, `{l}` the learner id from `GET /me/learner`.

| Page | Endpoints | Covered? |
|---|---|---|
| `student` (Today) | `GET /me/learner`, `GET /me/children/{l}/homework`, `GET /me/children/{l}/timetable`, `GET /communications/announcements/inbox` | Mostly. Needs: a hand-in / done state (none in the API), the live-class banner and "Join" (C13, not built) |
| `student/timetable` | `GET /me/children/{l}/timetable` | K-12 yes (published only, teacher names). Higher-education learners: no section timetable read (student-10) |
| `student/work` | `GET /me/children/{l}/homework` | Reads yes. Needs: "mark as handed in" and the submission file (no write, files wait on A5), the teacher's attachments (A5), the teacher name and hand-in method (as parent-5) |
| `student/materials` | `GET /me/children/{l}/materials` | Metadata yes; opening the file waits on A5 |
| `student/exams` (+ sitting) | `GET /me/learner/online-exams`, `POST /online-exam-papers/{p}/attempts`, `GET /me/learner/online-exam-attempts/{a}`, `PUT .../answers`, `POST /online-exam-attempts/{a}/submit` | Partly: objective (MCQ / true-false) online papers. Needs: windows, time limit and deadline, attempt limits and resits, excusals, released results and review, read-mode text and PDF papers (student-4) |
| `student/results` | `GET /me/children/{l}/results`, `GET /me/children/{l}/report-cards` | K-12 marks, class means (3+ marks), CBE results, report-card summary yes. Needs: progress over time, missed/excused papers, report-card PDF (per class only), higher-education course results (student-10) |
| `student/study-helper` | `GET /ai/status`, `POST /ai/query` (`scope: public`) | Partly: no opt-in check and no exam lockout (student-6) |
| `student/activities` | `GET /me/children/{l}/activities` | Clubs and teams yes; fixtures and events no (as parent-5) |
| `student/notices` | `GET /communications/announcements/inbox`, `POST /communications/announcements/{id}/read` | Yes; attachments wait on A5; no unread counts |
| `student/chats` | `GET /me/chat-contacts`, `GET/POST /chat/conversations`, `GET/POST /chat/conversations/{c}/messages`, `POST .../read` | Yes, by decision 3 (which differs from Supabase, student-1); no files, calls or unread counts |
| `student/items` | `GET /me/children/{l}/items` | Yes |
| `student/fees` | `GET /me/children/{l}/fees`, `POST /finance/mpesa/prompts`, `POST /finance/proofs` (+ `/storage/objects` for the file), `GET /finance/invoices/{id}/pdf` | Yes for balance, lines, charges, receipts, proofs and paying. Needs: "how to pay" details (parent-3), receipt signatures (C12), the current term (parent-4) |

The office's People page uses the four `.../learners/{l}/student-account` endpoints.

## Tests (negative first)

`test/student.accounts.test.ts`, through the real `figbloom_app` login:

- making a login: a plain teacher, a parent, an organisation administrator and another school's administrator get 403 on
  all four office endpoints and nothing is made; a school administrator and a People-area staff member may; the one-time
  password is in the create answer once (`no-store`) and never in a status read, a second create (409), an audit detail,
  a log line or the database; another school's learner and a random id 404, an archived learner 409; six concurrent
  creates for one learner give one account; concurrent creates for five learners give five distinct login ids;
- signing in: wrong password and the wrong school 401; with the one-time password everything but the password change is
  403; after the change the learner reads their own record and the old password fails; idle timeout 1800 s (parents 1800,
  teachers 900), lifetime at most 8 h; MFA not required even with every configurable role listed; `MFA_REQUIRED_ROLES`
  with `student` refused at startup;
- own reads: each of the nine shared reads 200 with the learner's data only (no draft marks, no voided charges, no
  unpublished timetable, no classmate); a classmate, another class, another school's learner and a random id 404 (audited),
  another school's path 403; the parent-only paths and every staff path tried (learners, staff, guardians, classes,
  assessments, class memberships, finance invoices, teaching, online exam papers, the office endpoints) 403; a teacher,
  an administrator, a parent and People staff 403 on the learner-only paths; a parent's family branch never reaches a
  learner who is not their child (404);
- paying: proof (`learner`), PDF and prompt for the own invoice; a classmate's invoice, a missing invoice and a classmate's
  AI opt-in 403 with nothing stored;
- notices: class and form-level reach exactly the learners in them;
- chat: contacts are the administrators and the class's teacher only; a learner may start with them and with nobody else
  (another teacher, People staff, a classmate, a parent); a teacher of the class may start with the learner, another
  teacher, a parent, People staff and a classmate may not;
- exams: an unpublished paper does not exist for a learner; only staff with academics write may publish; another class's
  paper and another learner's id 404, a paper without questions 409, a second start 409; a classmate cannot read, save or
  submit the attempt (404); a score 403; the answers are auto-marked (`marked_by` null) and neither the key nor the mark is
  ever in a learner's answer;
- lifecycle: a revoke (needs a recent password; a teacher 403) ends sessions and the login id; an archived learner 404 and
  closes chat; an archived membership 403 and revokes the link for good; a disabled account 401 (and a reset leaves it
  disabled); a reset by People staff gives a new password once, ends the old session and forces the change again.

`test/rbac.matrix.test.ts` now has a `student_A` principal (a student membership with no learner link): every
permission-gated operation is allowed exactly when the role catalogue grants it, so every staff and administrator
operation is a 403 for a learner. The shared reads, chat contacts and the two attempt endpoints are `ANY_OF` entries.

Also updated: the function inventory (`securityDefiner.test.ts`: six definers and one trigger function; the SECURITY
DEFINER trigger count is 18), the RLS catalogue (`docs/RLS-CATALOGUE.md`, `stage910.rlsCatalogue`, `fig1605`), the RBAC
matrix, the route-sweep body fixture for revoke, OpenAPI (new operations and schemas, `x-figbloom-permissions` on the
shared ones) and `schema.d.ts`.

## Findings (numbered `student-1` ... so no other area shares a number)

student-1. **Chat differs from Supabase.** On Supabase a learner could chat only with their own guardians
    (`chat_pair_allowed`); the owner's decision 3 (class teachers and the office) replaces that, so learner-to-guardian chat
    is refused on the API. Owner question: should a learner also reach their own guardians?
student-2. **"The school office" for chat is the school administrators** (`school_admin` members), as for parents. A
    People-area teacher is reachable only as a class teacher; a People-area member with role `staff` is not reachable.
    Owner question: should office staff (role `staff`) count as "the office" for learners?
student-3. **Who makes logins differs slightly from `provision-student`.** Supabase also let an organisation administrator
    of the school's organisation do it. The API allows super administrators, school administrators and People-area
    teachers/staff; organisation administrators are refused (area.people is no longer delegable). Owner question.
student-4. **The API's online exam model is minimal.** No window or time limit (so no deadline for the sitting page's
    timer), no attempt limit (a learner is held to one attempt here; resits are not built), no "results released" state
    (so a learner never sees a score or a review), no excusals, no read-mode text or PDF paper, no unpublish. The Supabase
    ExamSitting page needs most of these.
student-5. **Nobody can read other people's chats on the API.** The screens tell learners that the school's administrators
    can read every chat; there is no administrator read of conversations they are not in, for any role. Either the screen
    text changes or an audited oversight read is built (an owner decision).
student-6. **The AI study helper has no learner rules.** `/ai/query` gives a learner public scope whenever the school has
    AI-helper settings; it does not check the learner's opt-in (Supabase `ai_helper_allowed`) or refuse while an exam is
    open (Supabase answers 423). Both are worth adding before the study helper moves; owner decision whether the opt-in
    gates learners.
student-7. **At most 9,999 learner logins per school, ever.** `school_memberships.login_id` must match `^[A-Z]{2}-[0-9]{4}$`
    and numbers are never reused, so a large school (or many re-issued logins) gets 409 "used every student login number".
    Widening the format is a separate migration.
student-8. **A lost create answer cannot be replayed** (on purpose: the password is never repeated). The office resets the
    password instead; the status read shows that the login exists.
student-9. **An archived learner keeps a live (but useless) login.** Every read is 404 and chat closes while the learner is
    archived; restoring the learner brings the login back. Revoke is the explicit end. (A guardian link is not revoked by
    archiving the learner either.)
student-10. **Reads a learner page needs that no API read covers:** a hand-in / done state and submission files, files of
    homework, materials and notices (A5), the live-class banner (C13), a higher-education learner's section timetable and
    course results, progress over time, missed/excused papers, report-card PDF, activity fixtures and events, unread
    counts, "how to pay" (parent-3), the current term (parent-4).
student-11. **Teachers have no list of their learners to chat with.** `/chat/contacts` lists staff only (unchanged), so a
    teacher can start a chat with a learner only by user id, or answer one the learner started.
student-12. **The school-audit PR (#403) pins every audit event type.** Its classification fixture will need
    `student.account.created`, `student.account.password_reset`, `student.account.revoked`, `student.learner.denied` and
    `academics.online_exam.published` when the two meet.
student-13. **The payer refusal still says "as a guardian"** (`PAYER_LINK_MISSING`) for a learner too; the message is
    shared on purpose (one answer for every cause) but reads oddly to a learner.
student-14. **The notices inbox returns each notice's raw `audience`.** For a `people` notice that is the list of every
    recipient's user id, so a learner (like a parent or a teacher today) can see who else a notice went to. Not new and not
    learner-specific; trimming `audience` from the inbox answer would close it.
