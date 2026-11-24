# Teacher reads

Written 2026-11-24, before the code. What a plain teacher (a `teacher` member with no admin area) can read on the API so
the teacher pages work, how the API decides "a class I teach", and what stays closed.

## The problem

A plain teacher already reads the classes they teach, those classes' memberships, teaching assignments, timetable slots,
attendance registers and assessments (OD-2, `classReadScope`). They cannot read terms and academic years
(`resource.academics.read`), learner names (`/learners`, `resource.learner.read`) or other staff names (`/staff`,
`resource.staff.read`). So teacher Attendance, Gradebook, Performance, Chats ("Someone at the school") and Timetable cannot
work for them. Subjects are handled elsewhere (`GET /subjects`, teacher-scoped on `feature/web-api-timetable-courses`);
this change does not touch that route.

## One rule decides "a class I teach"

A class is one the caller teaches **in the school of the request** only when all of these hold at the moment of the
request (nothing is cached in the token):

| Check | Where it is stored | What breaks it |
|---|---|---|
| The caller holds `resource.teaching.read` | `role_permissions` (migration 103) | the caller is a parent, a student, a driver or an org admin |
| The caller is an active member of this school, which is not suspended | `school_memberships`, `tenants` (checked for every request) | the membership is archived; the school is suspended |
| A staff record in this school is linked to the caller's account, and is active | `staff_members.user_id`, `active AND archived_at IS NULL` | the record is not linked, or is archived |
| The staff record is the class teacher, or has an active teaching assignment for the class | `classes.class_teacher_staff_id`, `teaching_assignments.active` | the assignment ends; another class teacher is set |
| The class is active | `classes.active AND archived_at IS NULL` | the class is archived |

The rule is one function, `teachingClassIds()` (`src/modules/academics/teaching.ts`). It is stricter than the existing
OD-2 helper `teacherClassIds()`, which also counts an assignment to an inactive class and ignores the caller's role;
that helper and the routes that use it are not changed here.

### Permission

A new catalogue permission, `resource.teaching.read` ("Read the classes one teaches: learner names, calendar, colleagues"),
granted to the roles that can hold a teaching record: `teacher`, `staff`, `school_admin`, and `super_admin` (holds every
permission; has no staff record, so the rule gives them no classes). It is not implied by any admin area and cannot be
delegated. A staff record may be linked to any active member of the school (migration 022), including a parent, so the
permission is what keeps a wrongly linked parent out.

## Reads

All are `GET`, bearer session, tenant from the path (it must equal the session's school or the `X-Tenant-Id` the caller
proves).

| Path | Who | Returns |
|---|---|---|
| `/academic-years`, `/academic-years/{id}`, `/academic-terms`, `/academic-terms/{id}` (widened) | holders of `resource.academics.read`: every year and term, as before. Anyone else who teaches (rule above): only the academic years of the classes they teach, and those years' terms. Anyone else: the same audited 403 as today | unchanged shapes. A year or term outside the scope is 404, like one that does not exist |
| `/me/teaching/learners?classId` (new) | `resource.teaching.read` | `learner_id, full_name, admission_no, class_id`: one row per **active** membership of an **active** learner in a class the caller teaches. `classId` narrows to one class (a class they do not teach gives an empty list). Paged, by name |
| `/me/teaching/colleagues` (new) | `resource.teaching.read` | `staff_member_id, full_name` of the active staff who are class teacher or hold an active teaching assignment in the classes the caller teaches (the caller included). No phone, e-mail or account id. Paged, by name |
| `/chat/contacts` (new) | any member (chat is `authenticated`, as today) | for a caller with a staff role (`school_admin`, `teacher`, `driver`, `staff`): the other staff-role members of this school with an active account, `user_id, full_name, role` (the staff-to-staff rule of `may_talk`). Empty for anyone else (a parent's list stays `/me/chat-contacts`). Paged, by name |
| `/chat/conversations` (two fields added) | as today (own conversations only) | each conversation also carries `peer_full_name` (the other person's account name) and `peer_role` (their role in this school, `null` once they have left) |

A teacher who teaches nothing, or whose staff record is not linked, gets an empty list from `/me/teaching/*` (200), and
the usual audited 403 from the calendar reads (as from `/classes` today).

## Database

No table, grant, policy or definer function is added or widened. Migration 103 only adds the permission and its role
rows (101 and 102 are held by other open API slices). Every read uses tables the runtime role already `SELECT`s under the forced tenant policy
(`tenant_id = app_current_tenant_id()`): `classes`, `class_memberships`, `learners`, `staff_members`,
`teaching_assignments`, `academic_years`, `academic_terms`, `school_memberships` (active rows of this school), and the
`full_name` and `status` columns of `users` (column grant, migration 011). RLS keeps each statement in the school of the
request; the per-class filter is application code, as for every other read.

## Not opened, and why

- **The full `/learners` and `/staff` lists.** A learner record carries date of birth, gender and boarding; a staff record
  carries phone and e-mail. The teacher reads return names only.
- **Learners who left the class** (inactive membership) and archived learners: a mark or register of theirs shows no name.
- **A class the caller only covers** (`attendance_coverage`): the cover lets them write that day's register, not read
  its names. Owner question if covering teachers need it.
- **Parents as chat contacts for a teacher.** `may_talk` lets a teacher talk with the parents of learners they teach,
  but listing them would show guardian identities, which only an administrator or a per-person grant may read
  (FIG-1614). A parent who writes first is named in the conversation list.
- **Any write.** Publishing marks and class announcements are owner decisions (below).
- **Linking a staff record when a staff invitation is accepted** (found by the account slice: a teacher invited on the
  API "teaches nothing" until someone sets `userId` on their staff record). Not part of this change: it touches the
  `account_accept_invitation` definer function, so it belongs in its own small PR.

## Tests (negative first)

`test/teacher.reads.test.ts`, through the real `figbloom_app` login, for every read: the teacher's own classes (200 with
only that data); a teacher of another class; a teacher with no teaching assignment; a teacher whose staff record is not
linked or is archived; an inactive assignment; an archived class; an archived learner and an ended membership; another
school (by path and by `X-Tenant-Id`); an archived membership; a suspended school; a disabled account; a parent; a
student-role member. The permission registry, the RBAC matrix (through the OpenAPI annotations), the grants matrix and the
RLS catalogue tests run unchanged.

## Open decisions for the owner (not decided here)

1. Should a teacher publish (and close) their own marks? Today `publish` and `close` need `resource.academics.write`; the
   assigned teacher can only save drafts.
2. Should a teacher create and publish a `class` announcement for a class they teach? Today they cannot
   (`resource.announcement.write`).
3. Should a covering teacher read the names of the class they cover that day?
4. Should a teacher see the parents of their learners as chat contacts?
