-- FIG-1400 and FIG-1410: which day a register belongs to, and which of two registers for the same learner and day stands.
--
-- FIG-1400. The app filed a register under the UTC date of the phone's clock. Nairobi is UTC+3, so from 00:00 to 02:59
-- there a register was filed under YESTERDAY and replaced yesterday's real one (one row per learner and day), and "register
-- is in" was answered from yesterday's rows. The database took any date it was given: 2034, a day before the term began, a
-- phone with the wrong date. Now:
--
--   * a school has a time zone (tenants.timezone, Africa/Nairobi unless set: every school so far is in Kenya, and the bus
--     and medical code already say Africa/Nairobi), and school_today(tenant) is today's date in it;
--   * a register's date must not be after school_today and must lie inside the term the register names. Either refusal
--     says so in words, and the phone keeps the register (it is set aside as refused, with that message);
--   * a register sent with no date is filed under school_today.
--
-- FIG-1410. A register held on a phone (no signal) is sent when the phone reconnects, as an upsert, so the last one to ARRIVE
-- won: the office corrects a learner at 08:30, the teacher's phone from 08:00 reconnects at 09:00, and the correction is gone.
-- Now every register row carries marked_at, the time it was taken (the apps stamp it when the teacher submits). An update with
-- an OLDER marked_at than the stored row is ignored: the newer register stands, whatever order they arrive in. A row with no
-- stamp of its own counts as taken now (the same register sent twice is not an edit and keeps its time). A stamp in the future (a phone clock that is ahead) is cut back to now, so it cannot
-- beat a later edit. Rows already stored take created_at as their marked_at.
--
-- supabase/rls-checks/attendance.sql, tests/integration/attendance.test.ts and packages/shared/src/attendanceDates.test.ts
-- check both.

-- ------------------------------------------------------------------ a school's time zone
alter table tenants add column if not exists timezone text not null default 'Africa/Nairobi';

create or replace function tenants_timezone_is_real() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists tenants_timezone_is_real on tenants;
create trigger tenants_timezone_is_real before insert or update of timezone on tenants
  for each row execute function tenants_timezone_is_real();

-- Today's date in the school's own time zone.
create or replace function school_today(p_tenant uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select t.timezone from tenants t where t.id = p_tenant), 'Africa/Nairobi'))::date
$$;

-- The audit log lists which columns a change touched ("Attendance: 43 records changed (mark)"). marked_at moves on every save, so
-- it is left out the same way updated_at is, or every register edit would read "(mark, marked at)" and a re-save of the same
-- marks would be logged as a change. Done on the function's current text, and stops if the line is not there.
do $$
declare
  def text := pg_get_functiondef('audit_table_change'::regproc);
  old_line constant text := $m$where e.key <> 'updated_at' and e.value is distinct from n.j -> e.key$m$;
begin
  if position(old_line in def) = 0 then
    raise exception 'audit_table_change no longer has the line this migration changes: %', old_line;
  end if;
  execute replace(def, old_line, $m$where e.key not in ('updated_at', 'marked_at') and e.value is distinct from n.j -> e.key$m$);
end $$;

-- ------------------------------------------------------------------ attendance
alter table attendance add column if not exists marked_at timestamptz;
-- Rows already stored take the time they were created. The triggers are off for this one statement: nothing they guard moves (no
-- mark, class, date or term), but the audit trigger alone costs about 3 ms a row and would log "N records changed" for every school.
alter table attendance disable trigger user;
update attendance set marked_at = created_at where marked_at is null;
alter table attendance enable trigger user;
alter table attendance alter column marked_at set not null;
alter table attendance alter column marked_at set default now();

create or replace function attendance_day_and_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_today date;
  v_term  terms%rowtype;
begin
  v_today := school_today(new.tenant_id);

  -- the day
  if tg_op = 'INSERT' and new.taken_on is null then
    new.taken_on := v_today;
  end if;
  if tg_op = 'INSERT' or new.taken_on is distinct from old.taken_on or new.term_id is distinct from old.term_id then
    if new.taken_on > v_today then
      raise exception 'This register is dated % but today is %: check the date on this phone',
        to_char(new.taken_on, 'DD Mon YYYY'), to_char(v_today, 'DD Mon YYYY') using errcode = '23514';
    end if;
    select * into v_term from terms where id = new.term_id;
    if found and (new.taken_on < v_term.starts_on or new.taken_on > v_term.ends_on) then
      raise exception 'This register is dated %, which is outside the term "%" (% to %)',
        to_char(new.taken_on, 'DD Mon YYYY'), v_term.name,
        to_char(v_term.starts_on, 'DD Mon YYYY'), to_char(v_term.ends_on, 'DD Mon YYYY') using errcode = '23514';
    end if;
  end if;

  -- which register stands
  if tg_op = 'INSERT' then
    new.marked_at := least(coalesce(new.marked_at, now()), now());
  elsif new.marked_at is not distinct from old.marked_at then
    -- The stamp did not move. If the row did, it is an edit with no stamp of its own: made now. If nothing did, it is the same
    -- register sent again (a reply that was lost, a retry): it changes nothing and keeps its time, or it would jump ahead of a
    -- correction made in between and held on another phone.
    if to_jsonb(new) - 'marked_at' is distinct from to_jsonb(old) - 'marked_at' then
      new.marked_at := now();
    end if;
  elsif new.marked_at < old.marked_at then
    return old;                          -- a register held since before the stored one: the newer one stands
  else
    new.marked_at := least(new.marked_at, now());
  end if;
  return new;
end $$;

drop trigger if exists attendance_day_and_order on attendance;
create trigger attendance_day_and_order before insert or update on attendance
  for each row execute function attendance_day_and_order();

-- Only the database itself calls these: school_today answers for any school id it is given, so no signed-in user may call it
-- (supabase/rls-checks/tenant_matrix.sql checks that no function answers for another school). The trigger runs it as its owner.
revoke execute on function school_today(uuid), attendance_day_and_order(), tenants_timezone_is_real() from public, anon, authenticated;
grant execute on function school_today(uuid) to service_role;
