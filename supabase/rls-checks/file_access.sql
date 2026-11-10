-- file_access() must say exactly what the storage.objects policies say (20261110120000).
--
-- For every signed-in user of the two seeded schools (and any platform super admin), and a set of paths covering every folder the
-- rules know (each school's own and the other school's, a family's own learner and someone else's, and so on), this asks the real
-- policies by doing the thing as that user on storage.objects, and compares with file_access():
--   write    insert the object                        replace  update it (it exists)
--   read     can the user see it                      delete   delete it (it exists)
-- Every attempt is undone. Any disagreement prints FAIL with the user, path and both answers.
--
-- Runs against a local database with the migrations applied and `npm run db:seed` (and `npm run db:seed-org` for the second
-- school; without it only the first is covered), inside one transaction that is rolled back.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/file_access.sql

\set ON_ERROR_STOP 1
begin;
select set_config('storage.allow_delete_query', 'true', true);

-- ---------------------------------------------------------------- the people
create temp table fa_users as
  select p.id, p.role, p.tenant_id from profiles p
   where p.tenant_id in (select id from tenants where slug in ('alliance', 'kijani-ridge')) or p.role = 'super_admin';

-- ---------------------------------------------------------------- the paths
create temp table fa_paths (bucket text, path text, owner uuid);

create function pg_temp.add_paths(t uuid) returns void language plpgsql as $$
declare
  ts text := t::text;
  teacher uuid := (select id from profiles where tenant_id = t and role = 'teacher' order by id limit 1);
  admin uuid := (select id from profiles where tenant_id = t and role = 'school_admin' order by id limit 1);
  parent uuid := (select id from profiles where tenant_id = t and role = 'parent' order by id limit 1);
  learners uuid[] := array(
    select x from (
      (select g.student_id from guardians g join students s on s.id = g.student_id where s.tenant_id = t order by g.student_id limit 1)
      union (select id from students where tenant_id = t and profile_id is not null order by id limit 1)
      union (select s.id from students s join classes c on c.id = s.class_id where s.tenant_id = t and c.class_teacher_id is not null order by s.id limit 1)
      union (select id from students where tenant_id = t order by id desc limit 1)
    ) q(x));
  s uuid;
  r record;
begin
  -- public-assets
  insert into fa_paths values ('public-assets', ts || '/logo.png', admin), ('public-assets', ts || '/branding/crest.png', admin),
                              ('public-assets', ts || '/avatars/staff-' || teacher || '.jpg', teacher);
  for r in select id from profiles where tenant_id = t loop
    insert into fa_paths values ('public-assets', ts || '/avatars/staff-' || r.id || '.png', r.id);
  end loop;
  foreach s in array learners loop
    insert into fa_paths values ('public-assets', ts || '/avatars/students-' || s || '.jpg', admin),
                                ('public-assets', ts || '/avatars/students-' || s || '-2.jpg', admin);
    -- private-documents, per learner
    insert into fa_paths values ('private-documents', ts || '/students/' || s || '/birth.pdf', admin),
                                ('private-documents', ts || '/medical/' || s || '/form.pdf', admin),
                                ('private-documents', ts || '/submissions/hw1/' || s || '/answer.pdf', admin);
  end loop;
  for r in select i.id from fee_invoices i where i.tenant_id = t and i.student_id = any(learners) order by i.id limit 6 loop
    insert into fa_paths values ('private-documents', ts || '/invoices/' || r.id || '/proof.jpg', parent);
  end loop;
  insert into fa_paths values ('private-documents', ts || '/invoices/' || gen_random_uuid() || '/proof.jpg', parent);
  for r in select id from exam_papers where tenant_id = t order by id limit 3 loop
    insert into fa_paths values ('private-documents', ts || '/exam-papers/' || r.id || '/paper.pdf', teacher);
  end loop;
  insert into fa_paths values ('private-documents', ts || '/paper-imports/' || teacher || '/scan.pdf', teacher),
                              ('private-documents', ts || '/paper-imports/' || admin || '/scan.pdf', admin),
                              ('private-documents', ts || '/staff/contract.pdf', admin),
                              ('private-documents', ts || '/leave/' || teacher || '/note.pdf', teacher),
                              ('private-documents', ts || '/unknown/thing.pdf', admin),
                              ('private-documents', ts || '/toplevel.pdf', admin);
  -- chat-files: each conversation, uploaded by two different people
  for r in select id from conversations where tenant_id = t order by id limit 3 loop
    insert into fa_paths values ('chat-files', ts || '/' || r.id || '/by-teacher.pdf', teacher),
                                ('chat-files', ts || '/' || r.id || '/by-parent.pdf', parent);
  end loop;
  insert into fa_paths values ('chat-files', ts || '/' || gen_random_uuid() || '/f.pdf', parent);
  -- learning-media
  for r in (select 'materials' area, id from learning_materials where tenant_id = t order by id limit 3)
           union all (select 'announcements', id from announcements where tenant_id = t order by id limit 3)
           union all (select 'homework', id from assignments where tenant_id = t order by id limit 3) loop
    insert into fa_paths values ('learning-media', ts || '/' || r.area || '/' || r.id || '/file.mp4', teacher);
  end loop;
  insert into fa_paths values ('learning-media', ts || '/materials/' || gen_random_uuid() || '/file.mp4', teacher),
                              ('learning-media', ts || '/elsewhere/x/file.mp4', teacher);
end $$;

select pg_temp.add_paths(id) from tenants where slug in ('alliance', 'kijani-ridge');
delete from fa_paths where path is null;

-- ---------------------------------------------------------------- asking both
create temp table fa_out (op text, uid uuid, role text, bucket text, path text, policy boolean, fn boolean);
grant all on fa_out to authenticated;

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true)
$$;

-- Run a statement as the user; true when it changed exactly one row. Always undone.
create function pg_temp.changes_one(u uuid, stmt text) returns boolean language plpgsql as $$
declare n bigint; ok boolean := false;
begin
  begin
    perform pg_temp.as_user(u);
    set local role authenticated;
    execute stmt;
    get diagnostics n = row_count;
    ok := n = 1;
    reset role;
    raise exception using errcode = 'FA001';
  exception when others then
    reset role;
    if sqlstate <> 'FA001' then ok := false; end if;
  end;
  return ok;
end $$;

create function pg_temp.fn_says(u uuid, b text, p text, op text, o uuid) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform pg_temp.as_user(u);
  set local role authenticated;
  r := file_access(b, p, op, o);
  reset role;
  return coalesce(r, false);
end $$;

create function pg_temp.sees(u uuid, b text, p text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform pg_temp.as_user(u);
  set local role authenticated;
  select exists (select 1 from storage.objects where bucket_id = b and name = p) into r;
  reset role;
  return r;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare x record; u record;
begin
  for x in select * from fa_paths loop
    -- write: the object does not exist yet
    for u in select * from fa_users loop
      insert into fa_out values ('write', u.id, u.role, x.bucket, x.path,
        pg_temp.changes_one(u.id, format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', x.bucket, x.path, u.id)),
        pg_temp.fn_says(u.id, x.bucket, x.path, 'write', null));
    end loop;
    -- the object, as its uploader left it
    perform set_config('request.jwt.claims', '', true);
    insert into storage.objects (bucket_id, name, owner) values (x.bucket, x.path, x.owner);
    for u in select * from fa_users loop
      insert into fa_out values ('read', u.id, u.role, x.bucket, x.path,
        pg_temp.sees(u.id, x.bucket, x.path), pg_temp.fn_says(u.id, x.bucket, x.path, 'read', x.owner));
      insert into fa_out values ('replace', u.id, u.role, x.bucket, x.path,
        pg_temp.changes_one(u.id, format('update storage.objects set metadata = ''{}''::jsonb where bucket_id = %L and name = %L', x.bucket, x.path)),
        pg_temp.fn_says(u.id, x.bucket, x.path, 'replace', x.owner));
      insert into fa_out values ('delete', u.id, u.role, x.bucket, x.path,
        pg_temp.changes_one(u.id, format('delete from storage.objects where bucket_id = %L and name = %L', x.bucket, x.path)),
        pg_temp.fn_says(u.id, x.bucket, x.path, 'delete', x.owner));
    end loop;
    perform set_config('request.jwt.claims', '', true);
    delete from storage.objects where bucket_id = x.bucket and name = x.path;
  end loop;
end $$;

-- ---------------------------------------------------------------- the verdict
do $$
declare r record; total bigint; bad bigint; allowed bigint;
begin
  select count(*), count(*) filter (where policy) into total, allowed from fa_out;
  raise notice 'INFO % paths x % users: % decisions, % allowed by the policies',
    (select count(*) from fa_paths), (select count(*) from fa_users), total, allowed;
  if total < 1000 or allowed < 50 then
    raise notice 'FAIL the fixture is too thin to prove anything (% decisions, % allowed)', total, allowed;
  end if;
  for r in select op, count(*) n, count(*) filter (where policy is distinct from fn) d, count(*) filter (where policy) a
             from fa_out group by op order by op loop
    if r.d = 0 then raise notice 'PASS %: file_access agrees with the policies on all % (% allowed)', r.op, r.n, r.a;
    else raise notice 'FAIL %: % of % disagree', r.op, r.d, r.n; end if;
  end loop;
  for r in select * from fa_out where policy is distinct from fn order by op, bucket, path limit 25 loop
    raise notice 'FAIL   % % % %: policies say %, file_access says %', r.op, r.role, r.bucket, r.path, r.policy, r.fn;
  end loop;
end $$;

rollback;
