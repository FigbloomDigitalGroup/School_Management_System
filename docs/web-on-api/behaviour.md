# Behaviour and discipline log (admin/behaviour, teacher/behaviour, parent/behaviour, student/behaviour)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file. The API side is
`apps/api/docs/BEHAVIOUR.md` (migrations 118 and 119, PRs #424 and #429): the rules, who reads what, and each difference from Supabase.

The pages are the Supabase app's own (`screens/admin/Behaviour.tsx`, `teacher/Behaviour.tsx`, `parent/Behaviour.tsx`, `student/Behaviour.tsx`
and `components/behaviour/*`). The data behind them branches on `onApi()` in `packages/shared/src/behaviour.ts`, which calls
`packages/shared/src/api/behaviourApi.ts`. The four pages are registered in `apps/web/src/api/pages/behaviour.pages.tsx`; nothing else in
the console changes, because a menu entry with no registered page is hidden on the API build.

## What works

- **admin/behaviour** (the Discipline area, and a full administrator): the settings (points on or off, the mode, the starting balance, when
  points start again, the most points for one entry, the thresholds, what families may see), the categories (add, edit, archive, restore, "add
  the suggested categories"), recording for any learner or a whole class, the log with its filters (class, kind, category, who recorded it,
  learner, days, serious, open) and paging, voiding with a reason, the incident record (action taken, open or resolved, "parent told"), and every
  learner's points.
- **teacher/behaviour:** the classes the teacher teaches, the record form for those learners, their points, and the entries they recorded or that
  were recorded for those learners, with the staff-only notes. A teacher voids only what they recorded.
- **parent/behaviour** and **student/behaviour:** the points this period with the school's badges, and the entries the school lets families see:
  merits always, demerits and incidents only when the school turns them on. A parent reads their own children (the child switcher), a learner
  reads their own record.
- **People:** the behaviour tab of a learner (`peopleCapabilities().learnerBehaviour`) is on for the API build, for a full administrator and for
  holders of the Discipline area.
- A serious entry sends an in-app notice to the learner's class teacher and, when the school allows, to the parents (done by the API when the
  entry is recorded; see BEHAVIOUR.md "Notices").

## How the shared functions map

| Shared function | API |
|---|---|
| `fetchBehaviourSettings`, `saveBehaviourSettings` | `GET` and `PUT /behaviour/settings` |
| `fetchBehaviourCategories`, `saveBehaviourCategory`, `setBehaviourCategoryArchived`, `addDefaultBehaviourCategories` | `/behaviour/categories` (`include_archived` is always asked for), `PATCH .../{id}`, `POST .../defaults` |
| `recordBehaviour`, `voidBehaviourEntry`, `setBehaviourIncident` | `POST /behaviour/entries`, `POST .../{id}/void`, `PUT .../{id}/incident` |
| `fetchBehaviourEntriesPage`, `fetchLearnerBehaviour` | `GET /behaviour/entries` |
| `fetchBehaviourPoints`, `fetchClassLearners`, `fetchSchoolLearners` | `GET /behaviour/points` (it carries the learner's name and class) |
| `fetchBehaviourClasses`, `fetchBehaviourRecorders` | `GET /behaviour/classes`, `/behaviour/recorders` |
| `fetchFamilyBehaviour` (new, used by `LearnerBehaviour` when `staff` is false) | `GET /me/children/{learnerId}/behaviour` |

On Supabase `fetchFamilyBehaviour` is the same three reads the component made before, so that build behaves exactly as it did.

## Differences from the Supabase build (handled in `behaviourApi.ts`, not in the screens)

1. **The log is read once and paged here.** The API pages by cursor and gives no total, so `fetchBehaviourEntriesPage` reads the matching entries
   (at most 5,000) and slices them, as the paged Fees and Inventory screens do. The read is kept for 30 seconds for the same filters and
   forgotten after any write from this tab. Another person's new entry shows up within 30 seconds or on a reload.
2. **One read for the office's list and its points.** `fetchSchoolLearners` and `fetchBehaviourPoints(null)` are the same API read (the points
   list carries names and classes); the office page makes both calls and they share it.
3. **The teacher filter lists people who have recorded something,** not every staff member (`GET /behaviour/recorders`).
4. **A family reads one call.** A parent may not read `/behaviour/settings`, so the family branch never asks for it: the family read carries the
   school's display settings (without the maximum points per entry) with the points and the entries.
5. **A family never sees who recorded an entry,** a voided entry or the staff-only note (the API never sends them). The screens only show those to
   staff, so nothing changes on screen.
6. **Only the Discipline area, not delegation.** An organisation administrator cannot be delegated the Discipline area (BEHAVIOUR.md, owner
   question 1), so the console shows it to a full administrator and to people granted the area.

## Findings

- `behaviour-1`: the record form's "Subject" is not sent (neither screen has it); the API accepts `subject_id` and the entry keeps none.
- `behaviour-2`: a teacher who also holds the Discipline area lands in the admin console and uses `admin/behaviour` (`teacher/behaviour` is
  registered with `inAdminConsole: false`).
- `behaviour-3`: the pager's total is the number of entries read (capped at 5,000), not a database count.
- `behaviour-4`: the teacher page asks `/staff` and `/learners` (through `fetchMyClasses`, `api/teachingApi.ts`), which a plain teacher may not read.
  The shared code tolerates the 403 and the page works, but each visit shows two refused calls in the network log. Not part of this slice.
- `behaviour-5`: every page of the API console asks `GET /school-profile` for the school's name; a role without the People area gets a tolerated 403.
  Same cause, same status as the other pages.
- **Found by the browser pass and fixed in the API (PR #429):** the office's record form logs an incident with no category and 0 points, and the
  route took points of at least 1 (400). The route and the OpenAPI file now accept 0; the database still refuses 0 for a merit or a demerit.

## Tests

`packages/shared/src/api/behaviourApi.test.ts` (12 tests against a fake API): the mappers, every request body, that a write forgets the kept
reads, the paging and the cache, the 100-learner chunks, one read for the office's two lists, a failed read not being kept, and that the family
branch makes one call and never asks for the settings route. 
## Browser pass

36 checks on a freshly seeded throwaway API (the test harness's school with a year and term, two classes, six learners, a parent, a learner with a login, a
teacher, and a teacher who holds the Discipline area), Vite on the worktree's own code, Edge through Playwright. All passed:

- **Admin:** the page opens; the log shows a demerit with its note and the staff-only note; Serious incidents list an open one and "Follow up" saves it
  (toast "Incident resolved."); Learners & points list a learner whose merits minus demerits equal the points shown, and a click opens the timeline;
  the record form logs an incident with no category; Settings save, "Add the suggested categories" reports they are all there, a new category saves.
- **Teacher:** the page opens with the class, lists only the learners they teach (a learner of another class is absent), and a merit records.
- **Parent and student:** the page opens, the merit and (because the school allows demerits) the demerit show; the staff-only note never shows;
  the incident stays hidden while the school keeps incidents back.
- **Discipline-area holder:** the office page opens and shows the whole school's log.
- No page errors; the only refused calls are the two tolerated ones above (`behaviour-4`, `behaviour-5`).

Not covered by the browser: the Supabase build (CI's browser job runs it), the People page's behaviour tab, and a phone viewport.
