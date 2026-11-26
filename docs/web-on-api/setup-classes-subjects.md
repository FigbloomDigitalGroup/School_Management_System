# School setup: classes and subjects

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/classes` (with the Subjects window of each class), `admin/subjects`, and the "Assign class teachers" step of the
setup checklist on `admin/settings`. Capability flags: `setupCapabilities()` in `packages/shared/src/capabilities.ts`. The API
side is `api/setupApi.ts`, behind the functions of `schoolSetup.ts`. The API work is migration 101
([api-gap-fixes.md](api-gap-fixes.md)); this slice is the web side of it. No change to `apps/api`.

## What works on the API build

| Control | Endpoint | Rules the person meets |
|---|---|---|
| Change or clear a class's teacher (Classes list, and the checklist step) | `PATCH /classes/{classId}` with `class_teacher_staff_id` (null clears) | the new teacher must be an active member of staff (400) |
| A class's room: shown, entered when the class is made, edited in the list | `room` on `POST` and `PATCH /classes` and on every class read | up to 64 characters; blank clears it |
| Archive a class (the button the Supabase screens call Delete) | `POST /classes/{classId}/archive` | refused (409) while an active learner is in it; its teaching assignments end; no restore |
| A subject's level, years and core flag: shown, entered when the subject is made | `education_level`, `min_form_level`, `max_form_level`, `is_core` on `POST /subjects` and on every subject read | years 1 to 12, and inside the level's own years when a level is set (400) |
| Edit a subject (name, code, years; on this build also level and core) | `PATCH /subjects/{subjectId}` | a code another subject has (409); an archived subject cannot change (400) |
| Change a subject's teacher in a class | `PATCH /teaching-assignments/{assignmentId}` (same id, so timetable slots keep their link) | the new teacher must be an active member of staff (400) |
| Clear a subject's teacher in a class | `POST /teaching-assignments/{assignmentId}/archive` | none; a new teacher can be named straight away |

All of them need `resource.academics.write`. The error sentences come from the API and reach the person as they are
(for example "The class still has 1 learner. Move them to another class first.").

## What differs from the Supabase screens

- **Archive, not delete.** On the API build the button says "Archive". The confirmation says the class leaves the list, its teachers
  are taken off it, its timetable and history are kept, it cannot be brought back yet, and a class that still has learners cannot be
  archived. The screen also checks the roll first and says how many learners to move; the API's own 409 is the last word. The
  Supabase build keeps "Delete" and its wording (`archives = onApi()` in `Classes.tsx`).
- **Two controls that the Supabase screens never had**, offered on the API build only, each behind its own flag:
  - `editClassRoom`: the Room column is a field you can change in the list (saved on Enter or when you leave it).
  - `editSubjectLevelAndCore`: a subject's row gets a Level select and a Core box next to its name, code and years.

  The Supabase screens showed a class's room but never changed it, and never changed a subject's level or core flag once it was made.
  Both flags are false on Supabase, so that build is unchanged. The shared functions `setClassRoom` and `updateSubject` (with the
  optional `level` and `isCore`) work on both backends; the Supabase paths are tested but no Supabase screen calls them.
- **A class's subject list follows the subject's years**, as on Supabase: a subject whose level or years leave the class out is not
  listed in that class's Subjects window, unless it already has a teacher there (so the teacher can still be changed or cleared).
- The teacher lists hold active teachers only (staff whose classification is "teacher").

## Still hidden on the API build, and why

| Flag | Why |
|---|---|
| `kicdCatalogue` ("Add from KICD") | a subject on the API has no link to a KICD learning area (needs the subject-to-learning-area link and owner decision D6). It was part of `subjectDetails` and is now its own flag, false here. `createSubject` refuses a call that carries a learning area (NotOnApiError) instead of dropping the link. |
| `promoteClass` | no bulk move or promote endpoint (end memberships, place learners in the next year's class) |
| `classTimetable` | the week-grid editor needs edit and remove on timetable slots; the list and "Add a period" window is on (`Timetable.classPeriods`) |
| `feeSetup` | no payment-method fields on the school profile; the fee step stays hidden (so `fetchTermSetup`'s fixed `feeItemsCount` of 0 does not show) |
| `schoolCrest` | needs file storage |
| `aiSettings` | the API has no explicit Bloom on/off setting |

## How the model is mapped

- A write that names no school (a class's teacher or room, a subject's code) goes to the school the tab is in
  (`apiClient().activeTenant()`), as the other API modules do.
- A teaching assignment keeps its id when its teacher changes. Clearing archives it, and a new one can be made straight away.
  The window reads the class's active assignments only.
- `subjectFromApi` now carries the API's level, years and core flag, and `classGroupFromApi` carries the room. Both are used by other
  areas (fees, announcements, attendance, grades, homework, People), which only gain the values.
- Bulk add of classes and subjects still goes one at a time and says how far it got if one is refused. Bulk add now sends each
  subject's years.

## What a person without the Academics area sees

Nothing new needs a per-person check today. `admin/classes` and `admin/subjects` open only for someone who holds the Academics area
(or is a full administrator), and that area gives both `resource.academics.read` and `.write`. `admin/settings` is for full
administrators. A plain teacher is not offered these pages (the API answers a teacher's `PATCH` on a class with 403, checked). See
finding setup-1 for what changes when organisation administrators can open a school console.

## Verified, and not verified

Verified on 2026-11-26 against a throwaway API (Postgres container on 59902, API on 4292, web on 5292; rows named `ZZW02`):

- 103 unit tests in `setupApi.test.ts` and `schoolSetup.test.ts`, written before the code: the request each function sends, the 409
  and 400 answers and the sentence the person reads, and the flag sets of both builds.
- Browser pass (Edge, signed in as the school admin with two-step): 42 checks scripted, 41 passed in the full run. The one miss was the
  script pressing the checklist's step header instead of its Assign button; a follow-up script showed the step assigning Form 2 West's
  teacher ("Class teacher assigned for Form 2 West.") and the API holding it. Covered: change, clear and re-set a class's teacher; edit
  a room (saved on Enter, kept after a reload); make a class with a room; the screen's own refusal to archive a class with a learner;
  the API's 409 reaching the screen in its own words (the roll was blanked in the browser so the request went out); the Archive
  confirmation text; archive an empty class (it is `active=false` on the API, not deleted, and leaves the list); make a subject with
  level and years; a level that does not fit the years refused on the screen; rename and untick Core (saved on the API); level back to
  "Any level" (null); a duplicate code refused with the API's 409 sentence; name, change (same assignment id) and clear a subject's
  teacher in a class; a subject outside the class's level not listed; the checklist's class-teacher step. Hidden and staying hidden:
  Promote, Add from KICD, and on School settings the fee structure, payment methods, roll forward, crest and AI settings. No page errors.
- `tsc` for shared, web, web tests, mobile and mobile node tests; `eslint .` (0 errors; 6 warnings, none in files this slice touches);
  full `vitest run`: 186 files, 3194 passed, 16 expected failures.

Not verified:

- **The Supabase build was not run in a browser.** Its screens and functions are unchanged in behaviour: the two new flags are false
  there, `kicdCatalogue` is true, the Delete wording is behind `onApi()`, the existing Supabase tests of `schoolSetup.ts` pass
  unchanged, and the new Supabase branches (`setClassRoom`, `updateSubject` with `level` and `isCore`) have unit tests. A read-only pass
  needs the owner's local Supabase, which this work may not use.
- The week-grid editor's absence (`classTimetable`) was checked by the flag value and the code, not by opening a class's Timetable.
- The phone app uses none of these screens. The shared code compiles in the phone's type check.
- No end-to-end spec (the owner's lighter checks), and no mutation tests.
- Nobody with only part of an organisation's delegation was tried (see setup-1).

## What this leaves stale in other files (not edited here)

`WEB_ON_THE_NEW_API.md` ("Where the model differs..." and its setup table), `api-gap-fixes.md` (first paragraph: "the web flags ...
stay off until a small web PR"), and `handoffs/WEB-ON-API-TODO.md` ("No class edit or delete", "No subject edit") still describe the web
build before this slice, for classes and subjects. The People flags that `api-gap-fixes.md` also names are slice W0.3's.

## API findings (numbered `setup-N`)

1. **A per-person gate will be needed when organisation administrators open school consoles (slice W0.6).** `adminAccessFor` treats an
   org admin acting in a school as having every page, but the API gives them only the permissions delegated to them (`area.academics`
   is delegable and implies read and write; `tenant.read` alone is not enough). Today `Org.openSchoolConsole` is off, so nobody gets
   here. When it is on, an org admin without an Academics delegation will meet a 403 on the page's first read, so the page will show its
   load error; if a later delegation ever grants `resource.academics.read` without write, the controls would fail on save. Then
   check `resource.academics.write` with `permissionCodes(tenantId)`, as the Gradebook (`apiFetchGradesAccess`) and report cards do, and
   pass the answer to these screens. Not built now; read from the code, not run.
2. **An archived class cannot be restored** and nothing lists archived classes (api-gap-fixes gap-2). The screens say so before the
   person archives. A restore route, or an "Archived" list as People has, would let the button be forgiving.
3. **A class whose teacher is no longer an active member of staff shows "Unassigned"** in the class-teacher select, because the select
   lists active teachers only and the class still names the old one. Read from the code, not run. Showing the stored name as a
   disabled option, or having the API clear the link when staff are archived, would remove the doubt.
4. **Nothing reads `is_core`** on either build: it is stored, and now editable on the API build, but no screen or report uses it
   (grep over `apps` and `packages`). Fine as a record; worth knowing before the owner expects it to change what a learner takes.
5. **The roll count on the Classes page can over-count for a person who cannot read learners.** `GET /learners` answers 403 to a holder
   of Academics without People, so the count then includes memberships of archived learners (rows left from before migration 101), and
   the screen can refuse an archive the API would allow. Read from the code, not run. The API's 409 count is exact.
6. **A `POST` with `content-type: application/json` and no body is refused with 400 "Invalid request"** (seen calling
   `POST /classes/{classId}/archive` from a script). The web client sends no content type on a body-less POST, so the app is not
   affected; other callers may trip on it.
7. **Subjects cannot be archived or deleted** through the API (api-gap-fixes lists it as not built), so the Subjects page has no remove
   control on either build. Nothing changes here.
