-- Chat: two-way conversations between families and the school.
--
-- Announcements (and a teacher's class Messages) only go one way. This adds
-- one-to-one chats, always with a parent on one side:
--
--   parent <-> their own child       (a learner with an account)
--   parent <-> a teacher of a child  (teaches the child's class, is its class
--                                     teacher, or runs a section the child is
--                                     enrolled on)
--   parent <-> the school office     (any school_admin: principal, deputy, bursar)
--
-- Learners do not chat with teachers one-to-one: teachers reach a class
-- through Messages and homework, and the school keeps adult-to-child
-- conversations in those open channels. Staff-to-staff chat is out of scope.
--
-- Every rule is checked here, not in the app: chat_pair_allowed() decides
-- who may talk to whom, start_conversation() is the only way a conversation
-- is created, and a message can only be sent while the pair is still allowed
-- (a teacher moved off a class can read the old thread but not add to it).
--
-- The school's administrators (may_administer: school_admin, org_admin
-- acting for the school, super_admin) can read every conversation in the
-- school, read-only. The app tells participants so on every thread.
--
--   conversations         one per pair of people (pair_key), never per child:
--                         a parent with two children has one thread with the
--                         principal, not two
--   conversation_members  the two people, and how far each has read
--   chat_messages         text and/or one file; never edited or deleted, so
--                         what the office reads is what was sent
--
-- Files go in their own private bucket, chat-files, at
-- <tenant>/<conversation>/<file>. Push for a new message is sent by the
-- chat-push edge function, which the web app calls after sending.

-- ---------------------------------------------------------------- bucket
-- 50 MB: the hosted project's upload cap (apps/web/src/lib/uploadLimit.ts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-files', 'chat-files', false,
  52428800,
  array[
    -- documents
    'application/pdf', 'text/plain', 'text/csv', 'application/rtf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
    -- pictures
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    -- video
    'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
    -- sound (voice notes)
    'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/webm'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------- tables
create table conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants on delete cascade,
  -- least(a, b) || ':' || greatest(a, b): one conversation per pair, whoever starts it
  pair_key        text not null unique,
  created_by      uuid references profiles on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  last_message_at timestamptz
);
create index on conversations (tenant_id, last_message_at desc nulls last);

create table conversation_members (
  conversation_id uuid not null references conversations on delete cascade,
  profile_id      uuid not null references profiles on delete cascade,
  tenant_id       uuid not null references tenants on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, profile_id)
);
create index on conversation_members (profile_id);

create table chat_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants on delete cascade,
  conversation_id uuid not null references conversations on delete cascade,
  sender_id       uuid references profiles on delete set null default auth.uid(),
  body            text check (body is null or char_length(body) <= 4000),
  file_path       text,
  file_name       text check (char_length(file_name) <= 255),
  mime_type       text check (char_length(mime_type) <= 255),
  size_bytes      bigint check (size_bytes >= 0),
  created_at      timestamptz not null default now(),
  -- something to say, a file, or both
  check (nullif(trim(coalesce(body, '')), '') is not null or file_path is not null),
  check ((file_path is null) = (file_name is null) and (file_path is null) = (mime_type is null) and (file_path is null) = (size_bytes is null)),
  -- the file sits under this conversation's own folder, which is what the storage policy reads
  check (file_path is null or file_path like tenant_id::text || '/' || conversation_id::text || '/%')
);
create index on chat_messages (conversation_id, created_at);
create index on chat_messages (tenant_id, created_at desc);

-- ---------------------------------------------------------------- who may talk to whom
-- Security definer so these don't depend on the read policies of the tables
-- they look at (a parent can't read teaching_assignments rows for other classes).

-- Teaches this (current) learner: their class, as class teacher, or a section they're on.
create or replace function chat_teaches_student(p_teacher uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from students s
     where s.id = p_student and s.active
       and (
         exists (select 1 from teaching_assignments ta where ta.teacher_id = p_teacher and ta.class_id = s.class_id)
         or exists (select 1 from classes c where c.id = s.class_id and c.class_teacher_id = p_teacher)
         or exists (select 1 from enrollments e join course_sections cs on cs.id = e.course_section_id
                     where e.student_id = s.id and e.status = 'enrolled' and cs.instructor_id = p_teacher)
       )
  )
$$;

-- The one rule. Order doesn't matter: (a, b) and (b, a) give the same answer.
create or replace function chat_pair_allowed(p_a uuid, p_b uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_role_a   app_role;
  v_role_b   app_role;
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_parent   uuid;
  v_other    uuid;
  v_role     app_role;
begin
  if p_a is null or p_b is null or p_a = p_b then return false; end if;
  select role, tenant_id into v_role_a, v_tenant_a from profiles where id = p_a;
  select role, tenant_id into v_role_b, v_tenant_b from profiles where id = p_b;
  if v_tenant_a is null or v_tenant_a is distinct from v_tenant_b then return false; end if;

  -- Every pairing has a parent on one side.
  if v_role_a = 'parent' then
    v_parent := p_a; v_other := p_b; v_role := v_role_b;
  elsif v_role_b = 'parent' then
    v_parent := p_b; v_other := p_a; v_role := v_role_a;
  else
    return false;
  end if;

  return case v_role
    when 'school_admin' then true
    when 'student' then exists (
      select 1 from guardians g join students s on s.id = g.student_id
       where g.profile_id = v_parent and s.profile_id = v_other and s.active)
    when 'teacher' then exists (
      select 1 from guardians g where g.profile_id = v_parent and chat_teaches_student(v_other, g.student_id))
    else false
  end;
end $$;

create or replace function is_conversation_member(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from conversation_members m where m.conversation_id = p_conversation_id and m.profile_id = auth.uid())
$$;

-- Its two people, or the school's administrators (read-only for them).
create or replace function may_read_conversation(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_conversation_member(p_conversation_id)
      or exists (select 1 from conversations c where c.id = p_conversation_id and may_administer(c.tenant_id))
$$;

-- A member, while the pair is still allowed to talk.
create or replace function may_post_in(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversation_members other
     where other.conversation_id = p_conversation_id
       and other.profile_id <> auth.uid()
       and is_conversation_member(p_conversation_id)
       and chat_pair_allowed(auth.uid(), other.profile_id)
  )
$$;

revoke execute on function chat_teaches_student(uuid, uuid) from public, anon;
revoke execute on function chat_pair_allowed(uuid, uuid) from public, anon;
revoke execute on function is_conversation_member(uuid) from public, anon;
revoke execute on function may_read_conversation(uuid) from public, anon;
revoke execute on function may_post_in(uuid) from public, anon;
grant execute on function chat_teaches_student(uuid, uuid) to authenticated;
grant execute on function chat_pair_allowed(uuid, uuid) to authenticated;
grant execute on function is_conversation_member(uuid) to authenticated;
grant execute on function may_read_conversation(uuid) to authenticated;
grant execute on function may_post_in(uuid) to authenticated;

-- ---------------------------------------------------------------- row-level security
alter table conversations enable row level security;
alter table conversation_members enable row level security;
alter table chat_messages enable row level security;

-- No insert/update/delete policies on conversations or members: they are
-- created by start_conversation() and read-marked by mark_conversation_read().
create policy conversations_read on conversations for select
  using (may_read_conversation(id));
create policy conversation_members_read on conversation_members for select
  using (may_read_conversation(conversation_id));

create policy chat_messages_read on chat_messages for select
  using (may_read_conversation(conversation_id));
-- Insert only; a sent message is never changed or removed.
create policy chat_messages_send on chat_messages for insert
  with check (sender_id = auth.uid() and may_post_in(conversation_id));

-- The school, sender and time come from the server; the conversation's
-- last_message_at and the sender's read mark move with each message.
create or replace function chat_messages_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.tenant_id := (select tenant_id from conversations where id = new.conversation_id);
  if new.tenant_id is null then
    raise exception 'That conversation could not be found.' using errcode = '23503';
  end if;
  new.sender_id := coalesce(auth.uid(), new.sender_id);
  new.created_at := now();
  new.body := nullif(trim(coalesce(new.body, '')), '');
  return new;
end $$;
create trigger chat_messages_stamp before insert on chat_messages
  for each row execute function chat_messages_stamp();

create or replace function chat_messages_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  update conversation_members set last_read_at = new.created_at
   where conversation_id = new.conversation_id and profile_id = new.sender_id;
  return null;
end $$;
create trigger chat_messages_after after insert on chat_messages
  for each row execute function chat_messages_after();

alter publication supabase_realtime add table chat_messages;

-- ---------------------------------------------------------------- functions the app calls

-- Opens the caller's conversation with this person, creating it the first time.
create or replace function start_conversation(p_other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_key    text;
  v_id     uuid;
  v_tenant uuid;
begin
  if not chat_pair_allowed(auth.uid(), p_other) then
    raise exception 'You can''t start a chat with that person.' using errcode = '42501';
  end if;
  v_key := least(auth.uid(), p_other)::text || ':' || greatest(auth.uid(), p_other)::text;
  select id into v_id from conversations where pair_key = v_key;
  if v_id is not null then return v_id; end if;

  v_tenant := my_tenant();
  insert into conversations (tenant_id, pair_key, created_by)
  values (v_tenant, v_key, auth.uid())
  on conflict (pair_key) do nothing
  returning id into v_id;
  -- two people starting the same chat at once: the other insert won
  if v_id is null then
    select id into v_id from conversations where pair_key = v_key;
    return v_id;
  end if;
  insert into conversation_members (conversation_id, profile_id, tenant_id)
  values (v_id, auth.uid(), v_tenant), (v_id, p_other, v_tenant);
  return v_id;
end $$;

create or replace function mark_conversation_read(p_conversation_id uuid) returns void
language sql security definer set search_path = public as $$
  update conversation_members set last_read_at = now()
   where conversation_id = p_conversation_id and profile_id = auth.uid()
$$;

-- Messages from others the caller hasn't read yet, across all their chats: the sidebar badge.
create or replace function my_chat_unread_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int
    from conversation_members me
    join chat_messages m on m.conversation_id = me.conversation_id
   where me.profile_id = auth.uid()
     and m.sender_id is distinct from auth.uid()
     and m.created_at > me.last_read_at
$$;

-- Everyone the caller may start a chat with, with one line saying why
-- ("Amani's class teacher", "Mathematics, Amani's teacher", "Parent of Baraka").
create or replace function my_chat_contacts()
returns table (profile_id uuid, full_name text, role text, avatar_url text, detail text)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as id, my_role() as role, my_tenant() as tenant_id),
  candidates as (
    -- parent: their children who have accounts
    select s.profile_id as id, 'Your child' as why
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
     where me.role = 'parent' and s.profile_id is not null and s.active
    union all
    -- parent: their children's subject teachers
    select ta.teacher_id, format('%s, %s''s teacher', sub.name, split_part(trim(s.full_name), ' ', 1))
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
      join teaching_assignments ta on ta.class_id = s.class_id join subjects sub on sub.id = ta.subject_id
     where me.role = 'parent' and s.active
    union all
    -- parent: their children's class teachers
    select c.class_teacher_id, format('%s''s class teacher', split_part(trim(s.full_name), ' ', 1))
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
      join classes c on c.id = s.class_id
     where me.role = 'parent' and s.active and c.class_teacher_id is not null
    union all
    -- parent: their children's lecturers (higher-ed sections)
    select cs.instructor_id, format('%s, %s''s lecturer', co.name, split_part(trim(s.full_name), ' ', 1))
      from me join guardians g on g.profile_id = me.id join students s on s.id = g.student_id
      join enrollments e on e.student_id = s.id and e.status = 'enrolled'
      join course_sections cs on cs.id = e.course_section_id join courses co on co.id = cs.course_id
     where me.role = 'parent' and s.active and cs.instructor_id is not null
    union all
    -- parent: the school office
    select p.id, coalesce(p.staff_title, 'School office')
      from me join profiles p on p.tenant_id = me.tenant_id and p.role = 'school_admin'
     where me.role = 'parent'
    union all
    -- learner: their own parents
    select g.profile_id, format('Your %s', g.relationship)
      from me join students s on s.profile_id = me.id join guardians g on g.student_id = s.id
     where me.role = 'student'
    union all
    -- teacher: parents of the learners they teach
    select g.profile_id, format('Parent of %s (%s)', s.full_name, c.name)
      from me join students s on s.tenant_id = me.tenant_id and s.active
      join classes c on c.id = s.class_id
      join guardians g on g.student_id = s.id
     where me.role = 'teacher' and chat_teaches_student(me.id, s.id)
    union all
    -- office: every parent in the school
    select g.profile_id, format('Parent of %s (%s)', s.full_name, c.name)
      from me join students s on s.tenant_id = me.tenant_id and s.active
      join classes c on c.id = s.class_id
      join guardians g on g.student_id = s.id
     where me.role = 'school_admin'
  )
  select p.id, p.full_name, p.role::text, p.avatar_url, string_agg(distinct c.why, ' · ')
    from candidates c join profiles p on p.id = c.id
   where c.id is not null and c.id <> auth.uid() and chat_pair_allowed(auth.uid(), c.id)
   group by p.id, p.full_name, p.role, p.avatar_url
   order by p.full_name
$$;

-- The caller's own chats, newest first, with the other person and the unread count.
create or replace function my_conversations()
returns table (
  conversation_id uuid, other_id uuid, other_name text, other_role text, other_avatar_url text,
  last_message_at timestamptz, last_body text, last_sender_id uuid, unread int, can_reply boolean
)
language sql stable security definer set search_path = public as $$
  select c.id, o.profile_id, p.full_name, p.role::text, p.avatar_url,
         c.last_message_at, coalesce(last.body, last.file_name), last.sender_id,
         (select count(*)::int from chat_messages m
           where m.conversation_id = c.id and m.sender_id is distinct from auth.uid() and m.created_at > me.last_read_at),
         chat_pair_allowed(auth.uid(), o.profile_id)
    from conversation_members me
    join conversations c on c.id = me.conversation_id
    join conversation_members o on o.conversation_id = c.id and o.profile_id <> me.profile_id
    join profiles p on p.id = o.profile_id
    left join lateral (
      select m.body, m.file_name, m.sender_id from chat_messages m
       where m.conversation_id = c.id order by m.created_at desc limit 1
    ) last on true
   where me.profile_id = auth.uid()
   order by c.last_message_at desc nulls last, c.created_at desc
$$;

-- Both people in a conversation the caller may read: names for the thread header and bubbles.
create or replace function conversation_people(p_conversation_id uuid)
returns table (profile_id uuid, full_name text, role text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role::text, p.avatar_url
    from conversation_members m join profiles p on p.id = m.profile_id
   where m.conversation_id = p_conversation_id and may_read_conversation(p_conversation_id)
   order by p.full_name
$$;

-- The office's view of every chat in the school, optionally only those
-- about one learner (the learner themselves, or one of their guardians, is in it).
create or replace function school_conversations(p_tenant_id uuid, p_student_id uuid default null)
returns table (
  conversation_id uuid,
  a_id uuid, a_name text, a_role text,
  b_id uuid, b_name text, b_role text,
  last_message_at timestamptz, message_count int, last_body text
)
language sql stable security definer set search_path = public as $$
  select c.id,
         pa.id, pa.full_name, pa.role::text,
         pb.id, pb.full_name, pb.role::text,
         c.last_message_at,
         (select count(*)::int from chat_messages m where m.conversation_id = c.id),
         (select coalesce(m.body, m.file_name) from chat_messages m where m.conversation_id = c.id order by m.created_at desc limit 1)
    from conversations c
    join lateral (
      select array_agg(m.profile_id order by m.profile_id) as ids from conversation_members m where m.conversation_id = c.id
    ) mem on true
    join profiles pa on pa.id = mem.ids[1]
    join profiles pb on pb.id = mem.ids[2]
   where c.tenant_id = p_tenant_id
     and may_administer(p_tenant_id)
     and c.last_message_at is not null
     and (
       p_student_id is null
       or exists (
         select 1 from students s
          where s.id = p_student_id and s.tenant_id = p_tenant_id
            and (s.profile_id = any (mem.ids)
                 or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = any (mem.ids)))
       )
     )
   order by c.last_message_at desc
$$;

revoke execute on function start_conversation(uuid) from public, anon;
revoke execute on function mark_conversation_read(uuid) from public, anon;
revoke execute on function my_chat_unread_count() from public, anon;
revoke execute on function my_chat_contacts() from public, anon;
revoke execute on function my_conversations() from public, anon;
revoke execute on function conversation_people(uuid) from public, anon;
revoke execute on function school_conversations(uuid, uuid) from public, anon;
grant execute on function start_conversation(uuid) to authenticated;
grant execute on function mark_conversation_read(uuid) to authenticated;
grant execute on function my_chat_unread_count() to authenticated;
grant execute on function my_chat_contacts() to authenticated;
grant execute on function my_conversations() to authenticated;
grant execute on function conversation_people(uuid) to authenticated;
grant execute on function school_conversations(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- storage
-- <tenant>/<conversation>/<file>. Segments are compared as text, so a stray
-- non-uuid folder can never make a policy throw. Files go up before their
-- message is sent, so writing needs the same right as sending.

create or replace function chat_file_readable(p_tenant text, p_conversation text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from conversations c
                  where c.id::text = p_conversation and c.tenant_id::text = p_tenant and may_read_conversation(c.id))
$$;

create or replace function chat_file_writable(p_tenant text, p_conversation text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from conversations c
                  where c.id::text = p_conversation and c.tenant_id::text = p_tenant and may_post_in(c.id))
$$;

revoke execute on function chat_file_readable(text, text) from public, anon;
revoke execute on function chat_file_writable(text, text) from public, anon;
grant execute on function chat_file_readable(text, text) to authenticated;
grant execute on function chat_file_writable(text, text) to authenticated;

create policy chat_files_read on storage.objects for select
  using (bucket_id = 'chat-files' and chat_file_readable((storage.foldername(name))[1], (storage.foldername(name))[2]));

create policy chat_files_insert on storage.objects for insert
  with check (bucket_id = 'chat-files' and chat_file_writable((storage.foldername(name))[1], (storage.foldername(name))[2]));

-- Only the uploader, and only to take back a file whose message never got sent.
create policy chat_files_delete on storage.objects for delete
  using (
    bucket_id = 'chat-files' and owner = auth.uid()
    and not exists (select 1 from chat_messages m where m.file_path = storage.objects.name)
  );

-- ---------------------------------------------------------------- push preference
-- chat-push skips anyone who turned this off; no row = on.
alter table notification_preferences add column chat_messages boolean not null default true;
