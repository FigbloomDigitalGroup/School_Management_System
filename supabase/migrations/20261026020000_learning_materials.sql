-- Learning materials, and files or links on announcements and homework.
--
--   learning_materials  a document, video, picture, recording or link a
--                       teacher shares with one class for one subject. A
--                       draft until published; learners and their parents
--                       see it from then on.
--   attachments         files and links on an announcement or a piece of
--                       homework. Whoever may read the announcement or the
--                       homework may read its attachments; whoever may change
--                       it may add and remove them.
--
-- A row is either an uploaded file (file_path, file_name, mime_type,
-- size_bytes) or a link (url, https only). Which video sites can be played in
-- the page (YouTube, Vimeo, Google Drive) is the app's business
-- (packages/shared/src/materials.ts); the database only insists on https.
--
-- Files go in a new private bucket, learning-media, so videos can be far
-- bigger than anything in private-documents:
--   <tenant>/materials/<material_id>/<file>
--   <tenant>/announcements/<announcement_id>/<file>
--   <tenant>/homework/<assignment_id>/<file>
-- The storage policies at the bottom read the row the path belongs to, so a
-- file is open to exactly the people its row is.
--
-- Big videos: file_size_limit below is 2 GB per file, but the hosted project
-- has its own global upload limit (Dashboard -> Storage -> Settings, "Upload
-- file size limit"), 50 MB by default. It has to be raised to match, and
-- anything over 50 MB needs a paid plan (Pro or above). Uploads over 6 MB go
-- through the resumable (TUS) endpoint: apps/web/src/lib/resumableUpload.ts.

-- ---------------------------------------------------------------- bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'learning-media', 'learning-media', false,
  2147483648, -- 2 GB
  array[
    -- documents
    'application/pdf', 'text/plain', 'text/csv', 'application/rtf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/zip', 'application/x-zip-compressed',
    -- pictures
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    -- video
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp', 'video/x-msvideo', 'video/ogg',
    -- sound
    'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------- tables
create table learning_materials (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  class_id     uuid not null references classes on delete cascade,
  subject_id   uuid not null references subjects on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 160),
  description  text not null default '' check (length(description) <= 4000),
  kind         text not null check (kind in ('document', 'video', 'image', 'audio', 'link')),
  -- an uploaded file ...
  file_path    text,
  file_name    text check (length(file_name) <= 255),
  mime_type    text check (length(mime_type) <= 255),
  size_bytes   bigint check (size_bytes >= 0),
  -- ... or a link
  url          text check (length(url) <= 2000 and url ~* '^https://[^\s/]+'),
  published_at timestamptz,
  created_by   uuid references profiles on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  check ((file_path is null) <> (url is null)),
  check ((file_path is null) = (file_name is null) and (file_path is null) = (mime_type is null) and (file_path is null) = (size_bytes is null)),
  check (kind <> 'link' or url is not null),
  -- the file sits under this row's own folder, which is what the storage policy reads
  check (file_path is null or file_path like tenant_id::text || '/materials/' || id::text || '/%')
);
create index on learning_materials (tenant_id, class_id);

create table attachments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants on delete cascade,
  -- exactly one owner
  announcement_id uuid references announcements on delete cascade,
  assignment_id   uuid references assignments on delete cascade,
  kind            text not null check (kind in ('document', 'video', 'image', 'audio', 'link')),
  title           text not null check (length(trim(title)) between 1 and 160),
  file_path       text,
  file_name       text check (length(file_name) <= 255),
  mime_type       text check (length(mime_type) <= 255),
  size_bytes      bigint check (size_bytes >= 0),
  url             text check (length(url) <= 2000 and url ~* '^https://[^\s/]+'),
  created_by      uuid references profiles on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  check (num_nonnulls(announcement_id, assignment_id) = 1),
  check ((file_path is null) <> (url is null)),
  check ((file_path is null) = (file_name is null) and (file_path is null) = (mime_type is null) and (file_path is null) = (size_bytes is null)),
  check (kind <> 'link' or url is not null),
  check (
    file_path is null
    or (announcement_id is not null and file_path like tenant_id::text || '/announcements/' || announcement_id::text || '/%')
    or (assignment_id is not null and file_path like tenant_id::text || '/homework/' || assignment_id::text || '/%')
  )
);
create index on attachments (announcement_id) where announcement_id is not null;
create index on attachments (assignment_id) where assignment_id is not null;

-- ---------------------------------------------------------------- who may do what
-- Security definer so the policies below don't depend on the read policies of
-- the tables they look at. my_family_class_ids() is from 20261025030000.

-- Staff who teach the material's class and subject, or run the school.
create or replace function may_edit_material(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select may_teach_class_subject(m.tenant_id, m.class_id, m.subject_id)
      from learning_materials m where m.id = p_id
  ), false)
$$;

-- Any staff member in the school (drafts included); a learner or parent of
-- the class once it is published.
create or replace function material_open_to_me(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from learning_materials m
     where m.id = p_id
       and (
         may_administer(m.tenant_id)
         or (m.tenant_id = my_tenant() and is_staff())
         or (m.tenant_id = my_tenant() and m.published_at is not null
             and m.class_id in (select my_family_class_ids()))
       )
  )
$$;

-- The same rule as assignment_read (20261023000000).
create or replace function may_read_assignment(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from assignments a
     where a.id = p_id
       and (
         may_administer(a.tenant_id)
         or (a.tenant_id = my_tenant() and (
               is_staff()
               or a.class_id in (select s.class_id from students s where s.id in (select my_students()))
             ))
       )
  )
$$;

-- The same rule as assignment_update / assignment_delete: the teacher who set it, or the office.
create or replace function may_change_assignment(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from assignments a
     where a.id = p_id
       and (
         may_administer(a.tenant_id)
         or (a.tenant_id = my_tenant() and my_role() = 'teacher' and a.set_by = auth.uid())
       )
  )
$$;

-- The same rule as announcement_read (20260916110000): staff see drafts,
-- everyone in the school sees what is published.
create or replace function may_read_announcement(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from announcements a
     where a.id = p_id
       and (
         may_administer(a.tenant_id)
         or (a.tenant_id = my_tenant() and (is_staff() or a.published_at is not null))
       )
  )
$$;

-- The office, or the teacher who wrote it. (announcement_write lets any
-- teacher change any announcement; files on someone else's notice are
-- deliberately narrower.)
create or replace function may_change_announcement(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from announcements a
     where a.id = p_id
       and (
         may_administer(a.tenant_id)
         or (a.tenant_id = my_tenant() and my_role() = 'teacher' and a.author_id = auth.uid())
       )
  )
$$;

revoke execute on function may_edit_material(uuid) from public, anon;
revoke execute on function material_open_to_me(uuid) from public, anon;
revoke execute on function may_read_assignment(uuid) from public, anon;
revoke execute on function may_change_assignment(uuid) from public, anon;
revoke execute on function may_read_announcement(uuid) from public, anon;
revoke execute on function may_change_announcement(uuid) from public, anon;
grant execute on function may_edit_material(uuid) to authenticated;
grant execute on function material_open_to_me(uuid) to authenticated;
grant execute on function may_read_assignment(uuid) to authenticated;
grant execute on function may_change_assignment(uuid) to authenticated;
grant execute on function may_read_announcement(uuid) to authenticated;
grant execute on function may_change_announcement(uuid) to authenticated;

-- ---------------------------------------------------------------- row-level security
alter table learning_materials enable row level security;
alter table attachments enable row level security;

create policy learning_materials_read on learning_materials for select
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and (
          is_staff()
          or (published_at is not null and class_id in (select my_family_class_ids()))
        ))
  );
create policy learning_materials_write on learning_materials for all
  using (may_teach_class_subject(tenant_id, class_id, subject_id))
  with check (may_teach_class_subject(tenant_id, class_id, subject_id));

create policy attachments_read on attachments for select
  using (
    case when announcement_id is not null then may_read_announcement(announcement_id)
         else may_read_assignment(assignment_id) end
  );
create policy attachments_write on attachments for all
  using (
    case when announcement_id is not null then may_change_announcement(announcement_id)
         else may_change_assignment(assignment_id) end
  )
  with check (
    case when announcement_id is not null then may_change_announcement(announcement_id)
         else may_change_assignment(assignment_id) end
  );

-- ---------------------------------------------------------------- consistency guards
-- The class and subject must belong to the material's school.
create or replace function learning_materials_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from classes where id = new.class_id and tenant_id = new.tenant_id)
     or not exists (select 1 from subjects where id = new.subject_id and tenant_id = new.tenant_id) then
    raise exception 'That class or subject belongs to another school.' using errcode = '42501';
  end if;
  -- The file is fixed once uploaded: to change it, remove the material and add it again.
  if tg_op = 'UPDATE' and (new.file_path is distinct from old.file_path or new.id <> old.id or new.tenant_id <> old.tenant_id) then
    raise exception 'A material''s file can''t be swapped. Remove it and add the new one.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger learning_materials_consistent before insert or update on learning_materials
  for each row execute function learning_materials_consistent();

-- An attachment always carries its owner's school, whatever the client sent,
-- and never moves to another owner.
create or replace function attachments_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.announcement_id is distinct from old.announcement_id
                           or new.assignment_id is distinct from old.assignment_id
                           or new.file_path is distinct from old.file_path) then
    raise exception 'An attachment can''t be moved or have its file swapped. Remove it and add it again.' using errcode = '22023';
  end if;
  new.tenant_id := coalesce(
    (select tenant_id from announcements where id = new.announcement_id),
    (select tenant_id from assignments where id = new.assignment_id)
  );
  if new.tenant_id is null then
    raise exception 'That announcement or homework could not be found.' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger attachments_consistent before insert or update on attachments
  for each row execute function attachments_consistent();

-- ---------------------------------------------------------------- storage
-- <tenant>/<materials|announcements|homework>/<row id>/<file>. Segments are
-- compared as text, so a stray non-uuid folder can never make a policy throw.

-- May this user read files under this folder?
create or replace function learning_media_readable(p_tenant text, p_area text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_area
    when 'materials' then exists (select 1 from learning_materials m
                                   where m.id::text = p_id and m.tenant_id::text = p_tenant and material_open_to_me(m.id))
    when 'announcements' then exists (select 1 from announcements a
                                       where a.id::text = p_id and a.tenant_id::text = p_tenant and may_read_announcement(a.id))
    when 'homework' then exists (select 1 from assignments a
                                  where a.id::text = p_id and a.tenant_id::text = p_tenant and may_read_assignment(a.id))
    else false
  end
$$;

-- May this user put files under (or remove them from) this folder? The row
-- comes first: a material is saved as a draft before its file goes up, and
-- an announcement or homework exists before anything is attached to it.
create or replace function learning_media_writable(p_tenant text, p_area text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_area
    when 'materials' then exists (select 1 from learning_materials m
                                   where m.id::text = p_id and m.tenant_id::text = p_tenant and may_edit_material(m.id))
    when 'announcements' then exists (select 1 from announcements a
                                       where a.id::text = p_id and a.tenant_id::text = p_tenant and may_change_announcement(a.id))
    when 'homework' then exists (select 1 from assignments a
                                  where a.id::text = p_id and a.tenant_id::text = p_tenant and may_change_assignment(a.id))
    else false
  end
$$;

-- The office can tidy up any file in its school, e.g. one left behind when
-- its homework was deleted.
create or replace function learning_media_admin(p_tenant text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenants t where t.id::text = p_tenant and may_administer(t.id))
$$;

revoke execute on function learning_media_readable(text, text, text) from public, anon;
revoke execute on function learning_media_writable(text, text, text) from public, anon;
revoke execute on function learning_media_admin(text) from public, anon;
grant execute on function learning_media_readable(text, text, text) to authenticated;
grant execute on function learning_media_writable(text, text, text) to authenticated;
grant execute on function learning_media_admin(text) to authenticated;

create policy learning_media_read on storage.objects for select
  using (
    bucket_id = 'learning-media'
    and (
      learning_media_admin((storage.foldername(name))[1])
      or learning_media_readable((storage.foldername(name))[1], (storage.foldername(name))[2], (storage.foldername(name))[3])
    )
  );

create policy learning_media_insert on storage.objects for insert
  with check (
    bucket_id = 'learning-media'
    and learning_media_writable((storage.foldername(name))[1], (storage.foldername(name))[2], (storage.foldername(name))[3])
  );

create policy learning_media_update on storage.objects for update
  using (
    bucket_id = 'learning-media'
    and learning_media_writable((storage.foldername(name))[1], (storage.foldername(name))[2], (storage.foldername(name))[3])
  )
  with check (
    bucket_id = 'learning-media'
    and learning_media_writable((storage.foldername(name))[1], (storage.foldername(name))[2], (storage.foldername(name))[3])
  );

create policy learning_media_delete on storage.objects for delete
  using (
    bucket_id = 'learning-media'
    and (
      learning_media_admin((storage.foldername(name))[1])
      or learning_media_writable((storage.foldername(name))[1], (storage.foldername(name))[2], (storage.foldername(name))[3])
    )
  );

-- ---------------------------------------------------------------- audit
-- Publishing puts something in front of every family in a class, so it's
-- worth a line in the school's log, like releasing exam results.
create or replace function learning_materials_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.published_at is not null and (tg_op = 'INSERT' or old.published_at is null) then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (new.tenant_id, auth.uid(), my_actor_label(),
            format('Learning material "%s" published', new.title), 'academic',
            jsonb_build_object('material_id', new.id, 'class_id', new.class_id, 'subject_id', new.subject_id));
  end if;
  return null;
end $$;
create trigger learning_materials_audit after insert or update of published_at on learning_materials
  for each row execute function learning_materials_audit();
