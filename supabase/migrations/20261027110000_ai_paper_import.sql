-- Bloom imports an existing exam paper: a teacher uploads a PDF, a Word file
-- or photos of a printed paper, and the ai-assist edge function reads it and
-- returns a draft online paper for the teacher to check in the paper editor.
-- Nothing is saved or published by the import itself; the teacher's own
-- Save / Publish (replace_exam_questions, 20261025030000) does that.
--
-- The only schema change is the new task in the usage log, so imports are
-- metered against the school's monthly allowance like every other task. As
-- before, ai_usage records who, which task and how many tokens, never the
-- document or the reply.
--
-- The file waits at <tenant>/paper-imports/<profile>/<file> in
-- private-documents while Bloom reads it: staff already write anywhere in
-- their school (private_docs_staff_write) and families can't read there
-- (private_docs_read, 20261021000001). The edge function only reads paths
-- in the caller's own folder and deletes each file once read.
--
-- Another branch (feature/ai-workspace) adds 'chat' to this same check.
-- Whichever of the two migrations lands second must list both.

alter table ai_usage drop constraint ai_usage_task_check;
alter table ai_usage add constraint ai_usage_task_check
  check (task in ('report_comment', 'questions', 'homework', 'message', 'translate', 'tutor', 'paper_import'));
