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
-- private-documents while Bloom reads it. Families can't read there
-- (private_docs_read, 20261021000001). Since 20261026070000 only the office
-- writes this bucket, plus a teacher writing an exam paper's own file, so the
-- policy below lets a member of staff write their own staging folder and
-- nothing else. The edge function only reads paths in the caller's own folder
-- and deletes each file once read.
--
-- 'chat' (Bloom chat, 20261027060000) stays in the check.

alter table ai_usage drop constraint ai_usage_task_check;
alter table ai_usage add constraint ai_usage_task_check
  check (task in ('report_comment', 'questions', 'homework', 'message', 'translate', 'tutor', 'chat', 'paper_import'));

create policy private_docs_staff_paper_imports_write on storage.objects for all
  using (
    bucket_id = 'private-documents'
    and is_staff()
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'paper-imports'
    and (storage.foldername(name))[3] = auth.uid()::text
  )
  with check (
    bucket_id = 'private-documents'
    and is_staff()
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'paper-imports'
    and (storage.foldername(name))[3] = auth.uid()::text
  );
