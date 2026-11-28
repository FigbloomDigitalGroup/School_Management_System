# Exam rename, archive and mark counts (W1.5)

W1.5 extends the existing numeric assessment resource and leaves CBE assessments and homework assignments unchanged.

- Migration 129 adds `assessments.archived_at` and UPDATE grants only for `title` and `archived_at`; current status, publication, and version grants remain intact.
- `PATCH /v1/tenants/{tenantId}/assessments/{assessmentId}` renames records whose `kind` is `exam`. Marks, status, and published report-card snapshots do not change.
- `POST .../{assessmentId}/archive` is idempotent and soft archives exam-kind rows. Active lists, family result reads, new report-card source sets, and summary counts omit archived exams. Stored marks and already-published report-card snapshots remain.
- Archived exams cannot receive new marks or corrections. Mark correction history remains append-only. DELETE remains revoked.
- `marks_entered` on active assessment rows is the number of stored mark entries and is backed by the existing `(tenant_id, assessment_id)` index.
