-- Database integrity (QA 15, FIG-1248): is the data still consistent after bad design, a half-finished operation or two things at
-- once? Four parts:
--   A  the shape of the schema, read from the catalog: keys, row-level security, money and time types, per-school uniqueness
--   B  rows that point at nothing, or at another school's rows, in the seeded data (expected: zero) and a plant-and-detect
--      check that the detector would see one
--   C  the triggers: what each one refuses and what it allows
--   D  the login number
--
-- Atomicity of the account functions (provision-student, provision-guardian, invite-admin) cannot be tested from SQL: they run in
-- the edge runtime. They were interrupted halfway with temporary triggers (QA 15, FIG-1248 comment) and the Deno tests in
-- supabase/functions/*/index.test.ts keep the rollback paths.
--
-- Runs against a local database with `npm run db:seed` and `db:seed-org` data (two schools), in one transaction that is rolled back.
-- Every check prints PASS, FAIL, KNOWN <bug> (a defect already filed: KNOWN until it is fixed, then PASS), INFO or NOT TESTED.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/integrity.sql
-- Check the psql exit code too. Do not run it while e2e or the integration tests are running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;

-- Runs one statement as a signed-in user and says what the database did: how many rows, or the error code.
create function pg_temp.as_user(p_user uuid, p_stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute p_stmt;
    get diagnostics n = row_count;
    reset role;
    return 'allowed ' || n;
  exception when others then
    reset role;
    return 'refused ' || sqlstate;
  end;
end $$;
create function pg_temp.count_as(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute p_sql into n;
  reset role;
  return n;
exception when others then
  reset role;
  raise;
end $$;

-- ---------------------------------------------------------------- A. the schema
-- A1 every table has a primary key
select pg_temp.check('A1 every table has a primary key (login_lookups, a throwaway rate-limit counter, is the one exception)',
  not exists (select 1 from pg_tables t where schemaname = 'public' and tablename <> 'login_lookups'
              and not exists (select 1 from pg_constraint c where c.conrelid = format('public.%I', t.tablename)::regclass and c.contype = 'p')));

-- A2 row-level security is on for every table
select pg_temp.check('A2 row-level security is switched on for every table', not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity));
select pg_temp.info('A2 tables with RLS on and no policy (nobody but the service role and definer functions can touch them): '
  || coalesce((select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid)), 'none'));

-- A3 money is integer cents
select pg_temp.check('A3 no money-like column is a number with a fraction (numeric, real, double precision, money)',
  not exists (select 1 from information_schema.columns where table_schema = 'public'
              and column_name ~ '(amount|price|cost|fee|total|balance|paid|cents|salary|charge|rate|discount|waiver|refund)'
              and data_type in ('numeric', 'real', 'double precision', 'money', 'decimal')));
select pg_temp.check('A3 every *_cents column is an integer or bigint',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and column_name like '%cents' and data_type not in ('integer', 'bigint')));
select pg_temp.check('A3 the only money-like integer not named *_cents is the plan price override, which is cents too (tenants.price_cents_override)',
  (select coalesce(string_agg(table_name || '.' || column_name, ','), '') from information_schema.columns
    where table_schema = 'public' and column_name ~ '(amount|price|cost|fee|total|balance|paid|salary|charge|rate|discount|waiver|refund)'
      and column_name not like '%cents' and data_type in ('integer', 'bigint', 'smallint')) = 'tenants.price_cents_override');

-- A4 dates and times
select pg_temp.check('A4 no column is a timestamp without a time zone', not exists (select 1 from information_schema.columns where table_schema = 'public' and data_type = 'timestamp without time zone'));
select pg_temp.check('A4 no *_at column is a date, and no *_on or date column is a timestamptz',
  not exists (select 1 from information_schema.columns where table_schema = 'public'
              and ((column_name ~ '_at$' and data_type = 'date') or ((column_name ~ '_on$' or column_name ~ '(^|_)date$') and data_type = 'timestamp with time zone'))));

-- A5 every reference to another row is a foreign key
select pg_temp.check('A5 every uuid *_id column has a foreign key, except the two that are keyed by (doc_kind, doc_id) on purpose (signatures are evidence that outlives the document)',
  (select coalesce(string_agg(c.table_name || '.' || c.column_name, ',' order by c.table_name), '') from information_schema.columns c
    join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name
   where c.table_schema = 'public' and c.data_type = 'uuid' and c.column_name like '%\_id' and c.column_name <> 'id'
     and not exists (select 1 from pg_constraint k where k.contype = 'f' and k.conrelid = format('public.%I', c.table_name)::regclass
                      and (select attnum from pg_attribute where attrelid = k.conrelid and attname = c.column_name) = any (k.conkey)))
  = 'signature_requests.doc_id,signatures.doc_id');

-- A6 every school-owned row has a school
select pg_temp.check('A6 tenant_id is NOT NULL on every table that has it, except where a row can belong to no school (a platform admin or org admin profile, a platform audit event, an organization access log, an official strand)',
  (select coalesce(string_agg(table_name, ',' order by table_name), '') from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'YES'
      and table_name in (select tablename from pg_tables where schemaname = 'public'))
  = 'audit_events,organization_access_log,profiles,strands');

-- A7 uniqueness per school
create function pg_temp.has_unique(p_tbl text, p_cols text[]) returns boolean language sql as $$
  select exists (
    select 1 from pg_index i
     where i.indisunique and i.indrelid = ('public.' || quote_ident(p_tbl))::regclass
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey)) = (select array_agg(c order by c) from unnest(p_cols) c));
$$;
select pg_temp.check('A7 ' || x.tbl || '(' || array_to_string(x.cols, ', ') || ') is unique' || x.why, pg_temp.has_unique(x.tbl, x.cols))
  from (values
    ('students', array['tenant_id', 'admission_no'], ': one admission number per school'),
    ('profiles', array['tenant_id', 'login_id'], ': one login ID per school'),
    ('classes', array['tenant_id', 'name'], ''),
    ('subjects', array['tenant_id', 'code'], ''),
    ('terms', array['tenant_id', 'year', 'index'], ''),
    ('terms', array['tenant_id'], ' (partial: one current term per school)'),
    ('fee_invoices', array['student_id', 'term_id'], ': one invoice per learner per term'),
    ('marks', array['exam_id', 'student_id', 'subject_id'], ': one mark per learner, exam and subject'),
    ('attendance', array['student_id', 'taken_on'], ': one register entry per learner per day'),
    ('guardians', array['profile_id', 'student_id'], ''),
    ('exams', array['term_id', 'name'], ''),
    ('teaching_assignments', array['class_id', 'subject_id'], ': one teacher per class and subject'),
    ('tenants', array['slug'], ''),
    ('payments', array['mpesa_receipt'], ': a receipt is counted once')
  ) as x(tbl, cols, why);
select pg_temp.info('A7 no unique key on fee_items(name) per term: two items with the same name can be billed together; subjects(name) is not unique (the code is)');

-- A8 what a delete does
select pg_temp.info('A8 delete rules over every foreign key: ' || (select string_agg(r || ' ' || n, ', ' order by n desc) from
  (select case confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'r' then 'RESTRICT' when 'a' then 'NO ACTION' else 'OTHER' end as r, count(*) as n
     from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace group by 1) d));

-- ---------------------------------------------------------------- B. rows that point at nothing, or at another school
-- A foreign key only proves the parent exists, wherever it lives. For every single-column foreign key between two tables that both
-- have a tenant_id, count the rows whose school differs from their parent's school.
create function pg_temp.cross_school_rows() returns table (child text, col text, parent text, bad bigint, pairs int) language plpgsql as $$
declare k record; n bigint; total int := 0;
begin
  for k in select c.conrelid::regclass::text as child, a.attname::text as col, c.confrelid::regclass::text as parent, pa.attname::text as pcol
             from pg_constraint c
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
            where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
              and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'tenant_id' and not x.attisdropped)
              and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'tenant_id' and not x.attisdropped)
            order by 1, 2 loop
    total := total + 1;
    execute format('select count(*) from %s c join %s p on p.%I = c.%I where c.tenant_id is not null and p.tenant_id is not null and c.tenant_id <> p.tenant_id',
                   k.child, k.parent, k.pcol, k.col) into n;
    child := k.child; col := k.col; parent := k.parent; bad := n; pairs := total;
    return next;
  end loop;
end $$;

select pg_temp.check('B1 no row points at another school across ' || (select max(pairs) from pg_temp.cross_school_rows()) || ' school-to-school foreign keys'
    || coalesce(': ' || (select string_agg(child || '.' || col || ' (' || bad || ')', ', ') from pg_temp.cross_school_rows() where bad > 0), ''),
  not exists (select 1 from pg_temp.cross_school_rows() where bad > 0));

-- The same check, with a bad row planted, so a PASS above means something: a guardian link is moved to the other school (no trigger,
-- no foreign key is switched on for the plant), the detector must see it, and the plant is undone.
create function pg_temp.detector_selftest() returns void language plpgsql as $$
declare k uuid; seen bigint;
begin
  select id into k from tenants where slug = 'kijani-ridge';
  begin
    set local session_replication_role = replica;
    update guardians set tenant_id = k where ctid = (select ctid from guardians where tenant_id <> k limit 1);
    set local session_replication_role = origin;
    select coalesce(sum(bad), 0) into seen from pg_temp.cross_school_rows();
    perform pg_temp.check('B2 the detector sees a guardian link planted in the wrong school (so B1 is not passing on an empty table)', seen >= 1);
    raise exception using errcode = 'QA015';
  exception when sqlstate 'QA015' then null;
  end;
  set local session_replication_role = origin;
end $$;
select pg_temp.detector_selftest();

-- rows whose parent has no school column, checked by hand
select pg_temp.check('B3 no homework hand-in joins a learner of one school to an assignment of another',
  not exists (select 1 from assignment_submissions x join assignments a on a.id = x.assignment_id join students s on s.id = x.student_id where a.tenant_id <> s.tenant_id));
select pg_temp.check('B3 no learner is linked to a login of another school',
  not exists (select 1 from students s join profiles p on p.id = s.profile_id where s.tenant_id <> p.tenant_id));

select pg_temp.check('B4 no two learners of a school share an admission number once case and spaces are ignored',
  not exists (select 1 from students group by tenant_id, lower(btrim(admission_no)) having count(*) > 1));
select pg_temp.check('B4 no invoice is without a learner, and none points at a learner who is gone',
  not exists (select 1 from fee_invoices i left join students s on s.id = i.student_id where i.student_id is null or s.id is null));
select pg_temp.check('B4 no payment is without an invoice', not exists (select 1 from payments p left join fee_invoices i on i.id = p.invoice_id where i.id is null));
select pg_temp.check('B5 no mark belongs to a learner who has no class', not exists (select 1 from marks m join students s on s.id = m.student_id where s.class_id is null));
select pg_temp.info('B5 marks whose subject nobody is assigned to teach in that learner''s class: '
  || (select count(*) from marks m join students s on s.id = m.student_id
       where not exists (select 1 from teaching_assignments t where t.class_id = s.class_id and t.subject_id = m.subject_id))
  || ' of ' || (select count(*) from marks) || ' (the seed enters marks for nine subjects and assigns one teacher, to Chemistry)');
select pg_temp.check('B5 no active learner of a school with classes is without a class (K-12 needs one)',
  not exists (select 1 from students s join tenants t on t.id = s.tenant_id where s.active and s.class_id is null and t.institution_type::text = 'k12'));

-- logins
select pg_temp.check('B6 every sign-in account has a profile (an account with none is what a half-finished account creation leaves)',
  not exists (select 1 from auth.users u where not exists (select 1 from profiles p where p.id = u.id)));
select pg_temp.check('B6 every profile role matches its school: school roles have one, platform and organization admins have none',
  not exists (select 1 from profiles where (role::text in ('school_admin', 'teacher', 'parent', 'student', 'driver', 'guard', 'receptionist', 'staff') and tenant_id is null)
                                        or (role::text in ('super_admin', 'org_admin') and tenant_id is not null)));
select pg_temp.check('B6 a student login belongs to a learner of the same school and to one learner only',
  not exists (select 1 from students group by profile_id having profile_id is not null and count(*) > 1)
  and not exists (select 1 from students s join profiles p on p.id = s.profile_id where p.role::text <> 'student'));
select pg_temp.check('B6 every school that has terms has exactly one current term',
  not exists (select 1 from tenants t where exists (select 1 from terms x where x.tenant_id = t.id)
                and (select count(*) from terms x where x.tenant_id = t.id and x.is_current) <> 1));

-- files
select pg_temp.check('B7 every uploaded file a row names exists in storage',
  not exists (select 1 from student_documents d where not exists (select 1 from storage.objects o where o.bucket_id = 'private-documents' and o.name = d.file_path))
  and not exists (select 1 from payment_proofs d where d.file_path is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'private-documents' and o.name = d.file_path))
  and not exists (select 1 from assignment_submissions d where d.file_path is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'private-documents' and o.name = d.file_path)));
select pg_temp.info('B7 rows with a file to check: '
  || (select count(*) from student_documents) || ' learner documents, '
  || (select count(*) from payment_proofs where file_path is not null) || ' payment proofs, '
  || (select count(*) from assignment_submissions where file_path is not null) || ' hand-ins (the seed has few or none, so this proves the query, not the data)');

-- ---------------------------------------------------------------- facts the next parts use
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.admin', (select id::text from profiles where tenant_id = current_setting('t.a')::uuid and role = 'school_admin' order by id limit 1), true);
select set_config('t.teacher', (select id::text from profiles where tenant_id = current_setting('t.a')::uuid and role = 'teacher' order by id limit 1), true);
select set_config('t.kadmin', (select id::text from profiles where tenant_id = current_setting('t.k')::uuid and role = 'school_admin' order by id limit 1), true);
select set_config('t.cls', (select id::text from classes where tenant_id = current_setting('t.a')::uuid order by name limit 1), true);
select set_config('t.term', (select id::text from terms where tenant_id = current_setting('t.a')::uuid and is_current), true);
select set_config('t.kstu', (select id::text from students where tenant_id = current_setting('t.k')::uuid order by admission_no limit 1), true);
select set_config('t.kparent', (select g.profile_id::text from guardians g where g.tenant_id = current_setting('t.k')::uuid order by g.id limit 1), true);
select set_config('t.kchild', (select g.student_id::text from guardians g where g.profile_id = current_setting('t.kparent')::uuid order by g.id limit 1), true);
select set_config('t.aguard', (select g.profile_id::text from guardians g where g.tenant_id = current_setting('t.a')::uuid order by g.id limit 1), true);
select set_config('t.veh', (select id::text from vehicles where tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.drv', (select id::text from profiles where tenant_id = current_setting('t.a')::uuid and role = 'driver' order by id limit 1), true);

-- ---------------------------------------------------------------- C. the triggers
-- C1 guard_student_delete. A throwaway learner gets one kind of history, then the school admin deletes the learner.
create function pg_temp.delete_case(p_kind text, p_setup text) returns text language plpgsql as $$
declare sid uuid; res text;
begin
  insert into students (tenant_id, admission_no, full_name, gender, class_id)
    values (current_setting('t.a')::uuid, 'QA15-' || p_kind, 'QA15 ' || p_kind, 'female', current_setting('t.cls')::uuid) returning id into sid;
  begin execute replace(p_setup, '$S', quote_literal(sid)); exception when others then return 'FIXTURE ERROR ' || sqlerrm; end;
  res := pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from students where id = %L', sid));
  return res || case when exists (select 1 from students where id = sid) then ' (learner kept)' else ' (learner gone)' end;
end $$;

select pg_temp.check('C1 a learner with ' || x.kind || ' on file cannot be deleted', pg_temp.delete_case(x.kind, x.setup) like 'refused 23001%')
  from (values
    ('attendance', $q$ insert into attendance (tenant_id, student_id, class_id, term_id, taken_on, taken_by, mark) values (current_setting('t.a')::uuid, $S, current_setting('t.cls')::uuid, current_setting('t.term')::uuid, current_date, current_setting('t.admin')::uuid, 'present') $q$),
    ('a fee invoice', $q$ insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on) values (current_setting('t.a')::uuid, $S, current_setting('t.term')::uuid, 100000, current_date) $q$),
    ('a document', $q$ insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name) values (current_setting('t.a')::uuid, $S, current_setting('t.admin')::uuid, 'x', 'x', 'x') $q$),
    ('a homework hand-in', $q$ insert into assignment_submissions (assignment_id, student_id) select id, $S from assignments where tenant_id = current_setting('t.a')::uuid limit 1 $q$)
  ) as x(kind, setup);
select pg_temp.check('C1 a learner with nothing on file can be deleted', pg_temp.delete_case('nothing', 'select 1') = 'allowed 1 (learner gone)');

-- The guard names ten kinds of history. Every other table that cascades from students loses its rows silently on a delete.
select pg_temp.check('C1 the guard names every table that cascades from students; unnamed: ' ||
    coalesce((select string_agg(c.conrelid::regclass::text, ', ' order by c.conrelid::regclass::text) from pg_constraint c
               where c.contype = 'f' and c.confrelid = 'public.students'::regclass and c.confdeltype = 'c'
                 and position(c.conrelid::regclass::text in pg_get_functiondef('guard_student_delete'::regproc)) = 0
                 and c.conrelid::regclass::text not in ('guardians')), 'none'),
  not exists (select 1 from pg_constraint c
               where c.contype = 'f' and c.confrelid = 'public.students'::regclass and c.confdeltype = 'c'
                 and position(c.conrelid::regclass::text in pg_get_functiondef('guard_student_delete'::regproc)) = 0
                 and c.conrelid::regclass::text not in ('guardians')),
  'QA15-GUARD FIG-1467');

select pg_temp.check('C1 a learner with ' || x.kind || ' on file cannot be deleted (checked with a real delete)', pg_temp.delete_case(x.kind, x.setup) like 'refused 23001%', 'QA15-GUARD FIG-1467')
  from (values
    ('inventory on loan', $q$ with i as (insert into inventory_items (tenant_id, name) values (current_setting('t.a')::uuid, 'QA15 book') returning id) insert into inventory_issues (tenant_id, item_id, student_id) select current_setting('t.a')::uuid, id, $S from i $q$),
    ('a health record', $q$ insert into student_health (tenant_id, student_id) values (current_setting('t.a')::uuid, $S) $q$),
    ('a club membership', $q$ with a as (insert into activities (tenant_id, name, category) values (current_setting('t.a')::uuid, 'QA15 club', 'club') returning id) insert into activity_members (tenant_id, activity_id, student_id) select current_setting('t.a')::uuid, id, $S from a $q$),
    ('a report card', $q$ insert into report_cards (tenant_id, term_id, student_id, data) values (current_setting('t.a')::uuid, current_setting('t.term')::uuid, $S, '{}'::jsonb) $q$),
    ('a parent bio-data request', $q$ insert into student_bio_requests (tenant_id, student_id, changes) values (current_setting('t.a')::uuid, $S, '{}'::jsonb) $q$),
    ('core competencies', $q$ insert into learner_competencies (tenant_id, term_id, student_id, kind, item, level_code) values (current_setting('t.a')::uuid, current_setting('t.term')::uuid, $S, 'competency', 'teamwork', 'ME') $q$)
  ) as x(kind, setup);

-- Removing a whole school must still work: the guard steps aside when the delete comes from the school's row (trigger depth above 1).
create function pg_temp.school_removal() returns void language plpgsql as $$
declare t uuid; c uuid; tm uuid; s uuid; res text;
begin
  insert into tenants (name, slug, county) values ('QA15 Gone', 'qa15-gone', 'Nairobi') returning id into t;
  insert into classes (tenant_id, name, form_level) values (t, 'QA15 class', 1) returning id into c;
  insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current) values (t, 'QA15 term', 2040, 1, '2040-01-01', '2040-04-01', true) returning id into tm;
  insert into students (tenant_id, admission_no, full_name, gender, class_id) values (t, 'QA15-G1', 'QA15 gone', 'female', c) returning id into s;
  insert into attendance (tenant_id, student_id, class_id, term_id, taken_on, taken_by, mark) values (t, s, c, tm, '2040-01-02', current_setting('t.admin')::uuid, 'present');
  insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on) values (t, s, tm, 100000, '2040-01-30');
  delete from tenants where id = t;
  perform pg_temp.check('C1 deleting a whole school removes its learners, their attendance and invoices (the guard steps aside for the cascade)',
    not exists (select 1 from students where id = s) and not exists (select 1 from attendance where student_id = s) and not exists (select 1 from fee_invoices where student_id = s));
end $$;
select pg_temp.school_removal();

-- C2 guard_exam_delete
select set_config('t.exam_marks', (select exam_id::text from marks where tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from exams where id = %L', current_setting('t.exam_marks'))), true);
select pg_temp.check('C2 the school admin cannot delete an exam that has marks', current_setting('t.r') = 'refused 23001');
select set_config('t.r', pg_temp.as_user(current_setting('t.teacher')::uuid, format('delete from exams where id = %L', current_setting('t.exam_marks'))), true);
select pg_temp.check('C2 a teacher cannot delete it either (the policy shows them no row to delete), and the marks are all still there',
  current_setting('t.r') = 'allowed 0' and (select count(*) from marks where exam_id = current_setting('t.exam_marks')::uuid) > 0);
create function pg_temp.new_exam() returns uuid language sql as $$
  insert into exams (tenant_id, term_id, name) values (current_setting('t.a')::uuid, current_setting('t.term')::uuid, 'QA15 empty exam') returning id;
$$;
select set_config('t.new_exam', pg_temp.new_exam()::text, true);
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from exams where id = %L', current_setting('t.new_exam'))), true);
select pg_temp.check('C2 an exam with no marks can be deleted', current_setting('t.r') = 'allowed 1');
select pg_temp.check('C2 the guard runs with the caller''s rights, so it only sees the marks the caller may read (a school admin and a teacher read every mark of the school; keep it so, or make the guard a definer like guard_student_delete)',
  (select prosecdef from pg_proc where oid = 'guard_exam_delete'::regproc) = false);

-- C3 the same-school guards on learner-linked tables
select pg_temp.check('C3 enforce_student_tenant fires before every insert and every update on all ' || (select count(*) from pg_trigger g join pg_proc p on p.oid = g.tgfoid where p.proname = 'enforce_student_tenant' and not g.tgisinternal) || ' tables it guards',
  not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
               where p.proname = 'enforce_student_tenant' and not g.tgisinternal and not ((g.tgtype & 2) > 0 and (g.tgtype & 4) > 0 and (g.tgtype & 16) > 0)));
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into student_health (tenant_id, student_id) values (%L, %L)', current_setting('t.a'), current_setting('t.kstu'))), true);
select pg_temp.check('C3 a health record for another school''s learner is refused', current_setting('t.r') = 'refused 42501');
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into student_bio_requests (tenant_id, student_id, changes) values (%L, %L, %L)', current_setting('t.a'), current_setting('t.kstu'), '{}')), true);
select pg_temp.check('C3 a parent bio-data request for another school''s learner is refused', current_setting('t.r') = 'refused 42501');
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into student_health (tenant_id, student_id) select %L, id from students where tenant_id = %L limit 1', current_setting('t.a'), current_setting('t.a'))), true);
select pg_temp.check('C3 and a health record for this school''s own learner is allowed (control)', current_setting('t.r') = 'allowed 1');
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into guardians (tenant_id, profile_id, student_id) values (%L, %L, %L)', current_setting('t.a'), current_setting('t.aguard'), current_setting('t.kstu'))), true);
select pg_temp.check('C3 a guardian link to another school''s learner is refused', current_setting('t.r') = 'refused 42501');
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format($f$insert into visits (tenant_id, visitor_name, purpose, host_kind, student_id) values (%L, 'QA15', 'x', 'learner', %L)$f$, current_setting('t.a'), current_setting('t.kstu'))), true);
select pg_temp.check('C3 a visit about another school''s learner is refused (visits_stamp)', current_setting('t.r') = 'refused 22023');
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into assignment_submissions (assignment_id, student_id) select (select id from assignments where tenant_id = %L limit 1), %L', current_setting('t.a'), current_setting('t.kstu'))), true);
select pg_temp.check('C3 a homework hand-in by another school''s learner is refused (policy)', current_setting('t.r') = 'refused 42501');

-- C4 enforce_invoice_tenant
select set_config('t.kinv', (select id::text from fee_invoices where tenant_id = current_setting('t.k')::uuid order by id limit 1), true);
select set_config('t.ainv', (select id::text from fee_invoices where tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
create function pg_temp.proof_into(p_invoice uuid) returns text language plpgsql as $$
begin
  begin
    insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name) values (current_setting('t.a')::uuid, p_invoice, current_setting('t.admin')::uuid, 'qa15/x', 'x');
    raise exception using errcode = 'QA015';
  exception when sqlstate 'QA015' then return 'allowed';
            when others then return 'refused ' || sqlstate;
  end;
end $$;
select pg_temp.check('C4 a payment proof against another school''s invoice is refused', pg_temp.proof_into(current_setting('t.kinv')::uuid) = 'refused 42501');
select pg_temp.check('C4 and one against this school''s own invoice is allowed (control)', pg_temp.proof_into(current_setting('t.ainv')::uuid) = 'allowed');

-- C5 a bus trip takes riders from its own school only
select pg_temp.info('C5 bus riders: trip_riders has no same-school trigger (trip_riders_stamp only stamps times), and the admin write policy checks the caller''s permission only');
create function pg_temp.rider_case() returns void language plpgsql as $$
declare trip uuid; r text; leaked bigint; seen bigint;
begin
  insert into trips (tenant_id, vehicle_id, driver_id) values (current_setting('t.a')::uuid, current_setting('t.veh')::uuid, current_setting('t.drv')::uuid) returning id into trip;
  r := pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into trip_riders (tenant_id, trip_id, student_id, status) values (%L, %L, %L, %L)', current_setting('t.a'), trip, current_setting('t.kchild'), 'boarded'));
  perform pg_temp.check('C5 an Alliance trip takes another school''s learner as a rider (' || r || ')', r like 'refused%', 'QA15-RIDER FIG-1466');
  select count(*) into leaked from bus_updates where trip_id = trip and current_setting('t.kchild')::uuid = any (student_ids);
  seen := pg_temp.count_as(current_setting('t.kparent')::uuid, format('select count(*) from bus_updates where trip_id = %L', trip));
  perform pg_temp.check('C5 and the bus update about that learner ("got on the bus") is not shown to the other school''s parent (' || leaked || ' written, ' || seen || ' readable by them)', seen = 0, 'QA15-RIDER FIG-1466');
end $$;
select pg_temp.rider_case();

-- C6 the organization summary follows the learners
create function pg_temp.summary_case() returns void language plpgsql as $$
declare before_n int; after_add int; after_del int; live_n int; sid uuid; kc uuid;
begin
  select active_students into before_n from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid;
  if before_n is null then perform pg_temp.info('C6 Kijani Ridge has no organization summary row (run db:seed-org first)'); return; end if;
  select id into kc from classes where tenant_id = current_setting('t.k')::uuid order by name limit 1;
  insert into students (tenant_id, admission_no, full_name, gender, class_id) values (current_setting('t.k')::uuid, 'QA15-ORG', 'QA15 org', 'female', kc) returning id into sid;
  select active_students into after_add from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid;
  delete from students where id = sid;
  select active_students into after_del from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid;
  select count(*) into live_n from students where tenant_id = current_setting('t.k')::uuid and active;
  perform pg_temp.check('C6 adding a learner moves the organization summary by one (' || before_n || ' to ' || after_add || ')', after_add = before_n + 1);
  perform pg_temp.check('C6 removing the learner puts it back (' || after_del || '), and it equals the live count (' || live_n || ')', after_del = before_n and after_del = live_n);
  -- a school leaving its organization drops out of the summary, and rejoining brings it back
  declare org uuid;
  begin
    select organization_id into org from tenants where id = current_setting('t.k')::uuid;
    update tenants set organization_id = null where id = current_setting('t.k')::uuid;
    perform pg_temp.check('C6 a school that leaves its organization drops out of the group''s summary (its row is kept with no organization)', not exists (select 1 from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid and organization_id is not null));
    update tenants set organization_id = org where id = current_setting('t.k')::uuid;
    perform pg_temp.check('C6 and has one again, with the right learner count, when it rejoins',
      (select active_students from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid) = live_n);
  end;
end $$;
select pg_temp.summary_case();

-- ---------------------------------------------------------------- D. the login number
-- next_login_number is "one past the highest number in profiles": it reads, it does not reserve. Two requests at the same moment
-- read the same highest number and are handed the same number. The unique keys then make the later one fail (nothing is
-- duplicated), but that one fails with a raw error. Two calls before either has inserted its profile show it without any timing luck.
select pg_temp.check('D1 two calls for the same school and role give different numbers (so two simultaneous account creations cannot be handed the same one)',
  next_login_number(current_setting('t.a')::uuid, 'student') <> next_login_number(current_setting('t.a')::uuid, 'student'), 'QA15-LOGIN-NUMBER FIG-1468');
select pg_temp.check('D1 the function is volatile or takes a lock or a sequence (it is STABLE and reads max+1)',
  (select provolatile <> 's' from pg_proc where oid = 'next_login_number'::regproc) or position('nextval' in pg_get_functiondef('next_login_number'::regproc)) > 0
  or position('lock' in lower(pg_get_functiondef('next_login_number'::regproc))) > 0, 'QA15-LOGIN-NUMBER FIG-1468');
select pg_temp.check('D1 login IDs are unique per school, so a clash can fail but never duplicate (profiles: tenant_id, login_id; auth email is unique too)',
  pg_temp.has_unique('profiles', array['tenant_id', 'login_id']));

rollback;
