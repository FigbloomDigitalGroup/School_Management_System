-- Checks for 20261124500000_perf_round2:
--
-- * the set-returning functions the activity policies now use give exactly the answers of
--   may_manage_activity and may_manage_activity_event, for every kind of caller and every
--   activity and event, and the activity policies no longer call a permission function per row:
--
--     may_manage_activity(a)        = a in my_managed_activity_ids()
--     may_manage_activity_event(e)  = e in my_managed_activity_event_ids()
--
-- * my_students() and my_family_students(), rewritten to read each branch by index, return the
--   same learners as their previous bodies (kept below as pg_temp.old_*) for every kind of caller.
--
-- Makes its own schools and people (no seed needed) inside one transaction that is rolled back.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/perf_round2.sql

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;

create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_id, 'activities-opq-' || p_id || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
end $$;

-- Every activity and event of the check schools (and a null and an unknown id), old way and new.
create function pg_temp.mismatches(p_uid uuid) returns table (what text, id uuid, old boolean, new boolean)
language plpgsql as $$
declare
  acts uuid[];
  evs uuid[];
begin
  select array_agg(a.id) || array[null::uuid, gen_random_uuid()] into acts
    from activities a join tenants t on t.id = a.tenant_id where t.name like 'Activities OPQ %';
  select array_agg(e.id) || array[null::uuid, gen_random_uuid()] into evs
    from activity_events e join tenants t on t.id = e.tenant_id where t.name like 'Activities OPQ %';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  return query
    select 'may_manage_activity', a, may_manage_activity(a), coalesce(a in (select my_managed_activity_ids()), false)
      from unnest(acts) a
     where may_manage_activity(a) is distinct from coalesce(a in (select my_managed_activity_ids()), false)
    union all
    select 'may_manage_activity_event', e, may_manage_activity_event(e), coalesce(e in (select my_managed_activity_event_ids()), false)
      from unnest(evs) e
     where may_manage_activity_event(e) is distinct from coalesce(e in (select my_managed_activity_event_ids()), false);
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- How many check activities the caller may manage: proves the cases are not all "no".
create function pg_temp.managed(p_uid uuid) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from my_managed_activity_ids() m join activities a on a.id = m
    join tenants t on t.id = a.tenant_id where t.name like 'Activities OPQ %';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures
-- An active group owning schools A and B; a lone school C.
insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-0000000d0f01', 'Activities OPQ Group', 'aopq-group-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active');
insert into tenants (id, name, slug, county, organization_id) values
  ('00000000-0000-4000-8000-0000000d0a01', 'Activities OPQ School A', 'aopq-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-0000000d0f01'),
  ('00000000-0000-4000-8000-0000000d0a02', 'Activities OPQ School B', 'aopq-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-0000000d0f01');
insert into tenants (id, name, slug, county) values
  ('00000000-0000-4000-8000-0000000d0a03', 'Activities OPQ School C', 'aopq-c-' || substr(md5(random()::text), 1, 8), 'Nairobi');

select from pg_temp.person('00000000-0000-4000-8000-0000000d0b01', null, 'super_admin', 'AOPQ Super');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b02', '00000000-0000-4000-8000-0000000d0a01', 'school_admin', 'AOPQ Principal A');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b03', null, 'org_admin', 'AOPQ Group Admin');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b04', '00000000-0000-4000-8000-0000000d0a01', 'staff', 'AOPQ Games Master A');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b05', '00000000-0000-4000-8000-0000000d0a01', 'teacher', 'AOPQ Patron A');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b06', '00000000-0000-4000-8000-0000000d0a01', 'teacher', 'AOPQ Plain Teacher A');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b07', '00000000-0000-4000-8000-0000000d0a01', 'parent', 'AOPQ Parent A');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b08', '00000000-0000-4000-8000-0000000d0a01', 'student', 'AOPQ Learner A');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b09', '00000000-0000-4000-8000-0000000d0a03', 'teacher', 'AOPQ Patron C');
select from pg_temp.person('00000000-0000-4000-8000-0000000d0b0a', '00000000-0000-4000-8000-0000000d0a01', 'staff', 'AOPQ Staff Without Area A');

insert into organization_admins (profile_id, organization_id) values
  ('00000000-0000-4000-8000-0000000d0b03', '00000000-0000-4000-8000-0000000d0f01');
insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000d0b04', 'activities');

insert into activities (id, tenant_id, name, category) values
  ('00000000-0000-4000-8000-0000000d0c01', '00000000-0000-4000-8000-0000000d0a01', 'AOPQ Football', 'sport'),
  ('00000000-0000-4000-8000-0000000d0c02', '00000000-0000-4000-8000-0000000d0a01', 'AOPQ Chess', 'club'),
  ('00000000-0000-4000-8000-0000000d0c03', '00000000-0000-4000-8000-0000000d0a02', 'AOPQ Hockey', 'sport'),
  ('00000000-0000-4000-8000-0000000d0c04', '00000000-0000-4000-8000-0000000d0a03', 'AOPQ Drama', 'club');
-- patrons: A's teacher patrons football; C's teacher patrons drama (a trigger keeps patrons to
-- the school's teachers)
insert into activity_patrons (tenant_id, activity_id, teacher_id) values
  ('00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000d0c01', '00000000-0000-4000-8000-0000000d0b05'),
  ('00000000-0000-4000-8000-0000000d0a03', '00000000-0000-4000-8000-0000000d0c04', '00000000-0000-4000-8000-0000000d0b09');
insert into activity_events (id, tenant_id, activity_id, title, kind, starts_at) values
  ('00000000-0000-4000-8000-0000000d0e01', '00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000d0c01', 'AOPQ Match', 'fixture', now()),
  ('00000000-0000-4000-8000-0000000d0e02', '00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000d0c02', 'AOPQ Tournament', 'competition', now()),
  ('00000000-0000-4000-8000-0000000d0e03', '00000000-0000-4000-8000-0000000d0a02', '00000000-0000-4000-8000-0000000d0c03', 'AOPQ Hockey Match', 'fixture', now()),
  ('00000000-0000-4000-8000-0000000d0e04', '00000000-0000-4000-8000-0000000d0a03', '00000000-0000-4000-8000-0000000d0c04', 'AOPQ Play', 'performance', now());

-- learners: two in A (one with a login, one with the parent as guardian), one each in B and C
insert into classes (id, tenant_id, name, form_level) values
  ('00000000-0000-4000-8000-0000000d0d01', '00000000-0000-4000-8000-0000000d0a01', 'AOPQ 3 East', 3),
  ('00000000-0000-4000-8000-0000000d0d02', '00000000-0000-4000-8000-0000000d0a02', 'AOPQ 3 East', 3),
  ('00000000-0000-4000-8000-0000000d0d03', '00000000-0000-4000-8000-0000000d0a03', 'AOPQ 3 East', 3);
insert into students (id, tenant_id, full_name, admission_no, profile_id, class_id) values
  ('00000000-0000-4000-8000-0000000d0901', '00000000-0000-4000-8000-0000000d0a01', 'AOPQ Child One', 'AOPQ-1', '00000000-0000-4000-8000-0000000d0b08', '00000000-0000-4000-8000-0000000d0d01'),
  ('00000000-0000-4000-8000-0000000d0902', '00000000-0000-4000-8000-0000000d0a01', 'AOPQ Child Two', 'AOPQ-2', null, '00000000-0000-4000-8000-0000000d0d01'),
  ('00000000-0000-4000-8000-0000000d0903', '00000000-0000-4000-8000-0000000d0a02', 'AOPQ Child Three', 'AOPQ-3', null, '00000000-0000-4000-8000-0000000d0d02'),
  ('00000000-0000-4000-8000-0000000d0904', '00000000-0000-4000-8000-0000000d0a03', 'AOPQ Child Four', 'AOPQ-4', null, '00000000-0000-4000-8000-0000000d0d03');
insert into guardians (tenant_id, profile_id, student_id) values
  ('00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000d0b07', '00000000-0000-4000-8000-0000000d0902');

-- my_students() and my_family_students() as they were before 20261124500000.
create function pg_temp.old_my_students() returns setof uuid language sql stable as $$
  select s.id from students s
  where (
    s.tenant_id = my_tenant()
    and (
      is_staff()
      or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid())
      or s.profile_id = auth.uid()
    )
  )
  or (is_org_admin() and s.tenant_id in (select my_organization_tenant_ids()))
$$;
create function pg_temp.old_my_family_students() returns setof uuid language sql stable as $$
  select s.id from students s
  where (
    s.tenant_id = my_tenant()
    and (
      exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid())
      or s.profile_id = auth.uid()
    )
  )
  or (is_org_admin() and s.tenant_id in (select my_organization_tenant_ids()))
$$;

-- ---------------------------------------------------------------- the checks
-- (read as postgres, as the security-definer functions read: only the caller's identity is set)
do $$
declare
  r record;
  n_old bigint;
  n_new bigint;
  bad bigint;
begin
  for r in
    select * from (values
      ('platform super user',              '00000000-0000-4000-8000-0000000d0b01'::uuid, 0, 0),
      ('school admin',                     '00000000-0000-4000-8000-0000000d0b02', 2, 0),
      ('org admin acting for its schools', '00000000-0000-4000-8000-0000000d0b03', 3, 3),
      ('staff (not a teacher)',            '00000000-0000-4000-8000-0000000d0b04', 0, 0),
      ('teacher',                          '00000000-0000-4000-8000-0000000d0b06', 2, 0),
      ('parent',                           '00000000-0000-4000-8000-0000000d0b07', 1, 1),
      ('learner',                          '00000000-0000-4000-8000-0000000d0b08', 1, 1),
      ('teacher at another school',        '00000000-0000-4000-8000-0000000d0b09', 1, 0),
      ('signed in with no profile',        '00000000-0000-4000-8000-0000000d0bff', 0, 0),
      ('not signed in',                    null, 0, 0)
    ) v(label, uid, n_students, n_family)
  loop
    perform set_config('request.jwt.claims', coalesce(json_build_object('sub', r.uid, 'role', 'authenticated')::text, ''), true);
    select count(*) into bad from (
      (select * from pg_temp.old_my_students() except select * from my_students())
      union all (select * from my_students() except select * from pg_temp.old_my_students())) x;
    select count(*) into n_new from my_students() m join students s on s.id = m where s.admission_no like 'AOPQ-%';
    perform pg_temp.check('my_students() returns the same learners as before for: ' || r.label
                          || ' (' || bad || ' differ, ' || n_new || ' check learners)', bad = 0 and n_new = r.n_students);
    select count(*) into bad from (
      (select * from pg_temp.old_my_family_students() except select * from my_family_students())
      union all (select * from my_family_students() except select * from pg_temp.old_my_family_students())) x;
    select count(*) into n_new from my_family_students() m join students s on s.id = m where s.admission_no like 'AOPQ-%';
    perform pg_temp.check('my_family_students() returns the same learners as before for: ' || r.label
                          || ' (' || bad || ' differ, ' || n_new || ' check learners)', bad = 0 and n_new = r.n_family);
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

do $$
declare
  r record;
  bad bigint;
  first text;
begin
  for r in
    select * from (values
      ('platform super user',              '00000000-0000-4000-8000-0000000d0b01'::uuid),
      ('school admin',                     '00000000-0000-4000-8000-0000000d0b02'),
      ('org admin acting for its schools', '00000000-0000-4000-8000-0000000d0b03'),
      ('activities area holder (staff)',   '00000000-0000-4000-8000-0000000d0b04'),
      ('patron teacher',                   '00000000-0000-4000-8000-0000000d0b05'),
      ('plain teacher',                    '00000000-0000-4000-8000-0000000d0b06'),
      ('parent',                           '00000000-0000-4000-8000-0000000d0b07'),
      ('learner',                          '00000000-0000-4000-8000-0000000d0b08'),
      ('patron teacher at another school', '00000000-0000-4000-8000-0000000d0b09'),
      ('staff without the area',           '00000000-0000-4000-8000-0000000d0b0a'),
      ('signed in with no profile',        '00000000-0000-4000-8000-0000000d0bff'),
      ('not signed in',                    null)
    ) v(label, uid)
  loop
    select count(*), min(m.what || ' ' || coalesce(m.id::text, 'null')
                         || ' old=' || coalesce(m.old::text, 'null') || ' new=' || coalesce(m.new::text, 'null'))
      into bad, first
      from pg_temp.mismatches(r.uid) m;
    perform pg_temp.check('my_managed_activity_ids / my_managed_activity_event_ids agree with may_manage_activity / may_manage_activity_event for: '
                          || r.label || coalesce(' (' || bad || ' differ, e.g. ' || first || ')', ''), bad = 0);
  end loop;
end $$;

-- the cases above are not all "no"
select pg_temp.check('super manages every check activity', pg_temp.managed('00000000-0000-4000-8000-0000000d0b01') = 4);
select pg_temp.check('school admin manages school A''s two activities', pg_temp.managed('00000000-0000-4000-8000-0000000d0b02') = 2);
select pg_temp.check('org admin manages schools A and B''s three activities', pg_temp.managed('00000000-0000-4000-8000-0000000d0b03') = 3);
select pg_temp.check('activities area holder manages school A''s two activities', pg_temp.managed('00000000-0000-4000-8000-0000000d0b04') = 2);
select pg_temp.check('patron teacher manages only the activity they patron', pg_temp.managed('00000000-0000-4000-8000-0000000d0b05') = 1);
select pg_temp.check('plain teacher manages none', pg_temp.managed('00000000-0000-4000-8000-0000000d0b06') = 0);
select pg_temp.check('staff without the activities area manages none', pg_temp.managed('00000000-0000-4000-8000-0000000d0b0a') = 0);

-- the policies now use the sets, not the per-row calls
select pg_temp.check('the activity policies no longer call has_perm / may_manage_activity / may_manage_activity_event per row',
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('activities', 'activity_patrons', 'activity_events', 'activity_members', 'activity_event_participants')
       and (coalesce(qual, '') ~ '(has_perm|may_manage_activity|may_manage_activity_event)\('
            or coalesce(with_check, '') ~ '(has_perm|may_manage_activity|may_manage_activity_event)\(')));

rollback;
