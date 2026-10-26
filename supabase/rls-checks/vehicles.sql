-- Driver vehicle-column checks for 20261026060000_driver_vehicle_columns.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/vehicles.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
-- a driver and the vehicle they are assigned to
select set_config('t.driver',  (select a.driver_id::text from vehicle_assignments a join vehicles v on v.id = a.vehicle_id
                                 where a.active and v.tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.veh',     (select a.vehicle_id::text from vehicle_assignments a
                                 where a.active and a.driver_id = current_setting('t.driver')::uuid limit 1), true);
-- a vehicle in the same school that this driver is NOT assigned to
insert into vehicles (tenant_id, plate_number) values (current_setting('t.a')::uuid, 'KZZ 999Z');
select set_config('t.other',   (select id::text from vehicles where plate_number = 'KZZ 999Z'), true);
select set_config('t.limit',   (select speed_limit_kmh::text from vehicles where id = current_setting('t.veh')::uuid), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
-- A statement that must be refused with this SQLSTATE.
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;
create function pg_temp.expect_rows(label text, stmt text, expected bigint) returns void language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: % rows, expected %', label, n, expected; end if;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.check('the fixture has a driver with a vehicle', current_setting('t.veh', true) <> '' and current_setting('t.driver', true) <> '');

-- ---------------------------------------------------------------- the driver
select pg_temp.act_as(current_setting('t.driver'));
set local role authenticated;

select pg_temp.expect_rows('a driver can mirror a GPS reading onto their vehicle',
  format($q$update vehicles set last_lat = -1.29, last_lng = 36.82, last_ping_at = now() where id = %L$q$, current_setting('t.veh')), 1);
select pg_temp.expect_error('a driver cannot raise the speed limit',
  format($q$update vehicles set speed_limit_kmh = 200 where id = %L$q$, current_setting('t.veh')), '42501');
select pg_temp.expect_error('a driver cannot deactivate the vehicle',
  format($q$update vehicles set active = false where id = %L$q$, current_setting('t.veh')), '42501');
select pg_temp.expect_error('a driver cannot change the plate',
  format($q$update vehicles set plate_number = 'KXX 000X' where id = %L$q$, current_setting('t.veh')), '42501');
select pg_temp.expect_error('a driver cannot change capacity',
  format($q$update vehicles set capacity = 999 where id = %L$q$, current_setting('t.veh')), '42501');
select pg_temp.expect_error('a position update cannot carry a speed-limit change with it',
  format($q$update vehicles set last_lat = -1.3, speed_limit_kmh = 200 where id = %L$q$, current_setting('t.veh')), '42501');
select pg_temp.expect_rows('a driver cannot touch a vehicle they are not assigned to (no row visible to update)',
  format($q$update vehicles set last_lat = -1.0 where id = %L$q$, current_setting('t.other')), 0);

reset role;
select pg_temp.check('the speed limit is unchanged after the attempts',
  (select speed_limit_kmh::text from vehicles where id = current_setting('t.veh')::uuid) = current_setting('t.limit'));

-- ---------------------------------------------------------------- the office
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_rows('the school admin can change a vehicle''s speed limit',
  format($q$update vehicles set speed_limit_kmh = 60 where id = %L$q$, current_setting('t.veh')), 1);
reset role;
select pg_temp.check('the new limit is stored', (select speed_limit_kmh = 60 from vehicles where id = current_setting('t.veh')::uuid));

rollback;
