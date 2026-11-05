-- The figures the Reports and Dashboard screens add up (FIG-1438, FIG-1402, FIG-1439): term_class_figures() and term_fee_totals().
--
-- The screens used to read every invoice, register entry and mark through the API, which answers at most 1,000 rows and says nothing
-- when it stops, so past 1,000 rows the totals were sums of whichever 1,000 came back first. The database now adds them up. This file
-- proves two things: the functions equal an independent sum over the raw rows (Kijani Ridge has 3,360 register entries, more than the
-- 1,000 the API would return), and each caller gets only the parts they may read: attendance by the attendance area, invoices by fees,
-- marks by academics, learners by any office area; another school's admin, a teacher without areas, a parent and a student get nothing.
--
-- Runs against a local database with `npm run db:seed` and `db:seed-org` data, in one transaction that is rolled back. Every check
-- prints PASS, FAIL, KNOWN <bug> or INFO.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/term_figures.sql
-- Check the psql exit code too. Do not run it while e2e or the integration tests are running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;

-- What a signed-in user gets back from a query, as JSON ordered by class.
create function pg_temp.json_as(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute 'select coalesce(jsonb_agg(to_jsonb(q) order by q.class_id), ''[]''::jsonb) from (' || p_sql || ') q' into j;
  reset role;
  return j;
exception when others then
  reset role;
  raise;
end $$;
create function pg_temp.fees_as(p_user uuid, p_tenant uuid, p_term uuid) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select to_jsonb(f) into j from term_fee_totals(p_tenant, p_term) f;
  reset role;
  return coalesce(j, '"no row"'::jsonb);
exception when others then
  reset role;
  raise;
end $$;

-- The same figures worked out from the raw rows, as the postgres role, with no function of ours in between.
create function pg_temp.expected(p_t uuid, p_term uuid, p_exam uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'class_id', c.id,
    'roster', (select count(*) from students s where s.class_id = c.id and s.active),
    'att_here', (select count(*) from attendance a where a.tenant_id = p_t and a.term_id = p_term and a.class_id = c.id and a.mark in ('present', 'late')),
    'att_total', (select count(*) from attendance a where a.tenant_id = p_t and a.term_id = p_term and a.class_id = c.id),
    'billed', (select coalesce(sum(i.total_cents), 0) from fee_invoices i join students s on s.id = i.student_id and s.active
                where i.tenant_id = p_t and i.term_id = p_term and s.class_id = c.id),
    'paid', (select coalesce(sum(i.paid_cents), 0) from fee_invoices i join students s on s.id = i.student_id and s.active
              where i.tenant_id = p_t and i.term_id = p_term and s.class_id = c.id),
    'mark_sum', (select coalesce(sum(k.score), 0) from marks k join students s on s.id = k.student_id and s.active
                  where p_exam is not null and k.tenant_id = p_t and k.exam_id = p_exam and s.class_id = c.id),
    'mark_count', (select count(k.score) from marks k join students s on s.id = k.student_id and s.active
                    where p_exam is not null and k.tenant_id = p_t and k.exam_id = p_exam and s.class_id = c.id)
  ) order by c.id), '[]'::jsonb) from classes c where c.tenant_id = p_t;
$$;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.aterm', (select id::text from terms where tenant_id = current_setting('t.a')::uuid and is_current), true);
select set_config('t.kterm', (select id::text from terms where tenant_id = current_setting('t.k')::uuid and is_current), true);
select set_config('t.exam', (select id::text from exams where tenant_id = current_setting('t.a')::uuid and term_id = current_setting('t.aterm')::uuid
                              and published_at is not null order by published_at desc limit 1), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.kadmin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.k')::uuid order by id limit 1), true);
select set_config('t.teacher', (select id::text from profiles where login_id = 'TC-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.parent', (select id::text from profiles where login_id = 'PT-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.student', (select id::text from profiles where login_id = 'ST-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.org', (select id::text from profiles where role = 'org_admin' order by id limit 1), true);
select set_config('t.super', (select id::text from profiles where role = 'super_admin' order by id limit 1), true);
select pg_temp.check('the seed has what these checks need (two schools with a current term, their admins, a teacher, a parent, a student, a group admin, a platform admin, a published exam)',
  current_setting('t.a') <> '' and current_setting('t.k') <> '' and current_setting('t.aterm') <> '' and current_setting('t.kterm') <> ''
  and current_setting('t.exam') <> '' and current_setting('t.admin') <> '' and current_setting('t.kadmin') <> '' and current_setting('t.teacher') <> ''
  and current_setting('t.parent') <> '' and current_setting('t.student') <> '' and current_setting('t.org') <> '' and current_setting('t.super') <> '');

create function pg_temp.figures(p_user uuid, p_tenant uuid, p_term uuid, p_exam uuid) returns jsonb language sql as $$
  select pg_temp.json_as(p_user, format('select * from term_class_figures(%L, %L, %L)', p_tenant, p_term, p_exam));
$$;

-- ---------------------------------------------------------------- the sums equal the raw rows
select pg_temp.info('Kijani Ridge this term: ' || (select count(*) from attendance where tenant_id = current_setting('t.k')::uuid and term_id = current_setting('t.kterm')::uuid)
  || ' register entries (the API returns at most 1,000), Alliance: ' || (select count(*) from attendance where tenant_id = current_setting('t.a')::uuid and term_id = current_setting('t.aterm')::uuid));
select pg_temp.check('Kijani Ridge: every class''s learners, register entries and invoices equal the raw sums (more than 1,000 register entries: none are cut off)',
  pg_temp.figures(current_setting('t.super')::uuid, current_setting('t.k')::uuid, current_setting('t.kterm')::uuid, null)
    = pg_temp.expected(current_setting('t.k')::uuid, current_setting('t.kterm')::uuid, null)
  and (select sum((x->>'att_total')::int) from jsonb_array_elements(pg_temp.expected(current_setting('t.k')::uuid, current_setting('t.kterm')::uuid, null)) x) > 1000);
select pg_temp.check('Alliance: the same, including the latest published exam''s marks (sum and count per class)',
  pg_temp.figures(current_setting('t.super')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)
    = pg_temp.expected(current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)
  and (select sum((x->>'mark_count')::int) from jsonb_array_elements(pg_temp.expected(current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x) > 0);
select pg_temp.check('without an exam the mark columns are zero',
  (select bool_and((x->>'mark_sum')::int = 0 and (x->>'mark_count')::int = 0)
     from jsonb_array_elements(pg_temp.figures(current_setting('t.super')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, null)) x));
select pg_temp.check('the whole-term fee totals (every invoice of the term) and the counts of unpaid, part paid, paid and owing invoices equal the raw figures',
  pg_temp.fees_as(current_setting('t.super')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid)
    = (select jsonb_build_object('billed', coalesce(sum(total_cents), 0), 'paid', coalesce(sum(paid_cents), 0), 'invoices', count(*),
                                 'nothing_paid', count(*) filter (where paid_cents = 0),
                                 'part_paid', count(*) filter (where paid_cents > 0 and paid_cents < total_cents),
                                 'full_paid', count(*) filter (where paid_cents >= total_cents and total_cents > 0),
                                 'owing', count(*) filter (where paid_cents < total_cents)) from fee_invoices
        where tenant_id = current_setting('t.a')::uuid and term_id = current_setting('t.aterm')::uuid)
  and (select count(*) from fee_invoices where tenant_id = current_setting('t.a')::uuid and term_id = current_setting('t.aterm')::uuid and paid_cents > 0 and paid_cents < total_cents) > 0
  and (pg_temp.fees_as(current_setting('t.super')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid)->>'billed')::bigint > 0);

-- ---------------------------------------------------------------- who gets what
select pg_temp.check('the school''s own admin gets exactly the figures the platform admin gets, for that school',
  pg_temp.figures(current_setting('t.admin')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)
    = pg_temp.figures(current_setting('t.super')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)
  and pg_temp.fees_as(current_setting('t.admin')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid)
    = pg_temp.fees_as(current_setting('t.super')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid));
select pg_temp.check('the group''s admin gets Kijani Ridge''s figures and none for Alliance, which is not in the group',
  pg_temp.figures(current_setting('t.org')::uuid, current_setting('t.k')::uuid, current_setting('t.kterm')::uuid, null)
    = pg_temp.figures(current_setting('t.super')::uuid, current_setting('t.k')::uuid, current_setting('t.kterm')::uuid, null)
  and pg_temp.figures(current_setting('t.org')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, null) = '[]'::jsonb);
select pg_temp.check('another school''s admin asking for this school gets no rows, and no fee row',
  pg_temp.figures(current_setting('t.kadmin')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid) = '[]'::jsonb
  and pg_temp.fees_as(current_setting('t.kadmin')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid) = '"no row"'::jsonb);
select pg_temp.check('a teacher with no area, a parent and a student get no rows and no fee row',
  pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid) = '[]'::jsonb
  and pg_temp.figures(current_setting('t.parent')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid) = '[]'::jsonb
  and pg_temp.figures(current_setting('t.student')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid) = '[]'::jsonb
  and pg_temp.fees_as(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid) = '"no row"'::jsonb
  and pg_temp.fees_as(current_setting('t.parent')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid) = '"no row"'::jsonb);

-- A member of staff with one area gets that part only.
insert into staff_permissions (tenant_id, profile_id, area) values (current_setting('t.a')::uuid, current_setting('t.teacher')::uuid, 'fees');
select pg_temp.check('a teacher given only the fees area gets the fee figures and nothing from attendance or marks',
  (select bool_and((x->>'att_total')::int = 0 and (x->>'mark_count')::int = 0)
     from jsonb_array_elements(pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x)
  and (select sum((x->>'billed')::bigint) from jsonb_array_elements(pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x)
    = (select sum((x->>'billed')::bigint) from jsonb_array_elements(pg_temp.expected(current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, null)) x)
  and (pg_temp.fees_as(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid)->>'billed')::bigint > 0);
update staff_permissions set area = 'attendance' where profile_id = current_setting('t.teacher')::uuid and tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('given only the attendance area, the same teacher gets the register counts and no fees or marks',
  (select bool_and((x->>'billed')::bigint = 0 and (x->>'paid')::bigint = 0 and (x->>'mark_count')::int = 0)
     from jsonb_array_elements(pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x)
  and (select sum((x->>'att_total')::int) from jsonb_array_elements(pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x)
    = (select sum((x->>'att_total')::int) from jsonb_array_elements(pg_temp.expected(current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, null)) x)
  and pg_temp.fees_as(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid) = '"no row"'::jsonb);
update staff_permissions set area = 'academics' where profile_id = current_setting('t.teacher')::uuid and tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('given only the academics area, the same teacher gets the marks and no fees or register counts',
  (select bool_and((x->>'billed')::bigint = 0 and (x->>'att_total')::int = 0)
     from jsonb_array_elements(pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x)
  and (select sum((x->>'mark_count')::int) from jsonb_array_elements(pg_temp.figures(current_setting('t.teacher')::uuid, current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x)
    = (select sum((x->>'mark_count')::int) from jsonb_array_elements(pg_temp.expected(current_setting('t.a')::uuid, current_setting('t.aterm')::uuid, current_setting('t.exam')::uuid)) x));

-- ---------------------------------------------------------------- nobody anonymous
select pg_temp.check('anon cannot execute either function; a signed-in user can',
  not has_function_privilege('anon', 'term_class_figures(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'term_fee_totals(uuid, uuid)', 'execute')
  and has_function_privilege('authenticated', 'term_class_figures(uuid, uuid, uuid)', 'execute')
  and has_function_privilege('authenticated', 'term_fee_totals(uuid, uuid)', 'execute'));

rollback;
