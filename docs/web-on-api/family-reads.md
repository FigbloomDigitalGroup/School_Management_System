# Family reads (API side of A1, FIG-1869)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.


The API now has the reads the parent pages need (PR #359; design and rules in `apps/api/docs/FAMILY-READS.md`). No parent
or student page is ported yet: the web slices come after this merges.

- `GET /v1/tenants/{t}/me/children`: the parent's own children in that school, with each child's current class.
- Per child, `GET /v1/tenants/{t}/me/children/{learnerId}/…`: `attendance`, `results`, `report-cards`, `homework`,
  `materials`, `timetable`, `fees`, `activities`, `items`, `health`. Any learner who is not the caller's child is a 404.
- `GET /v1/tenants/{t}/me/chat-contacts`: who a parent may start a chat with.
- Bus: the existing `/me/transport`.
- Paying (M-Pesa prompt, invoice PDF, payment proof, AI-helper opt-in) now works for a parent whose account link reaches
  the learner. Class and form-level notices now reach the parents of children in them, and a parent may chat with their
  child's teachers.
- All of them need permission `resource.family.read`, which only parents hold.

Things found while doing it:

14. **Learners have no sign-in on the API** (A4). There is no link from an account to a learner record and no flow that
    makes a `student` membership. It needs owner decisions first (who makes the login, how a child without e-mail gets
    a password, session length, MFA, chat); see "Student accounts" in `apps/api/docs/FAMILY-READS.md`. The student
    pages stay on Supabase until then.
15. **Sick-bay notices to guardians are never written.** `medical_notices` exists and parents could read it, but the
    sick-bay module still reports `guardian_notices_available: false` and emits none. The family health read shows the
    visits instead.
16. **Push for class and form-level announcements counts nobody.** The worker's eligibility count covers only
    whole-school, role, user and people audiences (migration 063), for staff and parents alike.
