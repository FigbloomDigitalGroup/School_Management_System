-- Bloom chat: a ChatGPT-style workspace for the office and teachers.
--
-- The model call is the ai-assist edge function's new "chat" task, metered
-- and switched off exactly like the drafting tasks (tenants.ai_enabled, the
-- monthly allowance, the daily cap). This migration adds two things:
--
--   ai_usage.task 'chat'   so the function can log it
--   ai_chats               a staff member's own saved conversations, and
--   ai_chat_messages       their turns
--
-- ai_usage still never holds a prompt or a reply, and the edge function
-- still stores nothing. A chat history is a separate store the person keeps
-- for themselves: the app writes it as them, and only they can read, rename
-- or delete it. Not the office, not an org admin, not Figbloom staff
-- (is_super() is deliberately absent from these policies): a teacher's
-- scratch work with an assistant is theirs, like their own notes. Deleting a
-- chat deletes its messages; deleting the account deletes both.

alter table ai_usage drop constraint ai_usage_task_check;
alter table ai_usage add constraint ai_usage_task_check
  check (task in ('report_comment', 'questions', 'homework', 'message', 'translate', 'tutor', 'chat'));

create table ai_chats (
  id          uuid primary key default gen_random_uuid(),
  -- the school the chat was had in; an org admin's chats are filed under the school they were acting in
  tenant_id   uuid not null references tenants on delete cascade,
  profile_id  uuid not null references profiles on delete cascade default auth.uid(),
  title       text not null default 'New chat' check (char_length(title) between 1 and 120),
  created_at  timestamptz not null default now(),
  -- bumped by every new message, so the sidebar lists the latest first
  updated_at  timestamptz not null default now()
);
create index on ai_chats (profile_id, updated_at desc);

create table ai_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references ai_chats on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  -- a question is capped at 12,000 characters by the edge function; a reply
  -- can run to the model's 16,000 output tokens
  content     text not null check (char_length(content) between 1 and 100000),
  created_at  timestamptz not null default now()
);
create index on ai_chat_messages (chat_id, created_at);

alter table ai_chats enable row level security;
alter table ai_chat_messages enable row level security;

-- Staff only (the office, teachers, an org admin acting in a member school),
-- and only in a school they belong to or administer.
create or replace function may_keep_ai_chat(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (p_tenant_id = my_tenant() and my_role() in ('school_admin', 'teacher'))
      or (is_org_admin() and p_tenant_id in (select my_organization_tenant_ids()))
$$;

create policy ai_chats_own on ai_chats for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid() and may_keep_ai_chat(tenant_id));

-- Messages follow their chat: whoever owns the chat owns its turns.
create or replace function owns_ai_chat(p_chat_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from ai_chats c where c.id = p_chat_id and c.profile_id = auth.uid())
$$;

create policy ai_chat_messages_own on ai_chat_messages for all
  using (owns_ai_chat(chat_id))
  with check (owns_ai_chat(chat_id));

-- A chat can't be handed to someone else or moved to another school.
create or replace function ai_chats_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if NEW.profile_id <> OLD.profile_id or NEW.tenant_id <> OLD.tenant_id then
    raise exception 'A chat cannot be moved to another person or school' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

create trigger ai_chats_stamp before update on ai_chats
  for each row execute function ai_chats_stamp();

create or replace function ai_chat_messages_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update ai_chats set updated_at = now() where id = NEW.chat_id;
  return NEW;
end;
$$;

create trigger ai_chat_messages_touch after insert on ai_chat_messages
  for each row execute function ai_chat_messages_touch();
