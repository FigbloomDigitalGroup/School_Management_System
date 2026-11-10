-- An anonymous request to these tables and to storage failed instead of coming back empty.
--
-- 33 policies were created without a TO clause, so they apply to every role,
-- anon included. Each one calls a helper that is revoked from anon
-- (may_read_conversation, marks_published, exam_paper_file_open_to_me, ...).
-- Postgres evaluates every policy that applies to the caller, so an anonymous
-- caller hit "permission denied for function ..." the moment the policy was
-- evaluated:
--
--   GET /rest/v1/marks                       401 permission denied for function marks_published
--   POST /storage/v1/object/list/<any bucket>  403 permission denied for function exam_paper_file_open_to_me
--
-- Nothing leaked (the request fails), but the storage one broke every anonymous
-- storage query whatever the bucket, it showed internal function names to
-- anyone, and it stopped supabase/rls-checks/tenant_isolation.sql at its
-- anonymous section.
--
-- Every one of these policies needs a signed-in user to pass (the helpers read
-- my_tenant(), my_students() or the caller's profile), so anon never could have
-- matched. Scoping them to authenticated changes nothing for a signed-in user;
-- for anon it turns the error into the ordinary empty result or RLS refusal.
-- ALTER POLICY changes only the roles, not the expressions.
--
-- Check it with the query at the top of the anonymous section of
-- supabase/rls-checks/tenant_isolation.sql: any policy that reaches anon and
-- depends on a function anon cannot run is a failure. New policies that call a
-- helper revoked from anon need `to authenticated` from the start.

-- ------------------------------------------------------------ public tables
alter policy activities_update                   on activities                   to authenticated;
alter policy activity_event_participants_write   on activity_event_participants  to authenticated;
alter policy activity_events_write               on activity_events              to authenticated;
alter policy activity_members_write              on activity_members             to authenticated;

alter policy announcement_insert                 on announcements                to authenticated;
alter policy announcement_read                   on announcements                to authenticated;
alter policy announcement_update                 on announcements                to authenticated;

alter policy assignment_insert                   on assignments                  to authenticated;
alter policy assignment_update                   on assignments                  to authenticated;

alter policy attachments_read                    on attachments                  to authenticated;
alter policy attachments_write                   on attachments                  to authenticated;

alter policy chat_messages_read                  on chat_messages                to authenticated;
alter policy chat_messages_send                  on chat_messages                to authenticated;
alter policy conversation_members_read           on conversation_members         to authenticated;
alter policy conversations_read                  on conversations                to authenticated;

alter policy exam_attempts_read                  on exam_attempts                to authenticated;
alter policy exam_paper_texts_read               on exam_paper_texts             to authenticated;
alter policy exam_paper_texts_write              on exam_paper_texts             to authenticated;
alter policy exam_papers_read                    on exam_papers                  to authenticated;
alter policy exam_papers_write                   on exam_papers                  to authenticated;
alter policy exam_question_keys_all              on exam_question_keys           to authenticated;
alter policy exam_questions_read                 on exam_questions               to authenticated;
alter policy exam_questions_write                on exam_questions               to authenticated;

alter policy learning_materials_read             on learning_materials           to authenticated;
alter policy learning_materials_write            on learning_materials           to authenticated;

alter policy mark_read                           on marks                        to authenticated;

-- ------------------------------------------------------------ storage
alter policy chat_files_insert                   on storage.objects              to authenticated;
alter policy chat_files_read                     on storage.objects              to authenticated;
alter policy learning_media_delete               on storage.objects              to authenticated;
alter policy learning_media_insert               on storage.objects              to authenticated;
alter policy learning_media_read                 on storage.objects              to authenticated;
alter policy learning_media_update               on storage.objects              to authenticated;
alter policy private_docs_exam_papers_read       on storage.objects              to authenticated;
