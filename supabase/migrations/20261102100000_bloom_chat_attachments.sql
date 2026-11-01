-- Bloom chat takes files with a question: a Google Doc, Sheet, PDF, Word or
-- text file the person picks from their Google Drive in the web app. The
-- ai-assist edge function reads the file for the model with that one
-- question and keeps nothing, as before (ai_usage still logs who, task and
-- tokens only).
--
--   ai_chat_messages.attachments   the names of the files sent with a
--                                  question, so the saved chat shows
--                                  "📎 Lesson plan.docx". Never their content:
--                                  school documents stay in the person's own
--                                  Drive, not in Figbloom. Null when none.
--
-- Written by the app as the person, like the message itself, under the same
-- ai_chat_messages_own policy (20261027060000): only the chat's owner reads
-- or writes it. At most three names (the app's and the edge function's cap),
-- each short, and only on a question.

alter table ai_chat_messages
  add column attachments text[]
    check (
      attachments is null
      or (role = 'user'
          and cardinality(attachments) between 1 and 3
          and array_position(attachments, null) is null
          and char_length(array_to_string(attachments, '')) <= 600)
    );
