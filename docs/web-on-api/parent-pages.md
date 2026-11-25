# Parent pages (parent/*)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Opened from the menu on an API build for a person with a `parent` membership: **Home**, **Fees**, **Results**, **Homework**,
**Learning materials**, **Sports & activities**, **Bus**, **Health**, **Issued items**, **Inbox**, **Chats**, **Account** and
**Bloom study helper** (all 13 parent pages). The pages are registered in `apps/web/src/api/pages/parent.pages.tsx`, under the
`parent` kind (`ParentPageDef` in `pages/types.ts`, `parentPageDefs` and `API_PARENT_PAGES` in `pages/index.ts`). The shell is the
parent's own console, `ApiParent.tsx` (it also holds the Home route), picked by role in `ApiConsole.tsx`. Every per-child read is
`GET /v1/tenants/{id}/me/children...` (`resource.family.read`); the server decides which learners are the caller's own on every call
(`apps/api/docs/FAMILY-READS.md`), so a parent whose link was removed sees "No child linked" on every page and a child of another
family is never reachable. The code is `packages/shared/src/api/parentApi.ts` (children, results, fees, homework, materials,
activities, items, report cards, early sign-outs), `parentHealthApi.ts`, `parentBusApi.ts`, `parentPayApi.ts`, `accountApi.ts` and
`aiApi.ts`.

## What works

- **Children and the switcher:** the parent's children, the chosen one in the address (`?child=`), a parent with two children, and a
  child with no class (pages open with their empty states).
- **Home:** fee balance and "Pay with M-Pesa", attendance this term, the mean grade (or the CBE learning-area level), the absence
  notice, and today's early sign-out (never the collector's ID or phone).
- **Fees (reads):** balance, billed, paid, what the invoice is made of, charges, receipts, and the proofs already sent with their
  status and reason. **Pay with M-Pesa** asks `POST /finance/mpesa/prompts` (allowed for a linked parent) and reads the payment back from
  the child's own fees until the provider says it settled; if M-Pesa is not set up for the school the dialog says so.
- **Results:** published exams by title and term, each mark with the school's own grade, the class mean (the server gives one only for
  3 or more marks) and "40 / 50" for a paper not marked out of 100; CBE strand results; the **published report cards** as a summary.
- **Homework, learning materials, sports & activities, issued items:** what the API lists for the child (homework due in the last
  three weeks or later; materials by subject; clubs with role and patrons; items out and returned).
- **Health:** sick-bay visits, the medicines the school runs and their doses, the health details on file, and the medicines waiting
  for a guardian's consent: **I agree**, **No, do not give it** and **Withdraw my OK** use the existing consent endpoint.
- **Bus:** each child's route, own stop, bus plate, driver's first name, what the running trip says about them, and the bus's position
  while the trip runs. Read again every 15 seconds while the page is open (a plain timer: the API has no live feed).
- **Inbox (`parent/inbox`) and "From the school" on Home:** published school and class announcements addressed to the parent from
  `GET /v1/tenants/{tenantId}/communications/announcements/inbox`, reloaded on changes via polling (`subscribeAnnouncements`), with
  read acknowledgement sent via `POST .../read` when a message is opened.
- **Chats (`parent/chats`):** 1-on-1 text chats with school administrators and the parent's children's teachers from
  `GET /v1/tenants/{tenantId}/me/chat-contacts` and `/v1/tenants/{tenantId}/chat/conversations`, with 4–10 second polling via
  `subscribeChatMessages`.
- **Account (`parent/settings`):** the shared `AccountSections` view (read-only profile details from `GET /v1/auth/me`, password
  change via `POST /v1/auth/password/change`, two-step verification status from `/v1/auth/mfa/status`, and all five parent
  notification switches saved via `GET`/`PATCH /v1/me/notification-preferences`), the avatar menu's "My account" shortcut, and the
  linked-children count for this school.
- **Bloom study helper (`parent/study-helper`):** reads the school's study-helper state, access mode, current term and the selected
  child's opt-in choice from `GET /v1/tenants/{tenantId}/me/children/{learnerId}/ai-helper`, and turns the study helper on or off for
  the current term via `PUT /v1/tenants/{tenantId}/finance/ai-helper/optins`.

## What is hidden on the API build, and why (`parentCapabilities()` in `capabilities.ts`)

| Hidden | Why |
|---|---|
| Send a proof of payment | its file needs object storage, which is not set up (A5, FIG-1873); the proofs already on the invoice are listed |
| "How to pay" (paybill, till, bank) | a parent cannot read the school profile (403), and nothing else carries the school's payment details (finding `parent-3`) |
| Invoice and receipt signatures; documents to sign on Home | signatures wait on C12 (FIG-1880) |
| Mark homework done; "overdue"; worksheets and videos | the API records no hand-in or done state, and files wait on A5. The page lists work "coming up" and "past its due date" |
| Open a material's file | files wait on A5: the title, subject, date and the teacher's note are shown, with a note saying so |
| Report card PDF | the family read gives the child's own summary, not the subject rows; the PDF is made per class |
| Online exam papers and tests; missed or excused papers | not in the family read |
| Progress over time | no history read for a family |
| Fixtures, trips and awards under activities | the family read has clubs and teams only |
| Bio data, health details and home address (Home); live-class banner; call the school | not in the API (C13 for calls and online classes); a parent cannot change health details on the API yet |
| Ask the nurse to give a medicine; notices from the sick bay | parents have no such write, and the sick bay never writes notices (finding 15) |
| Today's bus updates and the notify button; arrival time on the map | the API sends no stop coordinates and no route line (finding `parent-2`); bus notifications are not ported here |
| Inbox attachments, signature requests, and unread dots/badges | files wait on A5, signatures on C12, and `/communications/announcements/inbox` does not report per-recipient read state |
| Chat file attachments, voice/video calls, unread badges, and chatting with learners | files wait on A5, calls on C13, unread counts are not reported, and learners have no accounts on the API yet |
| Editing own name, phone or photo, and resetting a child's learner password (`parent/settings`) | `PATCH /v1/auth/me` and file storage (A5) do not exist yet, and learners have no sign-in accounts on the API yet (A4) |
| Study helper monthly question counts and co-guardian names (`parent/study-helper`) | per-learner AI usage is not tracked yet, and the family read omits co-guardian user IDs (`aiCapabilities().studyHelperUsage`) |

## How the model is mapped

- Money is `*_minor`, shown as before. "This term's invoice" is the **newest invoice that is not voided** (finding `parent-4`).
- A mark is turned into a percentage (`score / max_score`), keeping the raw score. An exam is the assessments of one title in one
  term; two terms with the same title are named with the term.
- The child's class has no education level (finding `parent-1`), so it is read from the class name ("Form 2", "Grade 4", "PP1"), then from
  the year (7 to 12 are junior and senior school, 5 and 6 are primary); for years 1 to 4 a child with strand results and no exam marks
  is read as primary, anyone else as an 8-4-4 Form.
- Attendance is the percentage of sessions with a mark that were present or late, leaving out an afternoon absence after an early
  sign-out (the school's own counting mode is not readable by a parent: per session is used).
- A guardian answers a medicine through `POST /health/medications/authorizations/{id}/consent`; the school makes the authorization.
- Study-helper status comes from `GET /me/children/{learnerId}/ai-helper` (`school_on` true when the school has a row in
  `finance_ai_helper_settings`, `current_term` from `academic_terms.is_current`), and turning it on or off sends `current_term.id` to
  `PUT /finance/ai-helper/optins`.

## Checked on a real API (lighter checks)

A school with three parents: one with two children (the switcher, every page above), one whose child has no class, and one whose
link was revoked. Not tried: a real M-Pesa prompt (it needs provider keys; locally the API answers 503 and the dialog says so), CBE
results in a browser (unit tests only), two academic years, and the phone apps.

## Things found in the API while doing this (numbered `parent-1` to `parent-8` so that no other area shares a number)

parent-1. **A child's class carries no education level.** `FamilyChildClass` has `id, name, form_level, stream, academic_year_id`; the
    level picks the grading scheme and whether the child is on the CBE rubric, so the web guesses it from the name and year. Adding
    `education_level` (and `pathway`) to the class in `/me/children` would remove the guess.
parent-2. **`GET /me/transport` is untyped in the OpenAPI file** (`{ [key: string]: unknown }`) and has no coordinates for the child's stop
    and no list of the route's stops, so the family map shows the bus only and cannot say when it will arrive. Typing the answer and
    adding the route's stops (name, order, lat, lng) for the child's own route would bring the map and the arrival time back.
parent-3. **A parent cannot read how to pay.** `GET /school-profile` is a 403 for a parent (and each page load makes that call and is
    audited as a denial), and no other read carries the school's paybill, till or bank details. A family-readable payment-methods
    read, or the details inside `/me/children/{id}/fees`, would show "How to pay" and the offline fallback of the M-Pesa dialog.
parent-4. **There is no "current term" for a parent.** `FamilyTermRef` has `id` and `label` only, so "this term's invoice" is the newest
    invoice that is not voided, and a past term's balance can stand in until the new term is billed. `is_current` on the term (or a
    `current_term` in `/me/children`) would settle it.
parent-5. **The family reads leave out** a homework done state and teacher name, how work is handed in, the school's attendance counting
    mode, missed or excused papers, fixtures and awards for activities, and the route's stops. Each is a hidden control above.
parent-6. **Paying reads the payment back through the child's fees.** A parent may start a prompt but not read `GET /finance/payments/{id}`
    (the office's read), so the web re-reads the whole fees list every 3 seconds for up to 90 seconds. A family read of one payment
    would be one small call.
parent-7. **Parents cannot ask for medicine or hear from the sick bay.** The consent endpoint answers a medicine the school started; the
    old "ask the nurse to give a medicine" has no write, and `medical_notices` is never written (finding 15), so the Health page shows
    visits and doses instead of notices.
parent-8. **Study-helper opt-in write needed a family read.** `PUT /finance/ai-helper/optins` authorizes linked parents only
    (`assertMayPayFor`) and requires `term_id`, whereas `GET /finance/ai-helper/settings`, `GET /finance/ai-helper/optins` and
    `GET /academic-terms` all require staff permissions (403 for parents). Added `GET /me/children/{learnerId}/ai-helper` (`inChild` /
    `resource.family.read`, no migration or grant change) so a parent can read the school's study-helper settings, the current term and
    their own child's choice without exposing co-guardian user IDs.
