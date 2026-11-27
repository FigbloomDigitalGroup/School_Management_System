# Teacher homework (`teacher/homework`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

## What works on the API build

- `teacher/homework` opens the `Homework` screen (`apps/web/src/screens/teacher/Homework.tsx`, registered via `apps/web/src/api/pages/homework.pages.tsx`) for school administrators and teachers holding the **Academics** area (`canManageHomework`).
- Teachers list homework set for the classes they teach or lead (newest due date first, resolved against class and subject names).
- Teachers can set new homework (`POST /v1/tenants/{tenantId}/homework-items`) for a class and subject they are assigned to teach, automatically attaching the current academic term (`term_id`).
- Teachers can edit an item (`PATCH .../homework-items/{id}`) and archive it (`POST .../homework-items/{id}/archive`). Archive removes it from lists without deleting it; the API build labels the action **Archive**.
- The form saves the hand-in method and structured parent guide. Instructions may be blank when the title is enough.
- Parents see the teacher's name, hand-in method, and full guide. Learners see the teacher, hand-in method, and only the guide's `needs` and `minutes` fields.
- If the person also holds the **Communication** area (`canMessageClasses`), they can tick **Tell parents** to post an in-app class message at the same time.

## What is hidden on the API build, and why

`homeworkCapabilities()` and `canManageHomework()` in `packages/shared/src/capabilities.ts` handle the differences between Supabase and `apps/api`:

| Hidden on the API build | Missing or different in the API |
|---|---|
| Plain teachers without Academics area | `GET/POST /v1/tenants/{tenantId}/homework-items` require `resource.academics.read` / `resource.academics.write` |
| "Handed in" column & submission counts | no learner homework-submission endpoint yet |
| File and link attachments | attachment uploads wait on API object storage (A5 / FIG-1873) |
| Bloom AI homework drafting | AI drafting is not in the `bloom-school/1` contract (C13) |
| "Tell parents" checkbox (when user lacks Communication) | creating class announcements requires `resource.announcement.write` (Communication area) |

## How the model is mapped (`packages/shared/src/api/homeworkApi.ts`)

- `apiFetchMyHomework` loads `apiFetchTeacherClasses`, pages `GET /v1/tenants/{tenantId}/homework-items`, and keeps only homework whose `class_id` is one of the teacher's classes.
- `apiCreateHomework` resolves the school's current term via `apiFetchCurrentTerm`, validates the title and instructions, and sends the hand-in method and parent guide with the homework fields.
- `apiUpdateHomework` sends editable fields to `PATCH`; `apiArchiveHomework` calls the one-way archive route with an idempotency key.
- Teacher, parent, and learner adapters map the API's hand-in method and guide fields into the shared homework model. Learner reads expose only `needs` and `minutes` from the guide.
- `apiFetchHomeworkSubjectsForClass` resolves the signed-in teacher's own staff record via `GET /v1/tenants/{tenantId}/staff/me` and filters `GET /teaching-assignments` by `staff_member_id`, so an Academics-area teacher does not need `resource.staff.read`.

## API findings: homework (`homework-1` to `homework-4`)

`homework-1`. **Regular teachers cannot read or set homework on `apps/api`.** `GET /v1/tenants/{tenantId}/homework-items` and `POST /v1/tenants/{tenantId}/homework-items` check `resource.academics.read` / `resource.academics.write`, which the `teacher` role does not hold without the Academics admin area (`4cca` / `authorize.ts`). Either a teacher-scoped `/me/teaching/homework-items` route or teacher class-scoped permission on `/homework-items` would let regular teachers use `teacher/homework` without full school-wide Academics access.

`homework-2`. **Resolved in API PR #441.** `PATCH /v1/tenants/{tenantId}/homework-items/{homeworkId}` edits an item; the archive route removes it from lists without deleting it.

`homework-3`. **Resolved in API PR #441.** Homework supports optional instructions, `hand_in`, and `parent_guide`; the parent and learner family reads include their permitted fields.

`homework-4`. **No submission / handed-in counts for teachers.** `GET /homework-items` returns assignment metadata only, so the teacher view cannot display how many learners have handed work in.
