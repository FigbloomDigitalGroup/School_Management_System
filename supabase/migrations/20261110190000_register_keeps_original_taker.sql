-- FIG-1406: correcting a register leaves a trace, and the row keeps the name of the person who took it.
--
-- A register is an official record. The screen saves it as an upsert that sends taken_by, so when the office, or another teacher of the
-- class, corrected a mark the row began to say the corrector had TAKEN the register, and who really took it was gone from the row. (The
-- other half of the issue, that nothing was logged, was done by 20261104000000: every table has an audit trigger, so a correction is
-- already "Attendance: 1 record changed (mark)" with who changed it, when, and the mark from and to.)
--
-- Now an update leaves taken_by as it was. It is who took the register, whoever changes a mark afterwards; the audit log names the one
-- who changed it.
--
--   * Only for someone signed in (auth.uid() is not null). The service role and the database owner can still change taken_by, which is
--     how an account with registers on file is handed over before it can be removed (attendance.taken_by is on delete restrict, and
--     delete-account tells the admin to "reassign or clear those first"). The same rule entered_by_is_the_caller uses (FIG-1376).
--   * It is done at the top of attendance_day_and_order, before the part that decides whether the row moved. So the same register sent
--     again by another person (the office re-sending what the teacher took) is "nothing changed" and keeps its time (FIG-1410), instead
--     of counting as an edit only because the sender is different.
--   * What the nurse's "mark excused" (medical_mark_attendance) does to a learner who already has a mark is a correction like any other:
--     the mark and its note change, taken_by stays, and the audit event names the nurse.
--   * Nothing is backfilled: where an earlier correction already replaced the name, there is no record of who the first one was.
--
-- Everything else in the function is as 20261105100000 left it (compared with the live definition, line by line).
-- supabase/rls-checks/attendance.sql and tests/integration/attendance.test.ts check it.

create or replace function attendance_day_and_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_today date;
  v_term  terms%rowtype;
begin
  -- who took the register (FIG-1406): a change by anyone signed in leaves it as it was
  if tg_op = 'UPDATE' and auth.uid() is not null then
    new.taken_by := old.taken_by;
  end if;

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
