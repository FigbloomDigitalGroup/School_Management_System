# API gap fixes: classes, subjects, teaching assignments, class memberships

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

An API-only change (migration 101). It closes findings 7 and 8 and most of finding 6. The web flags in `setupCapabilities()`
and `peopleCapabilities()` stay off until a small web PR gives the shared functions their API branch, so the "what the API
cannot do yet" tables for the setup screens and People still describe the web build.

| Now in the API | How |
|---|---|
| A learner goes back into a class they left this year (finding 7) | the unique index on (learner, class, year) is gone; one ACTIVE class per learner per year still holds (`class_memberships_learner_year_active_uidx`) |
| Archiving a learner ends their class membership (finding 8) | same transaction; restore does not give the class back, the school places the learner again |
| Edit a class, change or clear its class teacher, a class room | `PATCH /v1/tenants/{tenantId}/classes/{classId}` (name, level, year, pathway, stream, room, `class_teacher_staff_id`; the academic year cannot change); `room` on create and on every class read |
| Archive a class | `POST .../classes/{classId}/archive`: 409 while an active learner is in it; ends its teaching assignments; no restore yet |
| Edit a subject, its level, year range and core flag | `PATCH .../subjects/{subjectId}`; `education_level`, `min_form_level`, `max_form_level`, `is_core` on create and on every subject read |
| Change or clear a subject's teacher in a class | `PATCH .../teaching-assignments/{assignmentId}` (another teacher, same id) and `POST .../teaching-assignments/{assignmentId}/archive` |

All of them need `resource.academics.write` (the Academics area or a school administrator). Archiving a learner still
needs only `resource.learner.write`, so a People-only teacher's archive also ends the membership.

Not in this change: a bulk create for classes and subjects, deleting or archiving a subject, restoring a class, the bulk
marks write (A4), and teacher names for an Academics-only teacher (finding 5: it needs a decision on what such a teacher
may read about staff).

## API findings

- **gap-1. Restoring a learner does not put them back in a class.** The membership ended on archive stays ended; the school
  places the learner again (allowed now even in the same class). Memberships left active by archives made before
  migration 101 are not cleaned up by the migration; archiving their class ends them.
- **gap-2. An archived class cannot be restored**, and archiving one with active learners is refused. A move endpoint (or a
  bulk membership move) would let the web's "Promote" and "Delete class" work in one step.
