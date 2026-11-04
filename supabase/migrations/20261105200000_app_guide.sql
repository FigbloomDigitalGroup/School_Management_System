-- The Figbloom guide: an AI helper in every console (organization admins,
-- school admins, teachers and other staff) that answers "how do I…" and
-- "where is…" with steps and links to the pages the person can open. For a
-- full school admin it can also propose setting up the school's structure
-- (classes, subjects, a term, exams, fee items); the admin's own browser
-- applies a plan once they confirm it, under their own row-level security,
-- and the audit triggers (20261104000000) log every row as theirs.
--
-- The guide never adds or changes people: names and phone numbers never go
-- to the AI provider. The edge function refuses a message with a phone
-- number in it and is told never to ask for names; the setup snapshot it
-- sends holds no person at all (no class teachers, no learners, no staff).
--
-- Schema: the new task in the usage log, and room for an organization admin
-- using the guide in their organization console, where there is no school:
-- such a row names the organization instead. It counts against the person's
-- daily cap only; a school's monthly allowance (ai_month_tokens) still sums
-- that school's rows, so nothing here changes what a school is charged.
-- As before, ai_usage records who, which task and how many tokens, never the
-- question or the reply.

alter table ai_usage drop constraint ai_usage_task_check;
alter table ai_usage add constraint ai_usage_task_check
  check (task in ('report_comment', 'questions', 'homework', 'message', 'translate', 'tutor', 'chat', 'paper_import', 'guide'));

alter table ai_usage alter column tenant_id drop not null;
alter table ai_usage add column organization_id uuid references organizations on delete cascade;
alter table ai_usage add constraint ai_usage_school_or_organization
  check (tenant_id is not null or organization_id is not null);
