# My sections and section instructors (higher-education schools)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `teacher/sections` ("My sections", a lecturer's own sections and rosters) and the instructor controls of `admin/courses`.
The rest of Courses is in [timetable-classes-courses.md](timetable-classes-courses.md). Capability flags: `coursesCapabilities()`
in `packages/shared/src/capabilities.ts`. The API side is `api/coursesApi.ts` (`apiFetchInstructorSections`, the lecturer's roster,
`apiAssignSectionInstructor`). The API changes behind it (migration 107, `PATCH /he-sections/{id}`, `/me/teaching/he-sections`) are in
`apps/api/docs/TEACHER-READS.md`, Part 3.

This closes findings 42 and 43 of the Timetable, My classes and Courses area, except the room, capacity, schedule and "drop" parts.

## What works

- **My sections (teacher, higher-education schools):** the sections the lecturer is the instructor of, across semesters: course (code
  and name), section label, semester, and how many learners are enrolled now. "Roster" lists those learners (name and admission
  number). The menu shows the page only for a higher-education school, as on the Supabase build.
- **Courses > Sections (admin):** each section shows its instructor in a picker (name one, change it, or "Unassigned"). "Add
  section" has an optional Instructor picker. The pickers list the school's active teachers.
- **Courses > Roster (admin):** unchanged, now asks the API for one section instead of every enrolment of the school.

## How the model is mapped

- A section's **instructor is a staff record** of the school, so on the API build the instructor id is a staff id, as every teacher id
  is. The picker lists staff recorded as teachers. A lecturer sees their sections only if their staff record is **linked to their
  sign-in** (an invitation to a teacher links a record with the same e-mail; People can link one by hand). A staff record with no
  sign-in can be named instructor, and has no page to see it on.
- "My sections" asks the API (`GET /me/teaching/he-sections`); the server decides which sections are the person's, from their own
  active, linked staff record. The shared function takes the sign-in id as before and refuses to answer for anyone but the signed-in
  person.
- The roster function serves two readers. A person who holds the Academics read permission (an administrator) gets the school-wide
  roster: everyone ever enrolled, "withdrawn" shown as dropped. Anyone else (a lecturer) gets the learners enrolled now in a section they
  instruct, from `/me/teaching`. The choice is made from `GET /v1/rbac/permissions`, so a lecturer's page never sends a request
  that is refused.
- The semester column is the term's label, the same name the Semesters tab shows.
- **Counts differ in one case.** A lecturer's count and roster leave out an archived learner. The admin Sections list counts every
  `enrolled` enrolment, because it counts them itself from the school-wide list (finding `sections-1`).

## What the API cannot do yet (hidden on the API build)

| Hidden on the API build | Missing in the API |
|---|---|
| A section's room and capacity (the Room column of My sections, and the two fields of "Add section") | a section has no room or capacity |
| A section's weekly schedule | no schedule for a section |
| "Drop" in a section's roster | an enrolment can be made; nothing ends it |
| A course's department | a course has none |

## API findings (numbered `sections-1` and up inside this file)

- **sections-1. An archived learner stays enrolled.** Archiving a learner leaves their enrolments `enrolled` (the same as finding 8 for
  class memberships). The lecturer reads hide such a learner; the admin's school-wide list still shows them, and the admin Sections
  count includes them. A `GET /he-sections` that carried the same `enrolled_count`, or ending enrolments when a learner is archived,
  would make the two agree.
- **sections-2. Naming an instructor needs the staff list.** `GET /staff` needs `resource.staff.read`, so a person who holds only the
  Academics area gets an empty teacher list: they can see an instructor (by id, or the name when the staff list can be read) but cannot
  pick one. A list of teachers readable with Academics, or the instructor's name inside the section, would fix it.
- **sections-3. The Sections tab reads the whole school.** It lists sections, courses, every enrolment and the staff to put a name and a
  count on each row. `GET /he-sections` carrying the course code, the instructor's name and the enrolled count would be one call.
- **sections-4. Nothing ends an enrolment.** No endpoint changes an enrolment's status (`withdrawn` can only be set in the database), so
  "Drop" stays hidden, and a learner who left a course stays on the roster until their record is archived.
- **sections-5. No sign-in, no page.** A section can name a staff member who has no sign-in (a visiting lecturer); nothing says so on the
  Sections tab. The picker could mark teachers who cannot sign in.
- **sections-6 (owner's decisions, API Part 3).** Who may name an instructor (today the Academics area, as for creating a section), and
  whether a lecturer's roster may show the admission number (it does now).
