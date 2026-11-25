# Behaviour and discipline log (S2a, WEB-ON-API-ROADMAP.md)

Written 2026-11-25, before the code. A port of the live Supabase feature (`20261124400000_behaviour_log.sql`, #378, with the
guards of `20261125000000`). It is a port, not a second design: the rules below are the ones `CHANGELOG.md` states for
production, and where the API cannot do it the same way the difference is listed under "Differences".

Four web pages wait on this: `admin/behaviour`, `teacher/behaviour` (S2c) and `parent/behaviour`, `student/behaviour` (S2d).

## Split

| Slice | Holds |
|---|---|
| **S2a** (this note, migration 118) | the `discipline` area and permissions; settings; categories (create, edit, archive, defaults); recording (several learners at once, with the staff-only note); the log; voiding; points; the three small reads the web forms need (classes, learners with their points, recorders) |
| **S2b** (next PR) | the incident follow-up (action, open or resolved, "parent told"), the in-app notice to the class teacher and the family, and the family reads (`/me/children/{learnerId}/behaviour`, for a parent and for the learner's own record) |

The migration creates all four tables and every trigger once, so S2b adds routes only. The incident columns are in the table
from the start and are not written by S2a (the guard refuses it).

## The rules that stay (from `CHANGELOG.md`, "Behaviour and discipline log")

- **Points mode per school:** merits only; demerits only (counted down from a starting balance); or both.
- **Reset:** per term, per school year, or never.
- **Any teacher of the learner records an entry.** The office manages the log through the `discipline` area. A full school
  administrator holds every area.
- **Voided, never deleted.** A mistake is voided with a reason (3 to 300 characters). The entry stays, uncounted and hidden from
  families. Whoever recorded it, or the office, may void.
- **A serious entry is an incident:** it carries an action, a follow-up status (open or resolved) and a "parent told" time (S2b).
- **Families (S2b):** merits and the total always; demerits and incidents only when the school turns them on; staff-only notes
  never; voided entries never.
- **Categories are never deleted, only archived,** so entries keep theirs. A school gets the default list when the office asks.
- **A staff-only note** sits in a table of its own (`behaviour_staff_notes`). No family or learner read ever selects it.

## Permissions (migration 118)

| Code | Who | Lets you |
|---|---|---|
| `resource.discipline.read` | `school_admin`, `super_admin`, the Discipline area | read the whole log, all points, the staff-only notes, the recorders |
| `resource.discipline.write` | same | everything above, plus settings, categories, recording for any learner, voiding any entry (S2b: incidents) |
| `resource.behaviour.record` | role `teacher` | record for the learners you teach; read what you recorded and what is recorded for them; void your own |

- **The Discipline area** is new: `discipline` joins `ADMIN_AREAS`, the `staff_area_grants` and `school_roles` checks
  (migration 118), and implies `resource.discipline.read` and `.write` (`DISCIPLINE_AREA_IMPLIED`). It is in no delegation
  list: **an organisation administrator cannot be delegated it** (owner question 1, below).
- A teacher with no area keeps working: `resource.behaviour.record` is a role permission, as `resource.teaching.read` is.
- A parent or a student never holds any of these. Their reads are S2b and use `resource.family.read` and
  `resource.student.self.read`.

### "A learner I teach"

Decided on every request, by the same rule as the teacher reads (`TEACHER-READS.md`): the learner holds an ACTIVE membership of
an ACTIVE class in `teachingClassIds()` (the caller is that class's teacher, or has an active teaching assignment in it, through
an active staff record linked to their account). A learner who left the class, an archived learner, a class the caller only
covers, or any learner of another school is **not** taught. Recording for one answers `403 "You can only record behaviour for
learners you teach"`, the same for every cause so the answer is not an oracle for learner ids.

A teacher reads an entry when they recorded it or the learner is taught (Supabase `behaviour_entries_read`), staff-only notes
included, as in Supabase.

## Database (migration 118)

All four tables follow the standing rule (`TENANT-ISOLATION.md`): `tenant_id`, `ENABLE` + `FORCE` row security, one `FOR ALL`
policy for `figbloom_app` on `app_current_tenant_id()`, the owner-only policy, minimal grants, same-school references through
composite foreign keys.

| Table | App may | Notes |
|---|---|---|
| `behaviour_settings` | `SELECT`, `INSERT`, `UPDATE` (the setting columns) | one row per school; none = the defaults of `DEFAULT_BEHAVIOUR_SETTINGS` in the shared package |
| `behaviour_categories` | `SELECT`, `INSERT`, `UPDATE` (name, points, severity, sort order, archived) | unique name per school and kind; never deleted |
| `behaviour_entries` | `SELECT`, `INSERT`, `UPDATE` (the void and incident columns only) | no `DELETE`; the guard trigger refuses any other change |
| `behaviour_staff_notes` | `SELECT`, `INSERT` | one per entry, never changed |

`behaviour_entries_guard()` is a `SECURITY INVOKER` trigger (it runs as the caller, under row security, so it can only see the
school of the request; no owner rights are lent). On `INSERT` it: checks the learner is an active learner of the school and the
category is the school's, active and of the right kind; gives the entry its sign (a merit is positive, a demerit negative, an
incident zero or negative) and refuses more points than `max_points_per_entry`; derives the severity (a merit has none, a
demerit takes its category's, an incident defaults to serious); refuses a date in the future (the school's today) or over a year
old; checks the class is the learner's current one; stamps `recorded_by` from `app_current_user_id()` (never from the client)
and `created_at`; clears every void and incident column a client might send; and starts a serious entry `open`. On `UPDATE` it
refuses everything except voiding an unvoided entry (S2a) or setting the incident record of an unvoided entry (S2b), and
stamps `voided_by` and the incident's `resolved_by`.

## Points

`GET /behaviour/points` is computed per request, in one statement over the period holding `on` (the school's today by default):

- `merit_points` = the sum of positive entries, `demerit_points` = the sum of negative ones (0 or less), not voided, on or before
  `on`, inside the period. Every entry counts, whatever families may be shown of them (a total that hid demerits would be wrong).
- `balance` = `merits_only`: merits; `demerits_only`: `starting_points` + demerits; `both`: merits + demerits. `null` when the
  school has points turned off.
- **The period** (`behaviourPeriod` in `src/modules/behaviour/points.ts`, the same rule as `behaviour_period` in Supabase):
  `never` has no bounds. `term`: from the start of the latest term that began on or before `on` to the day before the next term
  starts (the holiday after a term belongs to it); before any term, from 1 January. `year`: the academic year of that term,
  from its first term's start to the day before the next year's first term starts.
- Thresholds (`{points, label}`, at most 10) are returned with the settings; the web compares them (`thresholdsReached`).

## Routes (S2a), all under `/v1/tenants/{tenantId}/behaviour`

| Route | Permission | Does |
|---|---|---|
| `GET /settings` | office, or `resource.behaviour.record` | the school's settings (defaults when none) |
| `PUT /settings` | `resource.discipline.write` | replaces the settings; audited |
| `GET /categories?include_archived` | office, or `resource.behaviour.record` (active only) | the categories, by kind, order, name |
| `POST /categories` | `resource.discipline.write` | creates one; 409 on a duplicate name for the kind |
| `PATCH /categories/{id}` | `resource.discipline.write` | edits it, or archives and restores it |
| `POST /categories/defaults` | `resource.discipline.write` | adds the 14 suggested categories the school lacks; `{added}` |
| `POST /entries` | `resource.discipline.write`, or `resource.behaviour.record` for taught learners | records one entry for each of 1 to 80 learners; the same note and staff-only note on each |
| `GET /entries` | office, or `resource.behaviour.record` | the log, newest first, filtered, paged |
| `POST /entries/{id}/void` | `resource.discipline.write`, or the recorder | voids it with a reason |
| `GET /points` | office, or `resource.behaviour.record` | learners in scope with their points, by name, paged; optional `class_id`, `learner_id`, `on` |
| `GET /classes` | office, or `resource.behaviour.record` | the classes in scope (the office: every active class of the current year; a teacher: the classes they teach) |
| `GET /recorders` | `resource.discipline.read` | the people who have recorded an entry (the log's teacher filter) |

Every write is audited under the `academics.behaviour.*` event names (they fall under "academic" in the school audit log, as the
Supabase triggers' category did, with no change to the audit read): the detail carries ids and counts, never a note or a name.
A refusal is the usual audited 403.

## Differences from Supabase (each on purpose)

1. **Points are computed in the API, not in a definer function.** `behaviour_points` and `behaviour_period` were security
   definer functions; here the period is worked out in TypeScript from the school's few terms and the sums are one ordinary
   query under row security. Nothing new is lent to the runtime role.
2. **Years come from `academic_years`,** not an integer on the term. With `year` reset, a school with no later year set up is
   open-ended instead of ending on 31 December.
3. **A learner's class is the current-year active membership** (the API's rule everywhere), not a column on the learner.
4. **The learner list is paged** and carries the points (one call), where Supabase fetched the learners and the points apart.
5. **`GET /recorders` lists the people who recorded something,** not every staff member.
6. **Audit** is written by the route (`recordSecurityEvent`), as the rest of the API does, not by table triggers.

## Not in S2a

Incidents, the notices and the family reads (S2b). The web pages (S2c, S2d). The category order is fixed at creation (100); a
reordering control is not on the Supabase screens either.

## Open owner questions

1. **Delegation.** Should an organisation administrator be able to be delegated the Discipline area? The approved delegation
   list is "the admin areas except people"; this area holds staff-only notes about children, so it is left out until you say.
   Adding it is one migration and one line.
2. **Who may read a staff-only note.** Supabase lets the office and any teacher who can read the entry. Kept. Say if it should
   be the recorder and the office only.
3. **Should a learner who has moved class keep their old teacher's read?** The teacher reads entries for learners they teach
   *now* and anything they recorded themselves, as Supabase does.

## Tests (negative first)

`test/behaviour.test.ts`, through the real `figbloom_app` login: every route refused for a parent, a student, a driver, a teacher
on the office routes, a holder of another area, another school (by path and by header), an org admin without a delegation, a
suspended school and a disabled account; a teacher recording for a learner they do not teach (another class, left the class,
archived, another school); then the rules (sign, maximum, date, category kind, archived category, duplicate names), the
database guard on its own (a forged recorder, a rewritten entry, a delete, another school's rows), voiding, the scope of the
log for a teacher, the staff-only note, and the points in each mode and reset. `behaviourPeriod` has its own unit tests.
