# Activities and medical

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Three pages open from the menu on an API build: **Sports & activities** for school administrators (`admin/activities`) and for teachers
who hold the Activities area (`teacher/activities`, the same screen), and **Sick bay** (`admin/medical`). They are the Supabase app's
own screens. The API sides are `packages/shared/src/api/activitiesApi.ts` and `medicalApi.ts` (with `learnerNamesApi.ts`, the name and
class lookups both use); `activitiesCapabilities()` and `medicalCapabilities()` in `capabilities.ts` say what is hidden, and the shared
function behind each hidden control throws `NotOnApiError`. Both pages are **partial**.

## Activities

**Works:** the list of activities with a member count each; add an activity (name, kind, when it meets, about) and pick its patrons when
it is made; open one to see its members (name, class, role) and add members from the learner list.

| Hidden on the API build | Missing in the API |
|---|---|
| Change an activity's details; close or reopen it; delete it | no `PATCH` or `DELETE` on an activity; the list holds open activities only |
| The Patrons column; changing or taking away a patron after the activity is made | no read of an activity's patrons and no way to remove one (`POST .../patrons` only adds) |
| Remove a member; change a member's role | no `PATCH` or `DELETE` on a member (B11). A role can be given only when the learner is added, and the screen does not ask for one |
| Fixtures, competitions, trips and performances; who is taking part; results; "Tell families" | no event endpoints at all |
| "My activities" (the ones a teacher is patron of) | no read of who the patrons are, so a teacher page shows every activity to someone who holds the Activities area |

How the model is mapped (`activitiesApi.ts`):

- A member has a learner id and nothing else. Names come from the learner list (an archived member is read by id), classes from the
  class memberships. Without the People or Academics area the member shows as "Learner (name not shown)" and the learner picker says
  it needs the People area.
- A patron is a sign-in (user id) of an active teacher or school administrator, so the picker lists teaching staff that have a sign-in.
  A patron list that goes wrong half way says how many were added; the activity itself is already made.
- Counts: there is no count endpoint, so each activity's members are read, four at a time.
- Only school administrators and holders of the Activities area may read or change activities. **A plain teacher cannot open the
  page**: it says "Activities are not open to teachers yet" and what to ask for (finding am-3).

## Sick bay

**Works:** who is in the sick bay now (the board, refreshed every minute); log a visit (learner box, complaint, temperature, pulse,
observations, assessment, treatment, outcome, where they went, follow-up) and change an open visit; open a learner's medical record
(allergies and conditions, blood group, diet, emergency notes, open visits, the last 60 days of dose records); choose when families are
told.

| Hidden on the API build | Missing in the API |
|---|---|
| "Today's visits" and a learner's past visits | the board gives open visits only (`time_out` empty); a visit that has left the sick bay is final and cannot be listed |
| Setting the time in | the server stamps `time_in` when the visit is logged and it cannot be changed |
| Medicine given at a visit and the medical stock | no endpoint for either |
| "Mark in today's register" after a visit | the visit has the columns and a database grant, but no endpoint writes them |
| The medication round, the overdue-doses banner and Requests | the API's medication flow is different (authorization, the family's consent, approval, a schedule, then one record per dose) and has no list endpoints for authorizations, schedules or doses of the school |
| Reports | they need visits, schedules and doses over a date range |
| Doctor, support needs, emergency contact and "medicines taken" on a health record | the API's health record holds a blood group, allergies, conditions, diet notes and emergency notes only. `saveStudentHealth` refuses a form that fills in anything else, and names it |
| "Opening this record is noted in the audit trail" | reading a learner's health record or dose records writes no audit event |
| The People page's Health editor (`admin/people`) | it stays hidden: it asks for the fields above |

How the model is mapped (`medicalApi.ts`):

- A visit carries a learner id only, so the board reads each learner by id (a few visits cost a few calls; the whole school's learners
  are not read). Without the People area the board says "Name not shown" and the page says why.
- **What a person may do depends on their areas.** The Medical area opens the board, visits and settings (`resource.medical.*`). Names
  need `resource.learner.read` (the People area) and health records and dose records need `resource.medication.read`, which only
  school administrators hold. So a nurse with only the Medical area can log and change visits but cannot search for a learner, sees
  no names, and sees no allergies. The page tells them (a note at the top, and in the visit and record windows) so that "nothing
  shown" never reads as "no allergies" (finding am-1).
- A new visit with an outcome, a place, a time out or a follow-up is two calls: the server's create takes none of them, so a change
  follows. If the change is refused the nurse is told the visit was logged and must not be logged again. A time out is never sent
  earlier than the time the server stamped (the database refuses it).
- A change to a visit carries the `row_version` it was read at; a clash is a 409 with the server's sentence. A visit that has left
  the sick bay is final, so it is not on the board to be changed.
- Dose records: an outcome of `administered` or `delayed` counts as given, `refused` as refused, `missed` as missed; the last
  correction of a record replaces its outcome. `held` and `exception` are counted on their own ("held back or noted as an
  exception"). Only the last 60 days show.
- The learner box uses the API's own search (`q`, eight at most) and does not read the whole school on each key.
- Telling families: the choice is saved, but the API reports `guardian_notices_available: false`, so the page says notices are not
  sent yet (finding 15).

## Checked on a real API, by role

| | School administrator | Teacher with only the Medical area | Plain teacher |
|---|---|---|---|
| Sports & activities | all of the above | no page (it needs the Activities area) | cannot open it: the page says why |
| Sick bay | all of the above | board, visits and settings; no names, no learner search, no health records | no page |

## API findings: activities and medical (numbered am-1 to am-6 so that no other slice shares a number)

- **am-1. The Medical area is not enough to run a sick bay.** `resource.medical.read` and `.write` open the board, visits and settings,
  but the learner list needs `resource.learner.read` and the health record and dose records need `resource.medication.read`
  (school administrators only). A nurse cannot find a learner, sees no names on the board and no allergies. Either the Medical
  area should also carry a learner lookup and the health read, or the visit and board answers should carry the learner's name and
  admission number.
- **am-2. A health record cannot be cleared.** `PUT /health/learners/{id}/profile` keeps the old blood group, diet notes and emergency
  notes when sent `null` (a `COALESCE` in `upsertLearnerHealthProfile`). The web sends `""` (and `"unknown"` for the blood group)
  to clear them. A `PATCH`, or treating `null` as "clear", would be clearer. The record also has no field for medicines taken,
  support needs, the family doctor or an emergency contact.
- **am-3. A patron cannot see their own activities.** Activities are readable only by school administrators and the Activities area
  (`resource.activity.read`); a plain teacher, even the patron, gets a 403, and there is no read of an activity's patrons. A
  teacher read scoped to the activities they are patron of (as classes are for teachers), with patrons in the activity record,
  would fix the teacher page.
- **am-4. Activities cannot be changed once made, and have no events.** No `PATCH` or `DELETE` on an activity, patron or member (B11),
  and `GET /activities` lists open activities only, so a closed one could not be found again. Re-adding a member with a role does
  nothing (`ON CONFLICT DO NOTHING`). Fixtures, competitions, trips, results and the family notice have no endpoints.
- **am-5. The sick bay has no history and no register link.** The board is open visits only, `time_in` cannot be set (a visit logged
  late gets the wrong time), a visit's outcome fields cannot be sent when it is created (so the web makes two calls and can
  fail between them), and `attendance_mark` has columns and a grant but no endpoint.
- **am-6. Medication has no reads for the school.** There is no list of authorizations, schedules or administrations, so the round,
  the requests, the overdue banner and the reports have nothing to show. The flow (the nurse asks, the family consents, the office
  approves, a schedule) is also not the one the Supabase screens have (the family asks, the nurse approves). Reading a health
  record or dose records writes no audit event, though the screen used to promise one.
