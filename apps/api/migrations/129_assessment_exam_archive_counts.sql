-- Exam rename/archive and mark counts (W1.5, docs/EXAMS.md).

ALTER TABLE assessments
  ADD COLUMN archived_at timestamptz;

GRANT UPDATE (title, archived_at)
  ON assessments TO figbloom_app;
