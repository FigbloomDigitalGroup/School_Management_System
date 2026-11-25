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
  `account_accept_invitation` definer function, so it is its own small PR (#380, migration 104: link by e-mail when
  exactly one unlinked staff record matches).

## Tests (negative first)

`test/teacher.reads.test.ts`, through the real `figbloom_app` login, for every read: the teacher's own classes (200 with
only that data); a teacher of another class; a teacher with no teaching assignment; a teacher whose staff record is not
linked or is archived; an inactive assignment; an archived class; an archived learner and an ended membership; another
school (by path and by `X-Tenant-Id`); an archived membership; a suspended school; a disabled account; a parent; a
student-role member; a driver; a parent whose account was wrongly linked to a teaching staff record; a cursor replayed by
another teacher. Chat: contacts never list parents or students, drop disabled and archived members, and are empty for a
parent or a student; a conversation names its peer, with `peer_role` null once they leave. The permission registry, the RBAC matrix (through the OpenAPI annotations), the grants matrix and the
RLS catalogue tests run unchanged.

## Part 2: content of the classes I teach, and my items

Written 2026-11-25. Found while putting the homework, learning materials, exam papers and "My items" pages on the web build
(findings `homework-1`, `materials-2`, `papers-4`, `inventory-1`): each of those lists needs an admin permission
(`resource.academics.read`, `resource.inventory.read`) that a plain teacher does not hold, so the page opens for an
administrator and for a teacher who also holds the Academics or Inventory area, and is refused to everyone else.

Four more reads, all `GET`, no migration (the permission `resource.teaching.read` of migration 103 is reused, and the rule
that decides "a class I teach" is the one above, `teachingClassIds()`). The first three return the **same rows and shape** as
the admin reads, so a client maps them the same way.

| Path | Who | Returns |
|---|---|---|
| `/me/teaching/homework-items?classId` | `resource.teaching.read` | `{ homework, page }`: homework items of the classes the caller teaches, all subjects of those classes (the scope is the class, as for every teacher read). By due date |
| `/me/teaching/learning-materials?classId` | `resource.teaching.read` | `{ materials, page }`: materials of those classes, **plus** the materials that name no class (shared with every class) when the caller teaches at least one class and `classId` is not given. Newest first |
| `/me/teaching/online-exam-papers?classId` | `resource.teaching.read` | `{ papers, page }`: papers of those classes. The list carries no questions, as `GET /online-exam-papers` (finding `papers-1` stays open). Newest first |
| `/me/inventory/issues` | any active member of the school (as `GET /staff/me`) | `{ issues, page }`: the caller's own OPEN issues (`holder_user_id` is the caller), each with `item_name`, `item_category` and `asset_tag`. No stock counts, location, cost or notes; nothing about another holder or a learner's issue. Newest first |

`classId` narrows to one class; a class the caller does not teach (another teacher's, another school's, unknown) gives an
empty list, not an error. A teacher who teaches nothing, or whose staff record is not linked, gets an empty list (200) and
no school-wide materials. A parent, a student and a driver get the same audited 403 as from `/me/teaching/learners`. Every
list is paged on the FIG-1621 convention; a cursor is bound to the caller's classes (or to the caller), so another teacher
cannot replay it.

How it is built: `listHomework`, `listLearningMaterials` and `listOnlinePapers` take an optional `classIds` filter (bound as a
parameter, so it is part of the cursor fingerprint); the teaching wrappers in `src/modules/academics/teaching.ts` narrow the
caller's classes and short-circuit to an empty page. `listMyOpenIssues` (`src/modules/inventory/inventory.ts`) joins
`inventory_issues` to `inventory_items` for the item's name only. No table, grant, policy or definer function is added or
widened: every statement reads tables the runtime role already `SELECT`s under the forced tenant policy.

Not opened, and why:

- **Any write.** A teacher still cannot set homework, add a material or create a paper without the Academics area. Whether
  a teacher may do so for the classes and subjects they are assigned (a teaching assignment names the subject) is the
  owner's decision (item 5 below).
- **A subject filter.** The scope is the class: a teacher of Mathematics in a class also reads that class's English
  homework. The write decision above is where a per-subject rule would matter.
- **Question text and answers of a paper**, and who sat it (attempts): not in the list today for anyone.
- **The register.** `GET /inventory/items` and `/inventory/issues` still need `resource.inventory.read`; "My items" shows the
  caller's own rows only.

What the web build needs next (not part of this change): the capability flags `canManageHomework`, `canManageMaterials`,
`canManageExamPapers` and `canReadMyItems` open the pages only for administrators and Academics or Inventory holders. They
can read through these endpoints for everyone else, with the create controls hidden until the owner decides item 5.

Tests: `test/teacher.scopedContent.test.ts` runs every case of "Tests (negative first)" above for each of the three content
reads (another class's teacher, no assignment, no linked or an archived staff record, an ended assignment, an archived
class, another school by path and header, an archived membership, a suspended school, a disabled account, a parent, a
student, a driver, a wrongly linked parent, a cursor replayed by another teacher, an unknown or malformed `classId`), the
school-wide materials rules, and for "My items" the own-rows-only rule (another holder, a learner's issue, a returned issue,
another school). Responses are validated against the OpenAPI schemas. A mutation check (eight guards removed one at a time)
was caught every time.

## Part 3: a lecturer's own sections (higher-education schools)

Written 2026-11-25. Found while putting `teacher/sections` ("My sections") on the web build (findings 42 and 43 in
`docs/web-on-api/timetable-classes-courses.md`): a section was a course in a term with a label, so nobody could ask "which
sections do I teach?". Migration 107 adds the instructor; two reads let the lecturer see their own sections and rosters.

**The instructor.** `he_sections.instructor_staff_id` is a nullable staff record of the same school (a lecturer is a staff
member with a linked sign-in, like a teacher of a class). The foreign key is on `(instructor_staff_id, tenant_id)`, so a staff
id of another school cannot be stored even by a bug; `ON DELETE RESTRICT`, as teaching assignments. `figbloom_app` may update
that one column and no other column of the table.

| Path | Who | Does |
|---|---|---|
| `POST /he-sections` | `resource.academics.write` | takes an optional `instructor_staff_id` (an active staff member of this school, else 400) |
| `PATCH /he-sections/{sectionId}` (new) | `resource.academics.write` | `{ instructor_staff_id }`: a staff id names or changes the instructor, `null` clears it. The same instructor again changes nothing. 404 for a section that is not in this school |
| `GET /he-sections` | `resource.academics.read` | each section now carries `instructor_staff_id` |
| `/me/teaching/he-sections` (new) | `resource.teaching.read` | the sections the caller instructs: course code and title, term label, section label, learners enrolled now. By course code, then label. Paged |
| `/me/teaching/he-sections/{sectionId}/enrolments` (new) | `resource.teaching.read` | the roster of one of those sections: enrolment id, learner id, name, admission number. By name. Paged |

"The caller instructs a section" is decided by the query on every request: the section names a staff record that is **active**
and **linked to the caller's account** in the school of the request. An archived record, an archived membership, a suspended
school or a disabled account ends it at once. A section that is another lecturer's, has no instructor, belongs to another school
or does not exist is the same 404 ("Section not found"). A parent, a student or a driver is refused at the permission (audited
403), even if a staff record was wrongly linked to them. Like every `he-*` route, all of this answers 400 in a school that is not
a higher-education school.

The roster lists a learner only when the enrolment is `enrolled` and the learner is still active, and the count in the sections
list uses the same rule. No date of birth, gender, boarding or contacts. A school administrator holds `resource.teaching.read`
too, but reads these routes only for a section they instruct themselves; the school-wide reads stay `GET /he-sections` and
`GET /he-enrolments?sectionId=` (the OpenAPI file now declares `courseId` and `sectionId`, which the routes always honoured).

Every change of instructor writes `academics.he.section.instructor_changed` (the section, the old and the new staff id: ids
only). A section created with an instructor writes it too (old id null).

**The kind of school, for every member.** Only an administrator may read the school profile (`resource.school_profile.read`), so a
lecturer's web menu could not tell a higher-education school from a K-12 one, and hid "My sections". `GET /v1/tenants/{tenantId}`
(every member holds `tenant.read`) now also returns `institutionType`: `k12`, `higher_ed`, or `null` for a school with no profile
yet. It reads the one column of `school_profiles` under the tenant policy; nothing else of the profile is shown.

Not done, and why:

- **Room, capacity and weekly schedule of a section.** Not asked for here; the web keeps those controls hidden.
- **Ending an enrolment** (a lecturer's "drop"): still no endpoint; `withdrawn` can only be set by the database owner.
- **Writes by a lecturer.** A lecturer cannot name themselves or anyone else. That stays with the Academics area (decision 6).

Tests: `test/he.sectionInstructor.test.ts`, through the real `figbloom_app` login (write side, both reads, and the database
rule). `grants.matrix`, the stage 9/10 contract tour, the RBAC and route-parity matrices and the RLS catalogue tests run with it.

## Open decisions for the owner (not decided here)

1. Should a teacher publish (and close) their own marks? Today `publish` and `close` need `resource.academics.write`; the
   assigned teacher can only save drafts.
2. Should a teacher create and publish a `class` announcement for a class they teach? Today they cannot
   (`resource.announcement.write`).
3. Should a covering teacher read the names of the class they cover that day?
4. Should a teacher see the parents of their learners as chat contacts?
5. Should a teacher set homework, add learning materials and create online exam papers for the classes and subjects they
   are assigned to teach? Today each needs `resource.academics.write`. This change only lets them read.
6. Who may name a section's instructor? Today `resource.academics.write` (a school administrator or an Academics-area
   holder), the same as creating a section. A head of department with a narrower right would need its own permission.
7. May a lecturer's roster show the admission number? It does now (name and admission number, as the Supabase screen did).
   Say if it should show names only.
