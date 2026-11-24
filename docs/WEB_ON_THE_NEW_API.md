# The web app on the new API (FIG-1890: sign-in, school setup, people)

Written 2026-11-23. The first steps of moving the web app from Supabase to `apps/api`: the client, the switch, sign-in,
the school-setup screens (School settings, Classes, Subjects) and the People page (Students & staff). Everything else in
the web app still reads Supabase and is **not in an API build**.

## What a build is

A build talks to **one** backend, chosen when it is built:

| Setting | Meaning |
|---|---|
| `VITE_BACKEND` | `api` for the new API. Anything else, or nothing, is Supabase (the app as it is today). |
| `VITE_API_URL` | The API's address, e.g. `https://api.example.com`. Required when `VITE_BACKEND=api`. |

The two have separate accounts, so they are never mixed in one build. A Supabase build is unchanged by this work.

An API build runs `apps/web/src/api/ApiApp.tsx`, not `App.tsx`. Every screen in `App.tsx` still calls the database
directly, so on an API build they would fail one by one. `ApiApp` has only what runs on the API today, and each area
is added to it (or moved back into `App.tsx`) as it is ported.

## What works on an API build

- Sign in with **email and password**.
- A password an admin handed out is changed first (`must_change_password`).
- **Two-step verification**: set up (key, recovery codes shown once, first code) and answer (code or recovery code).
  The API requires it for school admins, org admins, super admins and anyone holding the Fees area.
- A kept session survives a reload; a sign-out, or a session the server ended, signs every tab out.
- The admin console shell (the same menu and page gate as the Supabase app) with the pages below. A person with no admin
  console (a parent, a teacher with no admin areas) gets a plain page showing who is signed in, their school, and a
  "check the connection" button.
- **School settings**: start a term (the year is made if it is not there), the school's name, county and MOE registration,
  and its accent colour.
- **Classes**: list (the current year's), add one or several, and who the class teacher is (chosen when the class is made).
- **Subjects**: list, add one or several (a code and a name).
- **Subjects in a class**: name the teacher of a subject in a class.
- **Students & staff** (People):
  - **Learners:** the roster (search, class filter, pages); add a learner, with a class or "No class yet"; change a
    learner's details and move them to another class; archive and restore, with an Archived view.
  - **Guardians:** each learner's guardians, and an "Add a guardian" contact form.
  - **Import:** the CSV import of learners.
  - **Staff:** list, add, change details, archive and restore. Staff on the API are directory records, so adding one
    makes no sign-in.
- **Announcements**: compose and send (or save as draft) in-app and push announcements to the whole school, a role, a year group, or a class, and view recently sent notices.
- **Fees** (office side): view term collection stats, largest outstanding balances and overpayments; create, edit and archive
  term fee items; run term billing; search payable invoices and record payments (cash, M-Pesa, bank, cheque); review, confirm
  or reject submitted payment proofs.
- **Leave** (`admin/leave` and `teacher/leave`): teachers submit leave requests (dates and reason), view their history, and
  withdraw pending requests; school admins and Leave-area holders review pending requests, approve or reject them with a note
  (sending an in-app notice to the teacher), and view past requests.
- **Inventory** (`admin/inventory`): view the register of active items with out/available counts, add stock or tracked-asset
  items, issue copies to learners, user-linked staff, or a whole class, view Out now and Overdue issues, record returns
  (returned, damaged, or lost), write off items with nothing out, and export CSV.
- Platform and organization accounts are told their console is not on the new system yet, and are signed out.

## What does not, and why

| Not there | Why |
|---|---|
| Sign in with a school ID | `POST /v1/auth/login/login-id` takes the school's UUID and there is no public school search or login-ID lookup (FIG-1872) |
| Password reset by email, accept-invitation page | No email provider is set up (FIG-1872); the reset and invitation tokens are only returned in API responses |
| The re-enter-password prompt (`reauth_required`) | The client supports it (`setApiAuthHandlers`), but no screen on the API build does a sensitive action yet. The two-step set-up asks for the password inline |
| A QR code for two-step set-up | The key is shown for typing in, with an `otpauth://` link for a phone. A QR needs a small library; left for a decision |
| Every other screen | Each area moves over on its own, after its shared module is on the API (FIG-1889 onwards) |

### Setup screens: what the API cannot do yet

The setup screens are the Supabase app's own screens. Each control the API has no endpoint for is hidden on an API build
(`packages/shared/src/capabilities.ts`, `setupCapabilities()`), and the shared function behind it throws `NotOnApiError`.
Each flag is one missing endpoint; when the API gains it, the flag turns on and the function gets its API branch.

| Hidden on the API build | Missing in the API |
|---|---|
| Change a class's teacher after it is made | no `PATCH` on a class (a teacher is chosen at creation) |
| Delete a class | no delete or archive for a class |
| A class's room | the class has no room field |
| Promote a class | no promotion, no learner move or archive in bulk (class memberships are assigned one at a time) |
| A class's timetable | timetable slots can be made and listed, not edited; not ported yet |
| Edit a subject; a subject's level, year range and core flag; adding from the KICD catalogue | a subject is a code and a name, and cannot be updated |
| Change or clear a subject's teacher in a class | a teaching assignment can be made, not changed or removed |
| Fee structure and payment methods steps; the school crest; the AI settings | not in the API (fees are their own area) or need storage |

### Announcements screen: what the API cannot do yet

`announcementsCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet:

| Hidden on the API build | Missing in the API |
|---|---|
| Per-audience recipient headcounts & SMS cost preview | no account-reach count endpoint yet (family account links wait on A1 / `FIG-1869`) |
| File attachments | file storage waits on A5 (`FIG-1873`) |
| Guardian signature requests & signature status | signatures wait on C12 (`FIG-1880`) |
| AI writing helper | calls a Supabase edge function |
| SMS and email channel checkboxes | SMS/email delivery waits on B8 (`FIG-1876`); `in_app` and `push` work (`publish` enqueues `announcement.push` on the server) |

### Leave screens: what the API cannot do yet

`leaveCapabilities()` in `packages/shared/src/capabilities.ts` handles the differences between Supabase and `apps/api`:

| Hidden or different on the API build | Missing or different in the API |
|---|---|
| Figbloom HR leave handoff (`admin/leave-to-approve` and HR-backed applications) | HR handoff is not on the API yet (C13); `teacher/leave` uses the school's own leave form |
| Submitting a leave request with no reason | `POST /v1/tenants/{tenantId}/leave-requests` requires a reason of at least 3 characters |

How the model is mapped (`packages/shared/src/api/leaveApi.ts`):

- The API calls a rejected request `declined` and names the dates `start_on`/`end_on`; the client maps them to `rejected` and
  `starts_on`/`ends_on`.
- `GET /v1/tenants/{tenantId}/leave-requests` returns every request in the school when the caller holds `resource.leave.read`,
  so `fetchMyLeaveRequests` filters by `staff_user_id` so teachers who also hold the Leave area see only their own requests.
- `fetchAllLeaveRequests` resolves teacher names from `GET /v1/tenants/{tenantId}/staff` (all staff, active or archived) and
  falls back to `"Unknown teacher"` on 403 or when a user has no linked staff record.
- `decideLeaveRequest` posts the review and then creates and publishes an in-app `user`-audience announcement; if only the
  announcement fails (for example, a Leave-only reviewer without `resource.announcement.write`), the decision stands and the
  screen shows the notice error.
### Inventory screen: what the API cannot do yet

`inventoryCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet:

| Hidden on the API build | Missing in the API |
|---|---|
| Edit an inventory item | no `PATCH /v1/tenants/{tenantId}/inventory/items/{itemId}` endpoint |
| Restore a written-off item ("Put back on the register") | no unretire endpoint, and `GET /inventory/items` returns active items only |
| Purchase date, unit cost, and item notes | not stored on the API's `InventoryItem` schema |
| History tab and Lost counter | `GET /inventory/issues` returns open (`status = 'out'`) issues only |
| Hand-out note when issuing an item | `POST /inventory/issues` has no `note` field (`POST .../close` does) |
| Charge lost or damaged items to fees | waits on closed-issue history and charge-by-issue lookup |
| Teacher's "My items" (`teacher/items`) | `GET /inventory/issues` requires `resource.inventory.read`, which regular teachers do not hold |

How the model is mapped (`packages/shared/src/api/inventoryApi.ts`):

- `POST /inventory/issues` requires `holder_user_id` to be an active school membership `user_id`, so the staff picker lists
  only staff directory records linked to a user account.
- Issuing to a whole class verifies that enough copies are on the shelf for every active learner in the class who does not
  already hold one, then sends individual `POST /inventory/issues` calls 4 at a time (`settlePool`).

Where the model differs it is mapped in `packages/shared/src/api/setupApi.ts`: a class belongs to an academic year (the screen
shows the current year's classes, and a class needs a current year, which "Start a term" makes); a teacher is a staff record,
so every teacher id on an API build is a staff id; a term "starts" by finding or making the year, making the term, and
setting both current; the API has no batch for classes or subjects, so "bulk add" sends them one at a time and says how
many were made if one is refused.

### People: what the API cannot do yet

The People page (Students & staff) works the same way: `peopleCapabilities()` hides what the API has no endpoint for, and
the shared function behind it throws `NotOnApiError`.

| Hidden on the API build | Missing in the API |
|---|---|
| Delete a learner | no delete: learners are archived and restored |
| Taking a learner out of their class ("Unassigned") for a learner who has one | a class a learner leaves cannot be given back that year (finding 7) |
| Change class for several learners at once; Export | no bulk move; exports are async jobs, not ported |
| The roster's Guardian, Login and Fees columns | the Guardian column shows no real data on either build yet; learners have no sign-in; fees are their own area, not ported |
| Learner sign-ins: create logins, password resets | learners have no accounts on the API |
| Invite guardians, send their sign-in again | guardian invitations exist, but families can read nothing yet (FIG-1869) |
| Home address and bus, health, documents, early sign-outs, sports and activities, photos, bio data and bio-data requests | not in the API's learner record, or not ported yet |
| Staff accounts: admin access, password reset, Remove staff, a teacher's subjects, calls | staff are directory records (a name, a role, contact details), not accounts; accounts come from invitations, not ported |
| The import's home and health columns | the API's import has five columns: admission_no, full_name, gender, date_of_birth, boarding |

Shown only on the API build, because the API has them and Supabase does not: archive and restore for staff (with an
Archived view), an "Add a guardian" contact form, and adding a learner with no class yet.

How the model is mapped (`packages/shared/src/api/peopleApi.ts`):

- A learner's class is a class membership, one active per learner per academic year. The roster shows the membership in a
  class of the current year. A move ends that membership and makes the new one.
- Archiving a learner leaves their membership active, so counts use only active learners' memberships.
- There is no bulk write. Archive, restore and placing imported learners go one at a time, four at once, and a failure says
  how many were done.
- The import: the page checks the file as before and leaves out the rows that need fixing. The API then checks the rest
  (1,000 rows per call); if it refuses any row, nothing is imported and the message names the line in the person's own
  file. Then the learners are made, and each is placed in the class the file named.
- What a person may read depends on their areas. A teacher holding only People reads and adds learners and staff, but cannot
  read classes, memberships or guardians, and cannot import. Those parts show "none" instead of failing the page, and a
  change to a learner's name does not touch their class.

## Where the code is

- `packages/shared/src/api/`: `schema.d.ts` (generated), `client.ts` (the one way to call the API), `errors.ts`,
  `tokenStore.ts`, `paging.ts`, `authApi.ts` (login, MFA, password), `sessionApi.ts` (who is signed in and their school),
  `sessionEvents.ts`, `signInFlow.ts` (what comes next after a password).
- `packages/shared/src/api/setupApi.ts` and `peopleApi.ts`: the API side of `schoolSetup.ts`, and of `peopleRoster.ts`,
  `learners.ts` and the guardian list in `learnerBio.ts`. `pool.ts` runs writes a few at a time.
- `packages/shared/src/api/attendanceApi.ts`: the API side of `attendanceSession.ts`, `earlySignOut.ts`, and the attendance
  register reads/writes in `teacherData.ts` (writing registers one learner per request, max 4 in flight until A4 bulk write).
- `packages/shared/src/api/leaveApi.ts`: the API side of `leave.ts` (`admin/leave` and `teacher/leave`), plus the API short-circuit in `hrLeave.ts`.
- `packages/shared/src/api/inventoryApi.ts`: the API side of `inventory.ts` (`admin/inventory`), plus API guards in `feeCharges.ts`.
- `packages/shared/src/capabilities.ts`: what each area can do on this build's backend.
- `packages/shared/src/backend.ts`: `initBackend`, `onApi()`.
- `packages/shared/src/session.ts`: every function branches on `onApi()`, so the screens that use `useSession`
  need no change when their area is ported.
- `apps/web/src/lib/client.ts` starts the right backend; `apiTokenStore.ts` keeps the token in `localStorage`.
- `apps/web/src/api/`: the screens of an API build.

`packages/shared/src/api/schema.d.ts` is generated from `apps/api/openapi/openapi.yaml`:

```
npm run api:types          # regenerate it
npm run api:types:check    # CI: fails if the committed file is out of date
```

So a path that is not in the API's contract does not compile, and a contract change comes with the new file.

## Running it locally

1. The API (see `apps/api/README.md`): a Postgres, `migrate`, the `figbloom_app` login, a session key
   (`apps/api/scripts/session-hmac.mjs`), and the first super administrator (`apps/api/scripts/bootstrap-admin.mjs`).
   Start it with `CORS_ALLOWED_ORIGINS` set to the web's exact origin, e.g. `http://localhost:5173`.
2. Make a school and its admin through the API (`POST /v1/platform/schools`, then accept the invitation).
   Note that `organization_name` is required in practice (see below).
3. The web: `VITE_BACKEND=api VITE_API_URL=http://127.0.0.1:4199 npm run dev`.

The API enforces two-step verification outside `MFA_ENFORCEMENT=off`. A code is accepted once, so a second sign-in
inside the same 30 seconds needs the next code.

## Things found in the API while doing this (for Ancel)

1. `POST /v1/platform/schools` says a single-school organization is made "unless `organization_id` is given", but the
   database function refuses without `organization_name` (a 400 "Invalid request" with no details).
2. `/v1/auth/me` memberships carry no school slug or name, and there is no lookup by slug, so the client asks
   `GET /v1/tenants/{id}` for each membership to find the school at `/s/<slug>`. Adding `slug` and `name` to each
   membership would remove those calls.
3. Several answers have no `required` list in the OpenAPI file (`Me`, `TenantRecord`), and the MFA answers are
   `{ [key: string]: unknown }`. The client checks what it reads and types the MFA answers by hand from
   `apps/api/src/http/routes/auth.ts`.
4. A POST with `Content-Type: application/json` and no body is a 400. The client only sends the header with a body.
5. A teacher holding only the Academics area may read classes and subjects but not the staff list (`resource.staff.read`),
   so they see no class-teacher names and have no teachers to pick. A teacher list readable with Academics, or the
   teacher's name in the class record, would fix it.
6. Edit and remove for classes, subjects and teaching assignments, and a bulk create for classes and subjects, are the
   gaps the setup screens hit (the table above).
7. **A learner can never go back into a class they left that year.** The unique index
   `class_memberships_learner_class_year_uidx` (migration 029) is on `(tenant_id, learner_id, class_id, academic_year_id)`
   with no `WHERE active`, so an ended membership still blocks it. The 409 says "Learner already has an active class
   membership for this academic year", which is not what happened. There is also no endpoint to undo an ended membership
   or to move a learner in one call. The web refuses such a move before changing anything, and does not offer
   "Unassigned" for a learner who has a class. A partial index (`WHERE active`), or a move endpoint, would fix it.
8. **Archiving a learner leaves their class membership active**, so anything that counts memberships also counts learners
   who have left. The Classes page did; the web now counts only active learners' memberships. Ending the membership on
   archive (and giving it back on restore), or a count endpoint, would be simpler for every client.
9. **A teacher holding only People** can add learners, but cannot read classes or memberships, place a learner in a class
   (that needs Academics), read guardians (the administrator's, or a per-person grant) or import (`resource.import.write`).
   A secretary admitting learners therefore cannot put them in a class.
10. **The learner import** has no class column and reads at most 1,000 rows. The web sends files in batches of 1,000 and
    places each learner afterwards, one call each. A class column would make the import one atomic step.
11. **Validation answers** put the real problem in `details`; the message is a generic list of the required fields
    ("admission_no, full_name and gender (male|female) are required; ..."). The web turns `details` into words ("Phone is
    not in the right format."). The import's own errors use the column names ("date_of_birth is not a valid date").
12. **Leave requests carry no staff name.** `GET /v1/tenants/{tenantId}/leave-requests` returns `staff_user_id` without the
    requester's name. The web resolves names from `GET /v1/tenants/{tenantId}/staff`, which fails with 403 for a teacher holding
    only the Leave area (not People) and misses any user without a linked staff record (falling back to `"Unknown teacher"`).
    Including `staff_name` on `LeaveRequest` would remove the extra call and fix Leave-only reviewers.
13. **Inventory read and lifecycle gaps.** `GET /v1/tenants/{tenantId}/inventory/issues` returns open (`status = 'out'`) issues
    only and requires `resource.inventory.read` (so regular teachers get 403 on `teacher/items`, and admins cannot view closed
    issue history or Lost totals). Items also lack `PATCH` (edit), unretire, and `purchased_on`/`unit_cost_cents`/`notes`.

## Family reads (API side of A1, FIG-1869)

The API now has the reads the parent pages need (PR #359; design and rules in `apps/api/docs/FAMILY-READS.md`). No parent
or student page is ported yet: the web slices come after this merges.

- `GET /v1/tenants/{t}/me/children`: the parent's own children in that school, with each child's current class.
- Per child, `GET /v1/tenants/{t}/me/children/{learnerId}/…`: `attendance`, `results`, `report-cards`, `homework`,
  `materials`, `timetable`, `fees`, `activities`, `items`, `health`. Any learner who is not the caller's child is a 404.
- `GET /v1/tenants/{t}/me/chat-contacts`: who a parent may start a chat with.
- Bus: the existing `/me/transport`.
- Paying (M-Pesa prompt, invoice PDF, payment proof, AI-helper opt-in) now works for a parent whose account link reaches
  the learner. Class and form-level notices now reach the parents of children in them, and a parent may chat with their
  child's teachers.
- All of them need permission `resource.family.read`, which only parents hold.

Things found while doing it:

14. **Learners have no sign-in on the API** (A4). There is no link from an account to a learner record and no flow that
    makes a `student` membership. It needs owner decisions first (who makes the login, how a child without e-mail gets
    a password, session length, MFA, chat); see "Student accounts" in `apps/api/docs/FAMILY-READS.md`. The student
    pages stay on Supabase until then.
15. **Sick-bay notices to guardians are never written.** `medical_notices` exists and parents could read it, but the
    sick-bay module still reports `guardian_notices_available: false` and emits none. The family health read shows the
    visits instead.
16. **Push for class and form-level announcements counts nobody.** The worker's eligibility count covers only
    whole-school, role, user and people audiences (migration 063), for staff and parents alike.

## Chats, notices and messages

`admin/chats`, `teacher/chats`, `teacher/notices` and `teacher/messages` run on an API build. The screens are the Supabase
app's own; the shared functions behind them (`chat.ts`, the notice functions in `teacherData.ts` and `otherStaff.ts`,
`subscribeAnnouncements` in `parentData.ts`) branch on `onApi()` into `api/chatApi.ts`, `api/noticesApi.ts`,
`api/inboxApi.ts` and `api/directoryApi.ts`. `staff/chats` and `staff/notices` use the same functions: when the staff shell
exists it needs only the two routes.

| Page | On the API build |
|---|---|
| `admin/chats` | "My chats" only: list, start a chat, read and send text. The "All school chats" and "Calls" tabs are hidden |
| `teacher/chats` | The same list and thread. A plain teacher cannot see names or start a chat (finding 29) |
| `teacher/notices` | The inbox, newest first, with the notice's text. No unread marks, attachments or signatures |
| `teacher/messages` | Opens. A teacher without the Communication area gets a message saying why instead of a composer (finding 33) |

### Polling instead of realtime

The API has no push channel, so `packages/shared/src/api/poll.ts` asks again every few seconds. The header of that file
is its documentation. In short: `startPolling`, `pollNewItems` (the shape of `subscribeChatMessages` and the other
`subscribe*` helpers that deliver rows) and `pollChanges` (the shape of `subscribeAnnouncements`); one request at a time;
paused while the tab is hidden and after 10 minutes with no input, so a tab left open does not keep the API's idle timer
alive; one catch-up request when the person comes back; a longer wait after failures. An open thread asks every 4.5 s, the
chat list every 10 s, the notices inbox every 30 s. The fleet, visitors and parent slices use the same file.

### What is hidden on this build, and why

`chatCapabilities()` and `noticesCapabilities()` in `packages/shared/src/capabilities.ts`; the shared function behind each
control throws `NotOnApiError`.

| Hidden | Missing in the API |
|---|---|
| Sending and opening files in a chat | chat messages are text only; files wait on storage (A5, FIG-1873) |
| Voice and video calls, and the school's call log | not in the contract (C13) |
| "All school chats" (the office reading every chat) and the line "The school's administrators can read this chat" | nobody can read a chat they are not in, the office included (finding 30) |
| Unread counts: the menu badge, a bold name, the count on a chat | the API does not say what a person has read (finding 29) |
| Unread dots and the menu badge on notices | the inbox has no read state (finding 32) |
| Notice attachments, "Waiting for your signature", the AI writing helper in Messages | storage (A5), signatures (C12), an edge function; the same as the Announcements page |
| A list of people to start a chat with, for a person who may not read the staff list | there is no contacts endpoint (finding 29) |

### How the model is mapped

- A chat has `peer_user_id` and `last_message_at`, nothing else. The other person's name comes from the staff list
  (`GET /staff`, which needs `resource.staff.read`: a school admin and the People area have it, a plain teacher does not),
  kept for a minute per school. Without it the chat shows "Someone at the school". Parents and learners cannot be named:
  guardian contacts carry no account id.
- The chat list's preview is the newest message of each of the 30 latest chats, one small request each.
- "Start a chat" offers staff who have an account (`userId` on the staff record), active, other than the person. Who may
  talk to whom is the server's `may_talk`: staff with staff, a parent with the school office. A refused pair is a 403 on
  the first message, shown as the server's own words.
- A thread is the newest 1,000 messages. A poll asks for the newest 50 and merges by id.
- The notices inbox is `GET /communications/announcements/inbox`: what reaches the person (whole school, their role, them by
  name, the classes they teach) and what they wrote. That is more than the Supabase list, which showed only whole-school
  notices and ones sent to the teacher by name. "From" is "You" for their own, a teacher's name when the staff list can be
  read, else "School office".
- "Sent by you" is the person's own published notices, read from the inbox (a teacher cannot read the composer's list, and
  drafts are not in the inbox). Opening a notice calls `POST .../read` once, for when the inbox says what is read.
- A class message is an in-app announcement with audience `{ kind: "class", class_id, recipients }`, created and published.
  `recipients` is stored but the server's reach rule ignores it. Parents and learners are not reached until their accounts
  are linked (FIG-1869): only the teachers of that class see it. The composer says so.
- A teacher who holds an admin area lands in the admin console on this build, which has no console switch yet. Their
  `teacher/chats`, `teacher/notices` and `teacher/messages` are reachable by address only, as `teacher/leave` is.

### Things found in the API while doing this (for the owner)

29. **The chat list is only ids.** `GET /chat/conversations` answers `peer_user_id` and `last_message_at`: no name, no role,
    no last message, no unread count. There is also no "people I may chat with" list, no unread count and no single-chat
    read. A plain teacher cannot read `/staff`, so every chat is "Someone at the school" and they cannot start one. Add to
    each conversation `peer { user_id, full_name, role }`, `last_message { body, sender_id, created_at }` and
    `unread_count` (from `conversation_members.last_read_at`, which exists and is never returned), plus
    `GET /chat/contacts` (the people `may_talk` allows, with a name and a role) and `GET /chat/unread-count`.
30. **No oversight read.** `listMessages` needs membership of the chat, so the office cannot read other people's chats, and
    there is no school-wide list. The Supabase app tells families and teachers "The school's administrators can read this
    chat", and the Communication area is described as reading the school's chats. That is a product and privacy decision
    first, an endpoint second.
31. **Chat messages come newest first with no `since`**, so a poll re-reads a page. A `since` (or `after`) cursor on
    `GET .../messages` and on the conversation list would make polling cheaper (B7).
32. **The announcements inbox has no read state and no author name.** Items have the composer's shape, with `author_id`
    only. `communications_announcement_reads` is written by `POST .../read` and never returned. Add `read_at` (null when
    unread) and the author's name and role to each inbox item. Class and year-group notices also reach no parent or learner
    until their accounts are linked (FIG-1869), and `recipients` in a class audience is ignored by
    `communications_audience_reaches`.
33. **A teacher cannot send a class message.** `POST /communications/announcements` and `.../publish` need
    `resource.announcement.write`, which only the school admin role and the Communication area hold. The check for a `class`
    audience does not look at who the sender is: anyone with the permission can post to any class. A rule that lets a teacher
    create and publish a `class` announcement for a class they teach (the reach function already knows who teaches what)
    would make the Messages page work for the people it is for. It widens who may write to families, so it is the owner's
    call.
34. **`/notifications` is not announcements.** It lists generic in-app notifications (transport, medication and so on; its
    items are an untyped `object` in the OpenAPI file), and publishing an announcement creates none. The Notices page does
    not use it. A bell or a notification centre would be a new screen the web app does not have.
