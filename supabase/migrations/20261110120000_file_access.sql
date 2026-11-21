-- Who may read, write, replace or delete a stored file, as one function (step 1 of moving files off Supabase Storage to S3).
--
-- Today the rules live as 22 row-security policies on storage.objects, which only Supabase Storage consults. The files API that
-- hands out S3 links (figbloom-platform, services/schools-files) must apply exactly the same rules, and they must stay in one
-- place, so this function restates them. supabase/rls-checks/file_access.sql proves it agrees with the policies, user by user and
-- path by path, until the policies are dropped with Supabase Storage.
--
--   file_access(bucket, path, op, owner)
--     op     'read' | 'write' (a new file) | 'replace' (overwrite) | 'delete'
--     owner  who uploaded the file, where a rule needs it (deleting a chat file); null when not known
--
-- It runs as the caller (security invoker), so auth.uid(), my_tenant() and the row security on the tables it reads are the
-- caller's, as they are inside a policy. Postgres applies a table's SELECT policies to an UPDATE or DELETE as well, so 'replace' and
-- 'delete' also need 'read'. The two restrictive policies (a payment proof is never replaced or deleted) win over every grant.
--
-- Paths are split here rather than with storage.foldername()/storage.filename(), so the function keeps working once the database
-- leaves Supabase. Same meaning: the folders are every segment but the last; the file name is the last.

create or replace function file_folder(p_path text, p_n int) returns text
language sql immutable as $$
  select case when p_n >= 1 and p_n < coalesce(array_length(string_to_array(p_path, '/'), 1), 0)
              then (string_to_array(p_path, '/'))[p_n] end
$$;

create or replace function file_name_of(p_path text) returns text
language sql immutable as $$
  select (string_to_array(p_path, '/'))[array_length(string_to_array(p_path, '/'), 1)]
$$;

-- A folder that should be a school id, or null (a policy's ::uuid cast would raise and so refuse; null refuses too).
create or replace function file_tenant(p_path text) returns uuid
language sql immutable as $$
  select case when file_folder(p_path, 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then file_folder(p_path, 1)::uuid end
$$;

-- ---------------------------------------------------------------- one grant per policy, by bucket
create or replace function file_may_read(p_bucket text, p_path text) returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare
  f1 text := file_folder(p_path, 1);
  f2 text := file_folder(p_path, 2);
  f3 text := file_folder(p_path, 3);
  f4 text := file_folder(p_path, 4);
  me text := my_tenant()::text;
begin
  if auth.uid() is null then return false; end if;
  case p_bucket
  when 'public-assets' then
    return is_super() or f1 = me                                           -- public_assets_read
        or file_may_change_public_asset(p_path);                           -- public_assets_own_avatar, public_assets_write (for all)
  when 'chat-files' then
    return coalesce(chat_file_readable(f1, f2), false);                    -- chat_files_read
  when 'learning-media' then
    return coalesce(learning_media_admin(f1), false)                       -- learning_media_read
        or coalesce(learning_media_readable(f1, f2, f3), false);
  when 'private-documents' then
    return is_super()                                                      -- private_docs_read
        or coalesce(has_perm(file_tenant(p_path), private_doc_area(f2)), false)      -- (and private_docs_office_write, for all)
        or (f1 = me and (
              (is_staff() and f2 = 'submissions')
           or (f2 = 'students' and f3 in (select id.id::text from my_family_students() id(id)))
           or (f2 = 'submissions' and f4 in (select id.id::text from my_family_students() id(id)))
           or (f2 = 'invoices' and exists (select 1 from fee_invoices i
                                            where i.id::text = f3 and i.student_id in (select my_family_students())))
           ))
        or (f1 = me and f2 = 'exam-papers' and coalesce(exam_paper_file_open_to_me(f3), false))         -- private_docs_exam_papers_read
        or (f1 = me and f2 = 'medical'                                                                    -- private_docs_medical_guardian_read
            and exists (select 1 from guardians g where g.student_id::text = f3 and g.profile_id = auth.uid()))
        or file_may_change_private_doc(p_path);                            -- staff_paper_imports, teacher_exam_papers (for all)
  else
    return false;
  end case;
end $$;

-- The "for all" policies of public-assets: they grant read, write, replace and delete alike.
create or replace function file_may_change_public_asset(p_path text) returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare
  f1 text := file_folder(p_path, 1);
  f2 text := file_folder(p_path, 2);
  me text := my_tenant()::text;
  fname text := file_name_of(p_path);
begin
  if auth.uid() is null then return false; end if;
  return (f1 = me and f2 = 'avatars' and fname like 'staff-' || auth.uid()::text || '.%')          -- public_assets_own_avatar
      or is_super()                                                                                -- public_assets_write
      or coalesce(may_administer(file_tenant(p_path)), false)
      or (coalesce(has_perm(file_tenant(p_path), 'people'), false) and f2 = 'avatars')
      or (f1 = me and f2 = 'avatars' and my_role() = 'teacher'
          and exists (select 1 from students s join classes c on c.id = s.class_id
                       where c.class_teacher_id = auth.uid()
                         and s.id::text = substring(fname from '^students-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})([.-]|$)')));
end $$;

-- The "for all" policies of private-documents: the office's area, a staff member's own paper imports, an exam paper's files.
create or replace function file_may_change_private_doc(p_path text) returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare
  f1 text := file_folder(p_path, 1);
  f2 text := file_folder(p_path, 2);
  f3 text := file_folder(p_path, 3);
  me text := my_tenant()::text;
begin
  if auth.uid() is null then return false; end if;
  return coalesce(has_perm(file_tenant(p_path), private_doc_area(f2)), false)                      -- private_docs_office_write
      or (is_staff() and f1 = me and f2 = 'paper-imports' and f3 = auth.uid()::text)                -- private_docs_staff_paper_imports_write
      or (f1 = me and f2 = 'exam-papers' and coalesce(exam_paper_file_writable_by_me(f3), false));  -- private_docs_teacher_exam_papers_write
end $$;

-- ---------------------------------------------------------------- the one entry point
create or replace function file_access(p_bucket text, p_path text, p_op text, p_owner uuid default null) returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare
  f1 text := file_folder(p_path, 1);
  f2 text := file_folder(p_path, 2);
  f3 text := file_folder(p_path, 3);
  f4 text := file_folder(p_path, 4);
  me text := my_tenant()::text;
  -- The restrictive policies say not (bucket = 'private-documents' and foldername[2] = 'invoices'). With no second folder that is
  -- null, and a restrictive policy that is null refuses: so a private document with fewer than two folders can't be replaced or
  -- deleted either.
  is_proof boolean := p_bucket = 'private-documents' and (f2 is null or f2 = 'invoices');
begin
  if auth.uid() is null or p_path is null or p_path = '' then return false; end if;

  case p_op
  when 'read' then
    return file_may_read(p_bucket, p_path);

  when 'write' then
    case p_bucket
    when 'public-assets' then return file_may_change_public_asset(p_path);
    when 'chat-files' then return coalesce(chat_file_writable(f1, f2), false);                     -- chat_files_insert
    when 'learning-media' then return coalesce(learning_media_writable(f1, f2, f3), false);        -- learning_media_insert
    when 'private-documents' then
      return file_may_change_private_doc(p_path)
          or (f1 = me and f2 = 'invoices' and exists (                                             -- private_docs_guardian_proof_write
                select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
                 where i.id::text = f3 and g.profile_id = auth.uid()))
          or (f1 = me and f2 = 'invoices' and exists (                                             -- private_docs_student_proof_write
                select 1 from fee_invoices i join students s on s.id = i.student_id
                 where i.id::text = f3 and s.profile_id = auth.uid()))
          or (f1 = me and f2 = 'submissions' and exists (                                          -- private_docs_student_submission_write
                select 1 from students s where s.id::text = f4 and s.profile_id = auth.uid()))
          or (f1 = me and f2 = 'medical' and exists (                                              -- private_docs_medical_guardian_write
                select 1 from guardians g where g.student_id::text = f3 and g.profile_id = auth.uid()));
    else return false;
    end case;

  when 'replace' then
    if is_proof then return false; end if;                                                         -- private_docs_proofs_not_replaced
    if not file_may_read(p_bucket, p_path) then return false; end if;
    case p_bucket
    when 'public-assets' then return file_may_change_public_asset(p_path);
    when 'learning-media' then return coalesce(learning_media_writable(f1, f2, f3), false);        -- learning_media_update
    when 'private-documents' then return file_may_change_private_doc(p_path);
    else return false;                                                                             -- chat files are never replaced
    end case;

  when 'delete' then
    if is_proof then return false; end if;                                                         -- private_docs_proofs_kept
    if not file_may_read(p_bucket, p_path) then return false; end if;
    case p_bucket
    when 'public-assets' then return file_may_change_public_asset(p_path);
    when 'chat-files' then                                                                         -- chat_files_delete: own, not yet sent
      return p_owner is not null and p_owner = auth.uid()
         and not exists (select 1 from chat_messages m where m.file_path = p_path);
    when 'learning-media' then
      return coalesce(learning_media_admin(f1), false) or coalesce(learning_media_writable(f1, f2, f3), false);
    when 'private-documents' then return file_may_change_private_doc(p_path);
    else return false;
    end case;

  else
    return false;
  end case;
end $$;

revoke execute on function file_access(text, text, text, uuid) from public, anon;
grant execute on function file_access(text, text, text, uuid) to authenticated, service_role;
