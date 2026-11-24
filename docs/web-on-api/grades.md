# Grades: exams, the gradebook, performance and reports

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.


Five pages: `admin/exams`, `teacher/gradebook`, `admin/performance` and `teacher/performance` (one screen), and `admin/reports`.
They are the Supabase app's own screens. The API side is `packages/shared/src/api/gradesApi.ts` (exams and marks),
`performanceApi.ts` (the charts) and `reportsApi.ts` (the term report); `gradesCapabilities()` and `fetchGradesAccess()` in
`capabilities.ts` and `teacherData.ts` say what is hidden. Report cards are not here (another slice).

## How the API's model differs

- **An exam is a name for the term** on Supabase. The API has no such record: it has an **assessment for each class and
  subject** (a title, a kind, `max_score`, a status of draft, published or closed). So on the API an exam is every assessment
  of kind `exam` with the same title in a term, and its id is `<termId>|<title>`. "New exam" makes one assessment for every
  class of the term's year and subject that has a teacher (one request each, four at a time). "Add new class subjects" makes
  the missing ones later, when a subject was given a teacher after the exam was made.
- **The paper's total is `max_score`** (up to 10,000, decimals allowed), not a fixed 100. "New exam" asks for it. The
  Gradebook header, the limit on a mark and the decimals follow it. Grades and means are worked out as percentages, so exams
  with different totals still compare.
- **Publishing is final and is the Academics area's.** A teacher who is assigned the class and subject can save marks (a
  draft) but cannot publish; the school office publishes from the Exams page (the "Papers" window: publish or close one paper,
  or all drafts). A published paper's marks are locked, so "Withdraw results" does not exist and the boxes are read-only.
- **There is no "absent" mark.** `abs` saves nothing for that learner; a saved mark cannot be taken back to absent (the web
  refuses before writing anything).
- **No bulk write.** Marks are sent four at a time; only marks that changed are sent (with the `row_version` they were read at);
  a failure says how many were saved ("Saved 2 of 3 marks (1 failed: ...)").

## What a person can do, by role (checked on a real API)

| | School admin | Teacher with the Academics and People areas | Plain teacher (class or subject teacher, no areas) |
|---|---|---|---|
| Exams | all of it: new exam, papers, publish, close, add new class subjects | no menu page unless the Academics area opens the admin console; publishing needs `resource.academics.write` | no page |
| Gradebook | not a teacher page (no classes of their own) | enters marks for the classes and subjects they teach, and publishes | **cannot open it**: the page says why |
| Performance | the whole school, or one class | their classes | **cannot open it**: the page says why |
| Reports | all of it (full admins only, as on Supabase) | no page | no page |

A plain teacher can read classes, class memberships, assessments and marks of the classes they teach (OD-2). They cannot read
the terms or the subjects (`resource.academics.read`) or the learners' names (`resource.learner.read`), so the Gradebook has no
term, no subject names and no learners to show. The page says: "The new system does not let you read this school's terms,
subjects and learners with the access you have, so the Gradebook cannot open for you yet. Ask the school office to give you the
Academics and People areas." Performance gives a sentence of the same kind. This is the gap that also stops the teacher's
Attendance page for a plain teacher (finding 23).

## What the API cannot do yet (hidden on the API build)

`gradesCapabilities()` hides these, and the shared function behind each throws `NotOnApiError`:

| Hidden on the API build | Missing in the API |
|---|---|
| Rename an exam; delete an exam | no change or delete for an assessment's title (the same missing PATCH and DELETE as classes and subjects) |
| "Marks entered" on the Exams page | an assessment carries no mark count; the "Papers" window counts each paper's marks with one read each |
| Withdraw results; change a published mark | publication is final; a correction (`/mark-corrections`, needs a reason, Academics writers) is not built in the web yet |
| The CBE strand gradebook (the "Strand assessment" tab) | a subject has no learning area, so its strands cannot be found; CBE results are written by Academics writers only |
| The higher-education gradebook | the API keeps one final grade for each enrolment (`/he-enrolments/{id}/grade`), not a section's assessments and marks; the screen shows a sentence |
| The CBE rubric charts on Performance, the CBE table on Reports | the figures need the learning-area link above (the functions answer "none") |

## How the figures are worked out

- **Performance** (`performanceApi.ts`): the published and closed papers of kind `exam` (one list), their marks (one read per
  paper, six at a time, kept for a minute because a published paper's marks are final), the terms, subjects, classes and who
  teaches each (staff names only if the staff list may be read). Rows are percentages of each paper's own total. Only published
  results count, like Supabase.
- **Reports** (`reportsApi.ts`): the API's reports (`/reports/overview`, `finance-summary`, `academics-summary`) are
  whole-school counts with nothing by class. So attendance comes from `/attendance-counted` (every entry of the term, 200 to a
  page, counted by class), fees from the term's invoices joined to each active learner's class, and the class means from the
  marks of the latest exam to go out. A class mean uses published papers only (Supabase's counted any entered mark, FIG-1441).
  A big school waits longer than it did on Supabase (finding 25).

## Things found in the API while doing this

(Numbered so that no other slice shares a number: this slice's findings are 23 to 28.)

23. **A plain teacher cannot read what the teacher pages need.** They read classes, memberships, teaching assignments, assessments
    and marks (OD-2 scoped), but `/academic-terms`, `/subjects`, `/learners` and `/staff` answer 403, so they have no term, no
    subject names, no learner names and cannot tell which subjects are theirs. The Gradebook, Performance and the teacher's
    Attendance page cannot work for them. A teacher read of the current term, of the subjects they teach, and of the names of
    the learners in classes they teach (on `/class-memberships`, say) would fix all three.
24. **A teacher cannot publish their own marks.** Mark writes are open to the assigned teacher; `publish` and `close` need
    `resource.academics.write`. Supabase let each teacher publish their own class and subject. If that is wanted, `publish`
    could accept the assigned teacher, as the mark write does. Publication is also final (no withdraw), and a mark cannot be
    deleted or saved as "absent" (`score` is required).
25. **No per-class term figures.** Reports needs attendance, fees and marks by class for a term. Supabase did this in
    `term_class_figures`. On the API the web reads every attendance entry of the term (`/attendance-counted`, 200 a page): a
    school of 500 learners over a 60-day term is about 150 requests, one of 1,500 about 450. A `GET /reports/term-class-figures`
    (attendance here and total, billed and paid, and a mark mean for an exam, per class) would be one request. Also,
    `/attendance-counted` accepts `classId` in the route and the description, but the OpenAPI file does not list the parameter.
26. **An exam is not a record.** An exam is a title shared by the per-class assessments, so it has no rename, no delete, no
    mark count, and making one takes one request for each class and subject. A term-level exam record (name, total) that the
    assessments point to would give all of these, and let the web publish a whole exam in one call.
27. **A subject has no learning area**, so a CBE assessment (`learning_area_id`) cannot be chosen from the subject a teacher
    teaches, and the strands of a subject cannot be found. CBE results can be written only by Academics writers.
28. **Higher education marks.** The API has one grade per enrolment and no section assessments with marks, so the course
    gradebook (`GpaGradebook`) has nothing to run on.
