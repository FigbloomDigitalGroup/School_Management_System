# Timetable, My classes and Courses

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.


Pages: `teacher/timetable`, `teacher/classes`, the Timetable window of a class on `admin/classes`, and `admin/courses` (higher-education
schools). `teacher/sections` ("My sections") is on the API build since the section instructor was added; it and the instructor controls
of Courses are described in [higher-ed-sections.md](higher-ed-sections.md). Capability flags: `timetableCapabilities()` and
`coursesCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `api/timetableApi.ts`, `api/teachingLookups.ts`,
`api/teachingApi.ts` and `api/coursesApi.ts`.

**Needs API PR #363 merged first:** `GET /v1/tenants/{id}/staff/me` (a person's own staff record) and a teacher-scoped
`GET /subjects` (the subjects of the classes they teach). Without them these pages still open, but a plain teacher cannot tell which
periods and classes are theirs, a period's subject shows as "Lesson", and My classes lists no subjects.

## What works

- **Timetable (teacher):** the classes the teacher teaches or leads; one class's week or all of them; the class teacher sees the
  whole week of their homeroom (each period says whose it is), a subject teacher sees only their own periods. Times and rooms come
  from the class's timetable slots.
- **My classes (teacher):** the classes, the person's role in each (class teacher or subject teacher), the subjects they teach
  there, the roll size.
- **Classes > Timetable (admin):** the class's periods, Monday to Friday, with start and end times, subject, teacher and room; add a
  period (day, start, end, subject, room). An overlapping period is refused by the API and the window says so.
- **Courses (admin, higher-education schools):** semesters (= academic terms: list, add, set as current), the course catalogue (list,
  add), sections of a semester (list, add, with the instructor named or changed), a section's roster (list, enrol learners).

## How the model is mapped

- A timetable **slot** has a subject, a day number, a start and an end time and a room. It has no free-text label, so a period is
  named by its subject; "Games", "Library" or "Break" can only be periods if the school makes them subjects. Saturday and Sunday
  slots are not shown (the screens' week is Monday to Friday).
- Who teaches a period is the **teaching assignment** of that subject in that class (the slot's own link when it has one). "Mine"
  means "assigned to my staff id", found with `GET .../staff/me`.
- A class records its class teacher as a staff id. In a teacher's own class list, a class they lead carries their sign-in id as
  `class_teacher_id`, so the screens' existing "am I this class's teacher" check works (this also fixes the early sign-out check on
  the teacher Attendance screen).
- A **semester is an academic term**. "Add semester" finds or makes the calendar year (1 January to 31 December), then the term.
  "Set as current" also sets the term's year current. Every higher-education call is refused (400) unless the school's profile says
  it is a higher-education school.
- A course's **title** is the screens' course name and its **credit hours** are its credits. The API has no batch, so enrolling
  several learners goes one at a time (four at once) and a refusal part-way says how many went in.
- The school-wide lookups of a timetable page (subject names, staff names, the person's own staff id) are kept for 8 seconds so a
  page of six classes asks for them once.

## What a plain teacher can and cannot do on the API

A plain teacher (no area) reads only the classes they teach (OD-2), and those classes' memberships, assignments and timetable
slots. They cannot read the staff list, learners or academic years/terms. So on the Timetable page they see their periods; a colleague's
name is missing from the class teacher's whole-class view; and the page's "Timetable · Term 1" heading is missing (no term read).
A teacher who teaches nothing sees "You aren't assigned to any classes yet." A person with no staff record (a school administrator
who was never added to the directory) has no periods of their own.

## What the API cannot do yet (hidden on the API build)

| Hidden on the API build | Missing in the API |
|---|---|
| The week-grid editor of a class's timetable (replaces the whole week; CSV import) | a slot can be made and listed, not changed or removed; so there is a list and an "Add a period" form instead |
| A free-text period label ("Games", "Library", "Break") | a slot is a subject's period, with no label |
| "Needs cover" and "Covered by" on a teacher's timetable | `/attendance-coverage` is attendance cover by class and day, not cover for a period, and a plain teacher cannot read others' leave |
| The "Live classes" panel on the teacher Timetable | calls and live classes are not in the API |
| A course's department | a course is a code, a title and credit hours |
| A section's room, capacity and weekly schedule | a section is a course in a term with a label and an instructor (migration 107) |
| Dropping a student from a section | an enrolment can be made; nothing ends it (the status `withdrawn` exists, with no endpoint) |

`/timetable-publications` (a versioned snapshot of a class's timetable that is published) has no Supabase counterpart and nothing
on the web reads it, so it is not used.

## API findings (numbered 38 to 44 so that no other slice shares a number)

38. **A plain teacher cannot learn their own staff id.** Class teachers, teaching assignments and timetable slots name staff ids, a
    teacher cannot read the staff list, and `/auth/me` has no staff id. Fixed in API PR #363 with `GET /staff/me`.
39. **A plain teacher cannot read the subject list**, so a timetable slot or a teaching assignment (subject ids) cannot be named, and
    "My classes" cannot list subjects. Fixed in API PR #363: `GET /subjects` is scoped like the class list (OD-2) to the subjects of
    the active teaching assignments and timetable slots of the classes they teach.
40. **Colleagues' names:** the class teacher's whole-class timetable would name each period's teacher, which needs the staff list.
    A plain teacher sees no name. A staff name inside the teaching-assignment record, or a scoped staff read, would fix it.
41. **A timetable slot cannot be changed or removed**, and a slot needs a subject (no "Break", "Games", "Assembly").
42. **A higher-education section has no instructor, room, capacity or schedule**, and an enrolment cannot be ended. So a lecturer's
    "My sections" cannot be built on the API, and the admin cannot name an instructor.
    *Resolved for the instructor and "My sections" in API PR #406 (migration 107, `PATCH /he-sections/{id}`, `/me/teaching/he-sections`)
    and web PR #409: see [higher-ed-sections.md](higher-ed-sections.md). Still missing: room, capacity, schedule, and
    ending an enrolment.*
43. **The OpenAPI file does not declare** `sectionId` on `GET /he-enrolments` or `courseId` on `GET /he-sections`, although the routes
    honour them. The typed client cannot send them, so a section's roster lists every enrolment of the school and picks the section
    out. Declaring them would make it one small call.
    *Resolved in API PR #406: both are declared, and the roster asks for one section.*
44. **Per-period cover for approved leave** (the Supabase "Needs cover" list) has no API counterpart: `/attendance-coverage` assigns
    who may take a class's register on a day.
