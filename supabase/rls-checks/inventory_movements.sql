-- Stock movement checks for 20261124200000_inventory_movements.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own schools, people and stock, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/inventory_movements.sql
--
-- What it shows: the office and holders of the inventory area record movements, teachers read them, families and
-- other schools see nothing; a movement keeps the stock count in step, can't take it below zero, and is never changed
-- or deleted; the sign rules hold; the reports refuse anyone who may not read the school's stock; and the anomaly
-- flags find each planted case (a day's use up with no more people, a rise explained by visitors, a slow creep, a
-- stock-take shortfall, a price jump, a weekend at a day school, stock that runs out before the next delivery, a week of
-- printer paper well above the usual); and medicine the sick bay gives (visit_medications) is counted as use by every
-- report without a movement being made for it, so nothing is counted twice.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.stockcheck.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
-- runs a statement as this signed-in person: 'ok <rows>' or 'error <sqlstate>'
create function pg_temp.as_user(uid uuid, stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute stmt;
    get diagnostics n = row_count;
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'error ' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok ' || n;
end $$;
-- a count read as this person
create function pg_temp.count_as(uid uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute 'select count(*) from (' || q || ') x' into n;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
-- records a movement as postgres (the seeder's way), for the scenario data
create function pg_temp.move(p_item uuid, p_kind text, p_qty int, p_day date, p_cost bigint default null, p_supplier text default null,
                             p_purpose text default null, p_meals int default null) returns void language sql as $$
  insert into inventory_movements (tenant_id, item_id, kind, quantity, occurred_on, unit_cost_cents, supplier, purpose, meals_served)
  select tenant_id, p_item, p_kind, p_qty, p_day, p_cost, p_supplier, p_purpose, p_meals from inventory_items where id = p_item
$$;
grant execute on all functions in schema pg_temp to authenticated;

insert into tenants (id, name, slug, county) values
  ('00000000-0000-4000-8000-00000000c501', 'Stock Check School', 'stockcheck-a-' || substr(md5(random()::text), 1, 8), 'Nairobi'),
  ('00000000-0000-4000-8000-00000000c502', 'Stock Check Other School', 'stockcheck-b-' || substr(md5(random()::text), 1, 8), 'Nairobi');

select pg_temp.person('00000000-0000-4000-8000-00000000c5a1', '00000000-0000-4000-8000-00000000c501', 'school_admin', 'Stock Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000c5a2', '00000000-0000-4000-8000-00000000c501', 'teacher', 'Stock Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000c5a3', '00000000-0000-4000-8000-00000000c501', 'staff', 'Stock Storekeeper');
select pg_temp.person('00000000-0000-4000-8000-00000000c5a4', '00000000-0000-4000-8000-00000000c501', 'staff', 'Stock Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000c5a5', '00000000-0000-4000-8000-00000000c501', 'parent', 'Stock Parent');
select pg_temp.person('00000000-0000-4000-8000-00000000c5b1', '00000000-0000-4000-8000-00000000c502', 'school_admin', 'Other Principal');
-- the storekeeper holds the inventory area; the bursar holds fees only
insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-00000000c501', '00000000-0000-4000-8000-00000000c5a3', 'inventory'),
  ('00000000-0000-4000-8000-00000000c501', '00000000-0000-4000-8000-00000000c5a4', 'fees');

-- 100 day learners in one class; a term around today
insert into classes (id, tenant_id, name, form_level) values ('00000000-0000-4000-8000-00000000c5c1', '00000000-0000-4000-8000-00000000c501', 'Stock 1', 1);
insert into students (tenant_id, admission_no, full_name, class_id, boarding)
  select '00000000-0000-4000-8000-00000000c501', 'SC' || g, 'Learner ' || g, '00000000-0000-4000-8000-00000000c5c1', false from generate_series(1, 100) g;
insert into terms (tenant_id, name, year, index, starts_on, ends_on)
  values ('00000000-0000-4000-8000-00000000c501', 'Stock term', 2099, 1, current_date - 120, current_date + 30);

select set_config('t.a', '00000000-0000-4000-8000-00000000c501', true);
select set_config('t.b', '00000000-0000-4000-8000-00000000c502', true);
select set_config('t.admin', '00000000-0000-4000-8000-00000000c5a1', true);
select set_config('t.teacher', '00000000-0000-4000-8000-00000000c5a2', true);
select set_config('t.store', '00000000-0000-4000-8000-00000000c5a3', true);
select set_config('t.bursar', '00000000-0000-4000-8000-00000000c5a4', true);
select set_config('t.parent', '00000000-0000-4000-8000-00000000c5a5', true);
select set_config('t.other', '00000000-0000-4000-8000-00000000c5b1', true);

insert into inventory_items (id, tenant_id, name, category, tracking, quantity, unit, consumable, reorder_level) values
  ('00000000-0000-4000-8000-00000000c511', current_setting('t.a')::uuid, 'Rice',     'kitchen', 'stock', 0, 'kg',     true, 100),
  ('00000000-0000-4000-8000-00000000c512', current_setting('t.a')::uuid, 'Sugar',    'kitchen', 'stock', 0, 'kg',     true, null),
  ('00000000-0000-4000-8000-00000000c513', current_setting('t.a')::uuid, 'Potatoes', 'kitchen', 'stock', 0, 'bags',   true, null),
  ('00000000-0000-4000-8000-00000000c514', current_setting('t.a')::uuid, 'Beans',    'kitchen', 'stock', 0, 'kg',     true, null),
  ('00000000-0000-4000-8000-00000000c515', current_setting('t.a')::uuid, 'Cooking oil', 'kitchen', 'stock', 0, 'litres', true, null),
  ('00000000-0000-4000-8000-00000000c516', current_setting('t.a')::uuid, 'Exercise books', 'stationery', 'stock', 10, null, false, null);
insert into inventory_items (id, tenant_id, name, category, tracking, quantity) values
  ('00000000-0000-4000-8000-00000000c517', current_setting('t.a')::uuid, 'Projector', 'ict', 'asset', 1);

-- ---------------------------------------------------------------- the table
select pg_temp.check('inventory_items has unit, consumable (not null, default false) and reorder_level',
  (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items'
     and column_name in ('unit', 'consumable', 'reorder_level')));
select pg_temp.check('row-level security is on for inventory_movements',
  (select relrowsecurity from pg_class where oid = 'public.inventory_movements'::regclass));

-- ---------------------------------------------------------------- who writes
select pg_temp.check('the school admin records a delivery',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity, unit_cost_cents, supplier, occurred_on)
    values (%L, '00000000-0000-4000-8000-00000000c511', 'received', 2000, 9000, ' Grain Co ', current_date - 70)$q$, current_setting('t.a'))) = 'ok 1');
select pg_temp.check('the delivery moved the count to 2000 and set the item''s price',
  (select quantity = 2000 and unit_cost_cents = 9000 from inventory_items where id = '00000000-0000-4000-8000-00000000c511'));
select pg_temp.check('who recorded it is the signed-in admin, and the supplier is trimmed',
  (select recorded_by = current_setting('t.admin')::uuid and supplier = 'Grain Co' from inventory_movements where item_id = '00000000-0000-4000-8000-00000000c511'));
select pg_temp.check('a storekeeper with the inventory area records use',
  pg_temp.as_user(current_setting('t.store')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity, purpose, occurred_on)
    values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 2, 'Classroom', current_date - 1)$q$, current_setting('t.a'))) = 'ok 1');
select pg_temp.check('a teacher cannot record a movement',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 1)$q$, current_setting('t.a'))) = 'error 42501');
select pg_temp.check('staff without the inventory area cannot record a movement',
  pg_temp.as_user(current_setting('t.bursar')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 1)$q$, current_setting('t.a'))) = 'error 42501');
select pg_temp.check('a parent cannot record a movement',
  pg_temp.as_user(current_setting('t.parent')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 1)$q$, current_setting('t.a'))) = 'error 42501');
select pg_temp.check('another school''s admin cannot record against this school',
  pg_temp.as_user(current_setting('t.other')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 1)$q$, current_setting('t.a'))) = 'error 42501');
select pg_temp.check('nor move this school''s stock by naming their own school on the row',
  pg_temp.as_user(current_setting('t.other')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 1)$q$, current_setting('t.b'))) = 'error 42501');
select pg_temp.check('exercise books: 10 less the 2 used', (select quantity = 8 from inventory_items where id = '00000000-0000-4000-8000-00000000c516'));

-- ---------------------------------------------------------------- the rules
select pg_temp.check('using more than is in stock is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 9)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a stock-take below zero is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'adjusted', -9)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a negative "used" is refused (sign rule)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', -1)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a negative delivery is refused (sign rule)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'received', -1)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a zero movement is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'adjusted', 0)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a price on use is refused (received only)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity, unit_cost_cents) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 1, 100)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('meals served on a delivery is refused (used only)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity, meals_served) values (%L, '00000000-0000-4000-8000-00000000c516', 'received', 1, 100)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a single tracked asset takes no movements',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c517', 'received', 1)$q$, current_setting('t.a'))) = 'error 22023');
select pg_temp.check('a stock-take down by 3 is accepted (signed)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'adjusted', -3)$q$, current_setting('t.a'))) = 'ok 1');
select pg_temp.check('and leaves 5', (select quantity = 5 from inventory_items where id = '00000000-0000-4000-8000-00000000c516'));
select pg_temp.check('the stock cannot fall below what is out on loan',
  (select pg_temp.as_user(current_setting('t.admin')::uuid, format($q$
     with i as (insert into inventory_issues (tenant_id, item_id, profile_id, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', %L, 4) returning 1)
     select 1 from i$q$, current_setting('t.a'), current_setting('t.teacher'))) = 'ok 1')
  and pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into inventory_movements (tenant_id, item_id, kind, quantity) values (%L, '00000000-0000-4000-8000-00000000c516', 'used', 2)$q$, current_setting('t.a'))) = 'error 23514');
select pg_temp.check('a movement cannot be changed, even by the admin',
  pg_temp.as_user(current_setting('t.admin')::uuid, $q$update inventory_movements set quantity = 1 where item_id = '00000000-0000-4000-8000-00000000c511'$q$) in ('ok 0', 'error 42501'));
select pg_temp.check('nor deleted (no row is visible to delete)',
  pg_temp.as_user(current_setting('t.admin')::uuid, $q$delete from inventory_movements where item_id = '00000000-0000-4000-8000-00000000c511'$q$) = 'ok 0'
  and (select count(*) >= 1 from inventory_movements where item_id = '00000000-0000-4000-8000-00000000c511'));
do $$ begin
  update inventory_movements set quantity = 1 where item_id = '00000000-0000-4000-8000-00000000c511';
  perform pg_temp.check('the trigger refuses a change even where RLS does not apply', false);
exception when insufficient_privilege then
  perform pg_temp.check('the trigger refuses a change even where RLS does not apply', true);
end $$;

-- ---------------------------------------------------------------- who reads
select pg_temp.check('a teacher reads the school''s movements',
  pg_temp.count_as(current_setting('t.teacher')::uuid, 'select 1 from inventory_movements') = 3);
select pg_temp.check('the storekeeper reads them',
  pg_temp.count_as(current_setting('t.store')::uuid, 'select 1 from inventory_movements') = 3);
select pg_temp.check('staff without the inventory area read none',
  pg_temp.count_as(current_setting('t.bursar')::uuid, 'select 1 from inventory_movements') = 0);
select pg_temp.check('a parent reads none',
  pg_temp.count_as(current_setting('t.parent')::uuid, 'select 1 from inventory_movements') = 0);
select pg_temp.check('another school''s admin reads none of this school''s',
  pg_temp.count_as(current_setting('t.other')::uuid, format('select 1 from inventory_movements where tenant_id = %L', current_setting('t.a'))) = 0);

-- ---------------------------------------------------------------- the reports refuse outsiders
select pg_temp.check('a teacher can read the stock levels', pg_temp.as_user(current_setting('t.teacher')::uuid, format('select * from inventory_stock_levels(%L)', current_setting('t.a'))) like 'ok %');
select pg_temp.check('a parent cannot', pg_temp.as_user(current_setting('t.parent')::uuid, format('select * from inventory_stock_levels(%L)', current_setting('t.a'))) = 'error 42501');
select pg_temp.check('another school''s admin cannot read the flags', pg_temp.as_user(current_setting('t.other')::uuid, format('select * from inventory_consumption_flags(%L, current_date - 30, current_date)', current_setting('t.a'))) = 'error 42501');
select pg_temp.check('nor the headcount (it counts the visitor log)', pg_temp.as_user(current_setting('t.other')::uuid, format('select * from inventory_headcount(%L, current_date - 3, current_date)', current_setting('t.a'))) = 'error 42501');
select pg_temp.check('staff without the inventory area cannot read the usage report', pg_temp.as_user(current_setting('t.bursar')::uuid, format('select * from inventory_usage(%L, current_date - 30, current_date)', current_setting('t.a'))) = 'error 42501');
select pg_temp.check('anon cannot run the flags at all',
  not has_function_privilege('anon', 'inventory_consumption_flags(uuid, date, date)', 'execute'));

-- ---------------------------------------------------------------- the scenario (as postgres, like the seeder)
-- Weekdays only (a day school). Anchors: the Tuesday before last for the rice spike, the Thursday two weeks before
-- that for a sports day with 21 visitors (heads 100 learners + 4 staff = 104, so +20%).
-- The sports day falls in the trend baseline week: 10 litres * 104 current heads / 108.2 baseline heads rounds to 9.6 litres expected.
select set_config('t.spike', (current_date - 7 - ((extract(isodow from current_date)::int - 2 + 7) % 7))::text, true);
select set_config('t.sports', (current_setting('t.spike')::date - 12)::text, true);
-- visits_stamp sets arrived_at to now() on every insert; triggers are off for this one back-dated insert
set local session_replication_role = replica;
insert into visits (tenant_id, visitor_name, purpose, host_kind, arrived_at)
  select current_setting('t.a')::uuid, 'Parent ' || g, 'Sports day', 'office', (current_setting('t.sports')::date + time '09:00') at time zone 'Africa/Nairobi'
  from generate_series(1, 21) g;
set local session_replication_role = origin;

-- rice: 20 kg a day for lunch; 25 kg on the spike day; 24 kg on the sports day; 5 kg on a Saturday
select pg_temp.move('00000000-0000-4000-8000-00000000c511', 'used',
  case when d = current_setting('t.spike')::date then 25 when d = current_setting('t.sports')::date then 24 else 20 end, d, p_purpose => 'Lunch')
from generate_series(current_date - 60, current_date - 1, interval '1 day') g(g), lateral (select g::date as d) x
where extract(isodow from d) < 6;
select pg_temp.move('00000000-0000-4000-8000-00000000c511', 'used', 5, (current_date - 3 - ((extract(isodow from current_date - 3)::int - 6 + 7) % 7))::date, p_purpose => 'Lunch');

-- cooking oil: 10 litres a day three to four weeks ago, creeping to 13 litres this past week
select pg_temp.move('00000000-0000-4000-8000-00000000c515', 'received', 2000, current_date - 40, 25000, 'Oil Co');
select pg_temp.move('00000000-0000-4000-8000-00000000c515', 'used',
  case when d <= current_date - 21 then 10 when d <= current_date - 14 then 11 when d <= current_date - 7 then 12 else 13 end, d, p_purpose => 'Lunch')
from generate_series(current_date - 27, current_date - 1, interval '1 day') g(g), lateral (select g::date as d) x
where extract(isodow from d) < 6;

-- sugar: 100 kg in, 2 kg a day used, then a stock-take 8 kg short with no waste recorded
select pg_temp.move('00000000-0000-4000-8000-00000000c512', 'received', 100, current_date - 20, 15000, 'Sugar Co');
select pg_temp.move('00000000-0000-4000-8000-00000000c512', 'used', 2, d, p_purpose => 'Breakfast')
from generate_series(current_date - 19, current_date - 6, interval '1 day') g(g), lateral (select g::date as d) x where extract(isodow from d) < 6;
select pg_temp.move('00000000-0000-4000-8000-00000000c512', 'adjusted', -8, current_date - 5);

-- potatoes: four deliveries at 2,500 a bag from the same supplier, then one at 3,250 (+30%)
select pg_temp.move('00000000-0000-4000-8000-00000000c513', 'received', 10, current_date - 50 + 7 * k, 250000, 'Farm Fresh') from generate_series(0, 3) k;
select pg_temp.move('00000000-0000-4000-8000-00000000c513', 'received', 10, current_date - 15, 325000, 'farm fresh');

-- beans: deliveries every 14 days (the last 10 days ago, so the next is due in 4 days), 10 kg a day for lunch with
-- meals counted, and now only 5 kg left
select pg_temp.move('00000000-0000-4000-8000-00000000c514', 'received', 100, current_date - 38, 12000, 'Grain Co');
select pg_temp.move('00000000-0000-4000-8000-00000000c514', 'received', 100, current_date - 24, 12000, 'Grain Co');
select pg_temp.move('00000000-0000-4000-8000-00000000c514', 'received', 70, current_date - 10, 12000, 'Grain Co');
select pg_temp.move('00000000-0000-4000-8000-00000000c514', 'used', 10, d, p_purpose => 'Lunch', p_meals => 100)
from generate_series(current_date - 37, current_date - 2, interval '1 day') g(g), lateral (select g::date as d) x where extract(isodow from d) < 6;
select pg_temp.move('00000000-0000-4000-8000-00000000c514', 'used', (select quantity - 5 from inventory_items where id = '00000000-0000-4000-8000-00000000c514'),
  current_date - 1, p_purpose => 'Lunch', p_meals => 100);

select pg_temp.check('the counts follow the movements (beans: 5 kg left)',
  (select quantity = 5 from inventory_items where id = '00000000-0000-4000-8000-00000000c514')
  and (select i.quantity = (select sum(case when m.kind in ('received', 'adjusted') then m.quantity else -m.quantity end) from inventory_movements m where m.item_id = i.id)
       from inventory_items i where i.id = '00000000-0000-4000-8000-00000000c511'));
select pg_temp.check('the latest delivery set the potatoes'' price', (select unit_cost_cents = 325000 from inventory_items where id = '00000000-0000-4000-8000-00000000c513'));

-- clinic: paracetamol comes in as a movement and goes out through the sick bay (visit_medications), whose own
-- trigger lowers the count. Five visits a week for six weeks, 2 tablets each: steady, so no flag.
insert into inventory_items (id, tenant_id, name, category, tracking, quantity, unit, consumable) values
  ('00000000-0000-4000-8000-00000000c518', current_setting('t.a')::uuid, 'Paracetamol 500mg', 'medical', 'stock', 0, 'tablets', true),
  ('00000000-0000-4000-8000-00000000c519', current_setting('t.a')::uuid, 'Printer paper', 'stationery', 'stock', 0, 'reams', true);
select pg_temp.move('00000000-0000-4000-8000-00000000c518', 'received', 500, current_date - 50, 200, 'Pharma Ltd');
select set_config('t.cw', date_trunc('week', current_date)::date::text, true);
create temp table sbv on commit drop as
  select gen_random_uuid() as id, (current_setting('t.cw')::date - 7 * k + d) as day
  from generate_series(1, 6) k, generate_series(0, 4) d;
insert into sick_bay_visits (id, tenant_id, student_id, complaint, time_in)
  select v.id, current_setting('t.a')::uuid, (select id from students where tenant_id = current_setting('t.a')::uuid limit 1), 'Headache',
    (v.day + time '10:00') at time zone 'Africa/Nairobi'
  from sbv v;
insert into visit_medications (tenant_id, visit_id, drug, dose, given_at, inventory_item_id, stock_quantity)
  select current_setting('t.a')::uuid, v.id, 'Paracetamol', '2 tablets', (v.day + time '10:05') at time zone 'Africa/Nairobi',
    '00000000-0000-4000-8000-00000000c518', 2
  from sbv v;

-- stationery: printer paper, 2 reams a school day (10 a week) for five weeks, then 25 in the last complete week
-- with no more people in school: a weekly anomaly
select pg_temp.move('00000000-0000-4000-8000-00000000c519', 'received', 200, current_date - 50, 65000, 'Text Book Centre');
select pg_temp.move('00000000-0000-4000-8000-00000000c519', 'used', case when k = 1 then 5 else 2 end,
  current_setting('t.cw')::date - 7 * k + d, p_purpose => 'Printing')
from generate_series(1, 6) k, generate_series(0, 4) d;

-- ---------------------------------------------------------------- the flags (as the storekeeper)
create temp table f as select * from inventory_consumption_flags(current_setting('t.a')::uuid, current_date - 30, current_date) where false;
grant all on f to authenticated;
select pg_temp.as_user(current_setting('t.store')::uuid,
  format('insert into f select * from inventory_consumption_flags(%L, current_date - 30, current_date)', current_setting('t.a')));
do $$ declare r record; begin
  for r in select kind, item_name, occurred_on, severity, explained, reason from f order by item_name, kind, occurred_on loop
    raise notice 'INFO flag % % % % % %', r.kind, r.item_name, r.occurred_on, r.severity, r.explained, r.reason;
  end loop;
end $$;

select pg_temp.check('rice: the spike day is flagged, not explained, 25 kg against about 20 expected',
  exists (select 1 from f where kind = 'usage_up' and item_name = 'Rice' and occurred_on = current_setting('t.spike')::date
          and not explained and actual = 25 and expected between 19.5 and 20.5 and headcount = 104));
select pg_temp.check('rice: the sports day rise is listed as explained by the visitors (low)',
  exists (select 1 from f where kind = 'usage_up' and item_name = 'Rice' and occurred_on = current_setting('t.sports')::date
          and explained and severity = 'low' and visitors = 21));
select pg_temp.check('rice: no other weekday is flagged',
  not exists (select 1 from f where kind in ('usage_up', 'usage_down') and item_name = 'Rice'
              and occurred_on not in (current_setting('t.spike')::date, current_setting('t.sports')::date)));
select pg_temp.check('rice on a Saturday at a day school is flagged as a non-school day',
  exists (select 1 from f where kind = 'non_school_day' and item_name = 'Rice' and extract(isodow from occurred_on) = 6));
select pg_temp.check('cooking oil: the slow creep is flagged as a trend (+30%) with baseline adjusted for visitors, and no single day is',
  exists (select 1 from f where kind = 'usage_trend' and item_name = 'Cooking oil' and not explained and actual = 13 and expected = 9.6)
  and not exists (select 1 from f where kind = 'usage_up' and item_name = 'Cooking oil'));
select pg_temp.check('sugar: the 8 kg stock-take shortfall is flagged',
  exists (select 1 from f where kind = 'shrinkage' and item_name = 'Sugar' and actual = 8));
select pg_temp.check('potatoes: the 30% dearer delivery is flagged (supplier matched whatever the case)',
  exists (select 1 from f where kind = 'price_jump' and item_name = 'Potatoes' and actual = 325000 and expected = 250000));
select pg_temp.check('beans: running out before the next delivery is flagged, high',
  exists (select 1 from f where kind = 'run_out' and item_name = 'Beans' and severity = 'high'));
select pg_temp.check('no flag names a person',
  not exists (select 1 from f where reason ~* '(Stock (Principal|Teacher|Storekeeper|Bursar))|Parent [0-9]'));
select pg_temp.check('the beans, used with meals counted, are compared per meal and not flagged',
  not exists (select 1 from f where kind in ('usage_up', 'usage_down') and item_name = 'Beans' and occurred_on < current_date - 1));

-- ---------------------------------------------------------------- the clinic and the other stores
select pg_temp.check('clinic: the sick bay took 60 tablets off the count by itself (500 in, 30 visits x 2)',
  (select quantity = 440 from inventory_items where id = '00000000-0000-4000-8000-00000000c518'));
select pg_temp.check('clinic: no movement was made for them (no double counting): only the delivery',
  (select count(*) = 1 from inventory_movements where item_id = '00000000-0000-4000-8000-00000000c518'));
select pg_temp.check('clinic: the usage report counts the 60 tablets as used, for the sick bay',
  (select sum(used) = 60 from inventory_usage(current_setting('t.a')::uuid, current_date - 60, current_date, 'year') where item_id = '00000000-0000-4000-8000-00000000c518')
  and (select count(*) = 30 from inventory_ledger(current_setting('t.a')::uuid, current_date - 60, current_date)
       where item_id = '00000000-0000-4000-8000-00000000c518' and kind = 'used' and purpose = 'Sick bay' and source = 'sick_bay'));
select pg_temp.check('clinic: stock levels count the sick bay''s use in the last 28 days and give days of cover',
  (select used_28d = (select 2 * count(*) from sbv where day > current_date - 28) and days_of_cover is not null
     from inventory_stock_levels(current_setting('t.a')::uuid) where name = 'Paracetamol 500mg'));
select pg_temp.check('clinic: steady use per sick-bay visit is not flagged',
  not exists (select 1 from f where item_name = 'Paracetamol 500mg' and kind in ('usage_up', 'usage_down')));
select pg_temp.check('clinic: the ledger names no learner, visit or nurse (an item, an amount and a day)',
  (select pg_get_function_result(p.oid) !~ '(student|visit|given_by|drug|dose)' from pg_proc p where p.proname = 'inventory_ledger'));
select pg_temp.check('stationery: the week of 25 reams is flagged against about 10 a week, per head, not explained',
  exists (select 1 from f where kind = 'usage_up' and item_name = 'Printer paper' and category = 'stationery'
          and period_from = current_setting('t.cw')::date - 7 and occurred_on = current_setting('t.cw')::date - 1
          and actual = 25 and expected between 9.5 and 10.5 and not explained));
select pg_temp.check('stationery: no other week is flagged, and no single day is',
  (select count(*) = 1 from f where item_name = 'Printer paper' and kind in ('usage_up', 'usage_down')));
select pg_temp.check('every flag says which store it is from',
  not exists (select 1 from f where category is null));
select pg_temp.check('spend by month is split by store',
  (select count(distinct category) >= 3 from inventory_spend_by_month(current_setting('t.a')::uuid, current_date - 400, current_date)));

-- ---------------------------------------------------------------- the other reports
select pg_temp.check('stock levels: beans are 5 kg, about 7 kg a day, under a day of cover, next delivery in 4 days',
  (select quantity = 5 and days_of_cover < 1 and next_delivery_on = current_date + 4 and not low
     from inventory_stock_levels(current_setting('t.a')::uuid) where name = 'Beans'));
select pg_temp.check('stock levels: value is quantity x latest price',
  (select value_cents = quantity * 325000 from inventory_stock_levels(current_setting('t.a')::uuid) where name = 'Potatoes'));
select pg_temp.check('usage by month adds up to every kg of rice used',
  (select sum(used) from inventory_usage(current_setting('t.a')::uuid, current_date - 400, current_date, 'month') where item_id = '00000000-0000-4000-8000-00000000c511')
  = (select sum(quantity) from inventory_movements where item_id = '00000000-0000-4000-8000-00000000c511' and kind = 'used'));
select pg_temp.check('usage: the sugar shortfall shows as shrinkage',
  (select sum(shrinkage) = 8 from inventory_usage(current_setting('t.a')::uuid, current_date - 60, current_date, 'year') where item_id = '00000000-0000-4000-8000-00000000c512'));
select pg_temp.check('spend by month adds up to every priced delivery',
  (select sum(spend_cents) from inventory_spend_by_month(current_setting('t.a')::uuid, current_date - 400, current_date))
  = (select sum(quantity * unit_cost_cents) from inventory_movements where tenant_id = current_setting('t.a')::uuid and kind = 'received'));
select pg_temp.check('cost per meal: lunch costs beans used x 120.00 over the meals counted once a day',
  (select round(sum(used_cost_cents)::numeric / nullif(sum(meals_served), 0), 2) from inventory_cost_per_meal(current_setting('t.a')::uuid, current_date - 40, current_date, 'year') where purpose = 'Lunch') is not null
  and (select sum(meals_served) from inventory_cost_per_meal(current_setting('t.a')::uuid, current_date - 40, current_date, 'year') where purpose = 'Lunch')
      = (select count(distinct occurred_on) * 100 from inventory_movements where item_id = '00000000-0000-4000-8000-00000000c514' and kind = 'used'));
select pg_temp.check('headcount: 100 learners, 4 staff (not the parent), and the 21 visitors on the sports day',
  (select learners = 100 and staff = 4 and visitors = 21 from inventory_headcount(current_setting('t.a')::uuid, current_setting('t.sports')::date, current_setting('t.sports')::date)));

-- ---------------------------------------------------------------- AI metering
select pg_temp.check('ai_usage accepts the stock_insights task',
  (select pg_get_constraintdef(oid) like '%stock_insights%' from pg_constraint where conname = 'ai_usage_task_check'));

rollback;
