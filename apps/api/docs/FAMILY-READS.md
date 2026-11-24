# Family reads (A1, FIG-1869)

Written 2026-11-24, before the code. What a parent can read on the API about their own children, how the API decides that
a learner is "their own", and what is not built yet (student accounts).

## The problem

Until this work, a `parent` member could read only their identity, session, school and permissions, the transport family
read (`/me/transport`) and medication consent. `assertMayPayFor` refused everyone, so a parent could not pay. The web and
phone parent pages (13) and student pages (12) cannot move off Supabase until these reads exist.

## One rule decides "my child"

A learner is one of the caller's children **in the school of the request** only when all of these hold, at the moment of
the request (nothing is cached in the token):

| Check | Where it is stored | What breaks it |
|---|---|---|
| The caller has a live account link to a guardian record | `guardian_accounts.revoked_at IS NULL` (migration 073) | an administrator revokes the link; the parent's membership is archived (trigger revokes it) |
| The account is active | `users.status = 'active'` | the account is disabled |
| The caller is a `parent` member of this school | `school_memberships` (role `parent`, not archived) | the membership is archived |
| The guardian record is active | `guardians.active AND archived_at IS NULL` | the guardian record is archived |
| The guardian-learner relationship is live | `guardian_links.archived_at IS NULL` | the relationship is removed (or archived with the guardian) |
| The learner is active | `learners.active AND archived_at IS NULL` | the learner is archived |
| Same school | every row above has `tenant_id = app_current_tenant_id()` | the request names another school |

Links do not expire. Expiry belongs to the **invitation** (72 hours, migration 073): an expired or revoked invitation never
creates a link, so "an expired link" cannot exist. Revocation is final; relinking needs a new invitation.

The rule is one `SECURITY DEFINER` function, `family_my_children()` (migration 099), because `guardian_accounts` is
owner-only (the runtime role cannot read it). It takes no arguments: the user and the school come from the transaction
settings the API sets after it has authorised the request (`app_current_user_id()`, `app_current_tenant_id()`), so a
caller cannot ask about anyone else. It returns `(learner_id, guardian_id, relationship, is_primary_payer)`, one row per
learner. It is `STABLE`, `search_path = pg_catalog, pg_temp`, schema-qualified, `EXECUTE` for `figbloom_app` only. It is
stricter than the older `transport_my_children()` (086), which does not check the guardian record or the account status;
that function is left as it is (its users are not part of this change).

In the API (`src/modules/family/children.ts`), every per-child endpoint first calls `assertMyChild(tx, learnerId)`. When the
learner is not in the set, the answer is **404 "Child not found"** for every cause (another family's child, another school's
learner, an archived learner, a revoked link, an id that does not exist), so the endpoint is not an oracle for learner ids.
The refusal is audited as `family.child.denied` (actor, school, learner id), written after the rollback like a permission
denial.

### Permission

A new catalogue permission, `resource.family.read` ("Read own linked children's records"), is granted to the `parent` role
(and to `super_admin`, which holds every catalogued permission; a super administrator has no parent membership, so the
link rule gives them no children). Every family endpoint requires it with `requirePermission`, so a teacher or school
administrator gets the usual audited 403 before any link check. It is not implied by any admin area and cannot be
delegated.

### Database defence

No new table is created and no grant is widened. The reads use tables the runtime role can already `SELECT` under the
forced tenant policy (`tenant_id = app_current_tenant_id()`), so RLS still confines every statement to the school of the
request. The per-child filter (`learner_id = <verified child>`) is application code, as for every other read in the API
(RLS here is a tenant boundary, not a per-person one). The one exception that is per person in the database is the link
itself, which only the definer function can read.

## Endpoints

All are `GET` under `/v1/tenants/{tenantId}`, tenant from the path (it must equal the session's school or the
`X-Tenant-Id` the caller proves), bearer session, `resource.family.read`. Per-child paths take `{learnerId}` and run the
link check first. Money is in minor units (cents), in the same form as the finance endpoints; dates are `YYYY-MM-DD`;
times are ISO 8601.

| Path | Returns | Published-only rule |
|---|---|---|
| `/me/children` | the caller's children in this school: `learner_id, full_name, admission_no, boarding, relationship, is_primary_payer, class` (the current-year class: `id, name, form_level, stream`, or `null`) | none (the list is the link set) |
| `/me/children/{learnerId}/attendance?from&to` | morning and afternoon marks (`date, session, mark`), counts per mark, and early sign-outs that were not voided (`date, signed_out_at, reason, collected_by_name, collected_by_relationship`). Default window: the current term (or the last 90 days when no term is current); at most 366 days | a register mark exists only once taken |
| `/me/children/{learnerId}/results?termId` | the child's own marks on **published or closed** assessments: `assessment_id, title, kind, subject, term, max_score, score, grade, published_at, class_mean` (`class_mean` only when at least 3 learners have a mark, so a mean cannot reveal one other child's score); CBE results on published or closed CBE assessments: `title, learning_area, strand, level_code, points, teacher_feedback` | assessment `status IN ('published','closed')`; draft marks never appear |
| `/me/children/{learnerId}/report-cards` | the newest published report card per term and class that the child belongs to, with **only the child's own slice** of the snapshot (`sum, count, average, grade`, CBE results, competency ratings) plus term and class names | report-card publications exist only once published |
| `/me/children/{learnerId}/homework?from` | homework for the child's classes this academic year, due on or after `from` (default 21 days ago): `title, body, due_on, subject, term_id` | homework has no draft state in the API |
| `/me/children/{learnerId}/materials` | learning materials registered for the child's classes this year: `title, description, subject, created_at, storage_status` (files are metadata only until storage, A5) | materials have no draft state in the API |
| `/me/children/{learnerId}/timetable` | the newest **published** timetable of the child's current class: slots `day_of_week, starts_at, ends_at, subject, room, teacher` (teacher = staff record name) | `timetable_publications.status = 'published'` |
| `/me/children/{learnerId}/fees` | the child's invoices (newest first, at most 50): totals (`lines, charges, adjustments, total, paid, balance`), `due_on`, term, voided flag, lines (`name, amount`), charges that were not voided (`amount, reason, created_at`), payments (`amount, method, status, mpesa_receipt, reference, created_at, completed_at`; **no phone number**: a payment made by another guardian must not show their phone), payment proofs (`status, txn_code, txn_amount, rejection_reason, submitted_at`) | none |
| `/me/children/{learnerId}/activities` | the child's clubs and teams: `name, category, meeting_schedule, active, role, joined_on, patrons (names)` | inactive activities are shown with `active: false` |
| `/me/children/{learnerId}/items` | items issued to the child: `item name, category, asset_tag, quantity, issued_at, due_on, status, closed_at, returned_condition` | none |
| `/me/children/{learnerId}/health` | the health profile (`blood_group, allergies, chronic_conditions, dietary_notes, emergency_notes`), medication authorizations (with consent status, so the parent can consent through the existing consent endpoint), active schedules, administrations of the last 60 days, sick-bay visits (newest 100) | none |
| `/me/chat-contacts` | who the parent may start a chat with: the school's administrators and the teachers of their children's current classes (`user_id, full_name, role, reason`) | none |

Bus: `/me/transport` and `/me/transport/notifications` (migration 086) already serve the bus page and are not changed.

Every list has a fixed cap so a response stays bounded: results 500 marks and 500 CBE results (newest first; `termId`
narrows), fees 50 invoices, homework, materials, activities, items and medication authorizations and schedules 200,
administrations 500 (last 60 days), sick-bay visits 100. There is no paging on these reads: one child's lists are small.

### Changes to existing behaviour (said plainly)

1. **Paying** (`assertMayPayFor`, `src/modules/finance/payer.ts`): allowed when the caller is a `parent` member and the
   learner is in `family_my_children()`. Any linked guardian may pay, as in the legacy app (`paysFor`: any guardian row);
   `is_primary_payer` is returned for display, not enforced. Everyone else stays 403 with the same message. This opens,
   for linked parents only, the routes that already call it: the M-Pesa prompt, the invoice PDF, submitting a payment
   proof, and the AI-helper opt-in. The M-Pesa and PayHero provider code is not touched.
2. **Announcements inbox** (`communications_audience_reaches`, replaced in migration 099): a `class` audience now also
   reaches a parent whose child has an active membership in that class, and a `form_level` audience a parent whose child is
   in an active current-year class of that level. Every other kind is unchanged, and a staff member's reach is unchanged.
3. **Chat** (`may_talk`, replaced in migration 099): a parent may also talk with a teacher who teaches one of their
   children (class teacher, or an active teaching assignment, of an active class the child is an active member of). The
   parent-to-administrator rule and the staff-to-staff rule are unchanged; parent-to-parent stays refused. A teacher
   needs a staff record linked to their account (`staff_members.user_id`) to be reachable, as for announcements.

## Tests (negative first)

`test/family.reads.test.ts` runs every endpoint through the real `figbloom_app` login and proves, for each per-child path:

- the parent's own child: 200 with the child's data only (another learner of the same class never appears, including in
  report-card snapshots and class means);
- another family's child in the same school: 404;
- a learner of another school (by id, and with the other school in `X-Tenant-Id`): 404 / 403;
- a revoked account link, an archived guardian-learner relationship, an archived guardian record, an archived learner, an
  archived parent membership, a disabled account: 404 (or 401 for the disabled account);
- a teacher and a school administrator: 403 (no `resource.family.read`);
- draft assessments, draft timetables and voided charges never appear;
- `assertMayPayFor`: linked parent allowed, unlinked parent, teacher and revoked link refused.

The function inventory (`securityDefiner.test.ts`), the permission registry, the RBAC matrix (via the OpenAPI
annotations), and the RLS catalogue are updated in the same change.

## Student accounts (A4): not built, needs a decision

The API has a `student` role in its enum and a login-id sign-in, but **no link from a sign-in to a learner record**:
`learners` has no `user_id`, there is no `learner_accounts` table, and no flow creates a `student` membership (staff
invitations allow only `school_admin, teacher, staff, driver`; guardian invitations make `parent`). In the legacy app the
`provision-student` edge function creates a `role='student'` profile and sets `students.profile_id`.

What a student account needs, which is larger than this slice and has owner decisions in it:

1. A link table like `guardian_accounts` (owner-only, one live login per learner, revocable, revoked when the learner or
   the membership is archived) and a definer `student_my_learner()`.
2. A provisioning flow: who creates the login (school administrator), how the first password reaches a child with no
   e-mail (login id `ST-0001` plus a handed-out password with `must_change_password`), and resets by the school.
3. Policy: session length and idle timeout for children, MFA (off for children?), whether a student may chat and with
   whom, what a student may see that a parent may not (online exam papers and attempts), and whether students pay.
4. Then the student pages reuse the same per-learner reads as above, through `student_my_learner()` instead of
   `family_my_children()`.

Decision needed from the owner on point 2 and 3 before building. Until then the student pages stay on Supabase.

## Not in this change

- Writes a parent makes on Supabase today (mark homework done, mark a notice read in bulk, sign documents, request a
  medication, bio-data change requests, set the home address): not part of A1.
- Files (homework attachments, materials, proof uploads): wait on storage (A5, FIG-1873).
- Medical notices to guardians (`medical_notices`): the sick-bay module does not emit them yet (`guardian_notices_available:
  false`); the health read shows visits instead.
- Report-card export (PDF) for a parent: the existing export is per class (all learners), so it is not opened to parents.
- Push for a `class` or `form_level` announcement: the worker's eligibility count
  (`communications_announcement_push_eligible_count`, 063) still counts only whole-school, role, user and people
  audiences, for staff and parents alike. The in-app inbox reach above is what changed.
