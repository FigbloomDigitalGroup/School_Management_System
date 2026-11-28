# Online exam paper editing and archive (W1.3)

W1.3 extends the existing online exam paper routes. It does not delete a paper or change the attempt and mark records.

- Migration 128 adds `online_exam_papers.archived_at` and allows column-scoped updates to `title`, `max_score`, `questions`, and `archived_at`. Existing `published_at` behavior and grants remain unchanged.
- `PATCH /v1/tenants/{tenantId}/online-exam-papers/{paperId}` edits title, score ceiling, and question set. Score ceiling and questions become immutable after the first attempt so saved answers, automatic marks, and existing score meaning stay stable; title remains editable.
- `POST .../{paperId}/archive` is idempotent, retains the paper, hides it from school, teacher, and learner lists, prevents publishing and new attempts, and leaves existing in-progress attempts finishable.
- Lifecycle audit events contain only the paper id and changed field names, not question text or answer keys. DELETE stays revoked.
