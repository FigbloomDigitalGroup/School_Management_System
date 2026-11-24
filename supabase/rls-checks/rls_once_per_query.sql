-- Checks for 20261124300000_rls_once_per_query: the set-returning permission functions the
-- policies now use give exactly the answers of has_perm, has_office_perm, may_administer,
-- is_guardian_of and may_assess, for every kind of caller, every school and every area.
--
--   has_perm(t, a)        = is_super() or t in my_perm_tenant_ids(a)
--   has_office_perm(t)    = is_super() or t in my_office_tenant_ids()
--   may_administer(t)     = is_super() or t in my_administered_tenant_ids()
--   is_guardian_of(s)     = s in my_guardian_student_ids()
--   may_assess(t, c, s)   = has_perm(t, 'academics') or (t = my_tenant() and my_role() = 'teacher'
--                           and (c, s) in my_teaching_pairs())
--
-- Makes its own schools and people (no seed needed) inside one transaction that is rolled back.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/rls_once_per_query.sql

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;

create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_id, 'once-per-query-' || p_id || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
end $$;

-- Every (caller, school, area) answer, old way and new way. Returns the mismatches.
create function pg_temp.mismatches(p_uid uuid) returns table (what text, tenant uuid, area text, old boolean, new boolean)
language plpgsql as $$
declare
  areas text[] := array['people', 'fees', 'academics', 'attendance', 'communication', 'inventory',
                        'medical', 'visitors', 'activities', 'leave', 'audit', 'no-such-area', null];
  schools uuid[];
  kids uuid[];
  pairs text[];  -- 'tenant class subject', every class x subject of the check schools
begin
  select array_agg(id) || array[null::uuid, gen_random_uuid()] into schools
    from tenants where name like 'Once Per Query %';
  -- read as postgres, before taking the caller's role
  select array_agg(id) into kids from students where tenant_id = any(schools);
  select array_agg(c.tenant_id || ' ' || c.id || ' ' || sb.id) into pairs
    from classes c join subjects sb on true where c.tenant_id = any(schools) and sb.tenant_id = any(schools);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  return query
    select 'has_perm', t, a, has_perm(t, a),
           coalesce(is_super() or t in (select my_perm_tenant_ids(a)), false)
      from unnest(schools) t, unnest(areas) a
     where has_perm(t, a) is distinct from coalesce(is_super() or t in (select my_perm_tenant_ids(a)), false)
    union all
    select 'has_office_perm', t, null, has_office_perm(t),
           coalesce(is_super() or t in (select my_office_tenant_ids()), false)
      from unnest(schools) t
     where has_office_perm(t) is distinct from coalesce(is_super() or t in (select my_office_tenant_ids()), false)
    union all
    select 'may_administer', t, null, may_administer(t),
           coalesce(is_super() or t in (select my_administered_tenant_ids()), false)
      from unnest(schools) t
     where may_administer(t) is distinct from coalesce(is_super() or t in (select my_administered_tenant_ids()), false)
    union all
    select 'is_guardian_of', s.id, null, is_guardian_of(s.id),
           s.id in (select my_guardian_student_ids())
      from unnest(kids) s(id)
     where is_guardian_of(s.id) is distinct from (s.id in (select my_guardian_student_ids()))
    union all
    -- may_assess as the cbe_assessments / cbe_results policies now spell it
    select 'may_assess ' || x.c || ' ' || x.sb, x.t, null, may_assess(x.t, x.c, x.sb),
           coalesce(is_super() or x.t in (select my_perm_tenant_ids('academics'))
                    or (x.t = my_tenant() and my_role() = 'teacher'
                        and (x.c, x.sb) in (select p.class_id, p.subject_id from my_teaching_pairs() p)), false)
      from (select split_part(v, ' ', 1)::uuid t, split_part(v, ' ', 2)::uuid c, split_part(v, ' ', 3)::uuid sb
              from unnest(pairs) v) x
     where may_assess(x.t, x.c, x.sb) is distinct from
           coalesce(is_super() or x.t in (select my_perm_tenant_ids('academics'))
                    or (x.t = my_tenant() and my_role() = 'teacher'
                        and (x.c, x.sb) in (select p.class_id, p.subject_id from my_teaching_pairs() p)), false);
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- How many (school, area) pairs has_perm allows the caller: proves each case is not trivially empty.
create function pg_temp.allowed(p_uid uuid) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from tenants t, unnest(array['people', 'fees', 'medical', 'visitors']) a
   where t.name like 'Once Per Query %' and has_perm(t.id, a);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures
-- An active group owning schools A and B; a suspended group owning school D; a lone school C;
-- a suspended school S.
insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-0000000c0f01', 'Once Per Query Group', 'opq-group-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active'),
  ('00000000-0000-4000-8000-0000000c0f02', 'Once Per Query Suspended Group', 'opq-sgroup-' || substr(md5(random()::text), 1, 8), 'group_owner', 'suspended');
insert into tenants (id, name, slug, county, organization_id) values
  ('00000000-0000-4000-8000-0000000c0a01', 'Once Per Query School A', 'opq-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-0000000c0f01'),
  ('00000000-0000-4000-8000-0000000c0a02', 'Once Per Query School B', 'opq-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-0000000c0f01'),
  ('00000000-0000-4000-8000-0000000c0a04', 'Once Per Query School D', 'opq-d-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-0000000c0f02');
insert into tenants (id, name, slug, county) values
  ('00000000-0000-4000-8000-0000000c0a03', 'Once Per Query School C', 'opq-c-' || substr(md5(random()::text), 1, 8), 'Nairobi'),
  ('00000000-0000-4000-8000-0000000c0a05', 'Once Per Query School S', 'opq-s-' || substr(md5(random()::text), 1, 8), 'Nairobi');

select from pg_temp.person('00000000-0000-4000-8000-0000000c0b01', null, 'super_admin', 'OPQ Super');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b02', '00000000-0000-4000-8000-0000000c0a01', 'school_admin', 'OPQ Principal A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b03', null, 'org_admin', 'OPQ Group Admin');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b04', null, 'org_admin', 'OPQ Suspended Group Admin');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b05', '00000000-0000-4000-8000-0000000c0a01', 'staff', 'OPQ Bursar A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b06', '00000000-0000-4000-8000-0000000c0a01', 'staff', 'OPQ Gate Keeper A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b07', '00000000-0000-4000-8000-0000000c0a01', 'teacher', 'OPQ Deputy A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b08', '00000000-0000-4000-8000-0000000c0a01', 'teacher', 'OPQ Teacher A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b09', '00000000-0000-4000-8000-0000000c0a01', 'parent', 'OPQ Parent A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b0a', '00000000-0000-4000-8000-0000000c0a01', 'student', 'OPQ Learner A');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b0b', '00000000-0000-4000-8000-0000000c0a03', 'teacher', 'OPQ Teacher C');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b0c', '00000000-0000-4000-8000-0000000c0a05', 'school_admin', 'OPQ Principal S');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b0d', '00000000-0000-4000-8000-0000000c0a05', 'staff', 'OPQ Bursar S');
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b0e', '00000000-0000-4000-8000-0000000c0a01', 'driver', 'OPQ Driver A');
-- a parent holding an area row (areas only count for teachers and staff)
select from pg_temp.person('00000000-0000-4000-8000-0000000c0b10', '00000000-0000-4000-8000-0000000c0a01', 'parent', 'OPQ Parent With Area A');

insert into organization_admins (profile_id, organization_id) values
  ('00000000-0000-4000-8000-0000000c0b03', '00000000-0000-4000-8000-0000000c0f01'),
  ('00000000-0000-4000-8000-0000000c0b04', '00000000-0000-4000-8000-0000000c0f02');

insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0b05', 'fees'),
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0b06', 'visitors'),
  ('00000000-0000-4000-8000-0000000c0a05', '00000000-0000-4000-8000-0000000c0b0d', 'fees'),
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0b10', 'fees');

-- the deputy's areas come from a school role
insert into school_roles (id, tenant_id, name, areas) values
  ('00000000-0000-4000-8000-0000000c0d01', '00000000-0000-4000-8000-0000000c0a01', 'OPQ Deputy role', array['people', 'medical']);
insert into staff_role_assignments (tenant_id, profile_id, role_id) values
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0b07', '00000000-0000-4000-8000-0000000c0d01');

insert into classes (id, tenant_id, name, form_level) values
  ('00000000-0000-4000-8000-0000000c0c01', '00000000-0000-4000-8000-0000000c0a01', 'OPQ 2 West', 2);
insert into students (id, tenant_id, full_name, admission_no, profile_id, class_id) values
  ('00000000-0000-4000-8000-0000000c0e01', '00000000-0000-4000-8000-0000000c0a01', 'OPQ Child One', 'OPQ-1', '00000000-0000-4000-8000-0000000c0b0a', '00000000-0000-4000-8000-0000000c0c01'),
  ('00000000-0000-4000-8000-0000000c0e02', '00000000-0000-4000-8000-0000000c0a01', 'OPQ Child Two', 'OPQ-2', null, '00000000-0000-4000-8000-0000000c0c01');
insert into guardians (tenant_id, profile_id, student_id) values
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0b09', '00000000-0000-4000-8000-0000000c0e01');

-- the plain teacher teaches maths to 2 West; the deputy teaches nothing
insert into subjects (id, tenant_id, name, code) values
  ('00000000-0000-4000-8000-0000000c0501', '00000000-0000-4000-8000-0000000c0a01', 'OPQ Maths', 'OPQM'),
  ('00000000-0000-4000-8000-0000000c0502', '00000000-0000-4000-8000-0000000c0a01', 'OPQ English', 'OPQE');
insert into teaching_assignments (tenant_id, teacher_id, class_id, subject_id) values
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0b08',
   '00000000-0000-4000-8000-0000000c0c01', '00000000-0000-4000-8000-0000000c0501');

-- school S is suspended after its people are in place
update tenants set status = 'suspended' where id = '00000000-0000-4000-8000-0000000c0a05';

-- ---------------------------------------------------------------- the checks
do $$
declare
  r record;
  bad bigint;
  first text;
begin
  for r in
    select * from (values
      ('platform super user',              '00000000-0000-4000-8000-0000000c0b01'::uuid),
      ('school admin',                     '00000000-0000-4000-8000-0000000c0b02'),
      ('org admin acting for its schools', '00000000-0000-4000-8000-0000000c0b03'),
      ('org admin of a suspended group',   '00000000-0000-4000-8000-0000000c0b04'),
      ('area holder (fees, staff)',        '00000000-0000-4000-8000-0000000c0b05'),
      ('visitors-only area holder',        '00000000-0000-4000-8000-0000000c0b06'),
      ('teacher with areas from a role',   '00000000-0000-4000-8000-0000000c0b07'),
      ('plain teacher',                    '00000000-0000-4000-8000-0000000c0b08'),
      ('parent',                           '00000000-0000-4000-8000-0000000c0b09'),
      ('learner',                          '00000000-0000-4000-8000-0000000c0b0a'),
      ('teacher at another school',        '00000000-0000-4000-8000-0000000c0b0b'),
      ('admin of a suspended school',      '00000000-0000-4000-8000-0000000c0b0c'),
      ('area holder at a suspended school','00000000-0000-4000-8000-0000000c0b0d'),
      ('driver',                           '00000000-0000-4000-8000-0000000c0b0e'),
      ('parent with an area row',          '00000000-0000-4000-8000-0000000c0b10'),
      ('signed in with no profile',        '00000000-0000-4000-8000-0000000c0bff'),
      ('not signed in',                    null)
    ) v(label, uid)
  loop
    select count(*), min(m.what || ' ' || coalesce(m.tenant::text, 'null') || ' ' || coalesce(m.area, '-')
                         || ' old=' || coalesce(m.old::text, 'null') || ' new=' || coalesce(m.new::text, 'null'))
      into bad, first
      from pg_temp.mismatches(r.uid) m;
    perform pg_temp.check('the new permission sets agree with has_perm / has_office_perm / may_administer / is_guardian_of / may_assess for: '
                          || r.label || coalesce(' (' || bad || ' differ, e.g. ' || first || ')', ''), bad = 0);
  end loop;
end $$;

-- the cases above are not all "no": these callers really do hold something
select pg_temp.check('super holds every area at every check school',
  pg_temp.allowed('00000000-0000-4000-8000-0000000c0b01') = 20);
select pg_temp.check('school admin holds every area at school A only',
  pg_temp.allowed('00000000-0000-4000-8000-0000000c0b02') = 4);
select pg_temp.check('org admin holds every area at schools A and B only',
  pg_temp.allowed('00000000-0000-4000-8000-0000000c0b03') = 8);
select pg_temp.check('bursar holds fees at school A only',
  pg_temp.allowed('00000000-0000-4000-8000-0000000c0b05') = 1);
select pg_temp.check('deputy holds people and medical at school A through a role',
  pg_temp.allowed('00000000-0000-4000-8000-0000000c0b07') = 2);
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000c0b08', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform pg_temp.check('the plain teacher may assess exactly the class and subject they teach',
    may_assess('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0c01', '00000000-0000-4000-8000-0000000c0501')
    and not may_assess('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000c0c01', '00000000-0000-4000-8000-0000000c0502')
    and (select count(*) from my_teaching_pairs()) = 1);
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- the policies now use the sets, not the per-row calls
select pg_temp.check('the busy read policies no longer call has_perm / has_office_perm / may_administer / is_guardian_of / may_assess per row',
  not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and (tablename, policyname) in (
         ('students', 'student_read'), ('students', 'student_write'), ('fee_invoices', 'invoice_read'),
         ('payments', 'payment_read'), ('payment_proofs', 'payment_proofs_read'), ('fee_items', 'fee_item_read'),
         ('fee_items', 'fee_item_write'), ('classes', 'classes_read'), ('classes', 'classes_write'),
         ('guardians', 'guardian_read'), ('guardians', 'guardian_write'), ('profiles', 'profile_read_self'),
         ('profiles', 'profile_admin_manage'), ('attendance', 'attendance_read'), ('attendance', 'attendance_write'),
         ('marks', 'mark_read'), ('marks', 'mark_write'), ('cbe_results', 'cbe_result_read'),
         ('inventory_items', 'inventory_items_read'), ('inventory_items', 'inventory_items_write'),
         ('inventory_issues', 'inventory_issues_read'), ('inventory_movements', 'inventory_movements_read'),
         ('sick_bay_visits', 'sick_bay_visits_read'), ('visit_medications', 'visit_medications_read'),
         ('cbe_results', 'cbe_result_write'), ('cbe_assessments', 'cbe_assessment_read'),
         ('cbe_assessments', 'cbe_assessment_write'), ('exams', 'exam_read'), ('exams', 'exam_write'),
         ('teaching_assignments', 'teaching_read'), ('teaching_assignments', 'teaching_write'),
         ('mark_publications', 'mark_publications_read'), ('fee_invoices', 'invoice_insert'),
         ('fee_invoices', 'invoice_update'))
       and (coalesce(qual, '') ~ '(has_perm|has_office_perm|may_administer|is_guardian_of|may_assess)\('
            or coalesce(with_check, '') ~ '(has_perm|has_office_perm|may_administer|is_guardian_of|may_assess)\(')));

rollback;
