-- Online exam paper edits and non-destructive retirement (W1.3, docs/EXAM-PAPERS.md).
-- Keep the published_at behavior from migration 110; existing attempts remain attached and finishable.

ALTER TABLE online_exam_papers
  ADD COLUMN archived_at timestamptz;

GRANT UPDATE (title, max_score, questions, archived_at)
  ON online_exam_papers TO figbloom_app;
