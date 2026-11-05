-- FIG-1499: the group summary is recounted once per statement, not once per row.
--
-- organization_tenant_summary (the group dashboard's learners, present today and fees) was kept by an AFTER ROW trigger on attendance,
-- students and fee_invoices. Every row written recounted the school's learners, today's marks and every invoice (2.4 ms at 1,512
-- learners and 3,024 invoices): a 42-learner register ran it 42 times (45 to 59 ms of the save), billing 3,000 invoices would run it
-- 3,000 times. Worse, every one of those recounts upserts the school's single summary row, and the row stays locked until the
-- transaction ends, so two teachers saving registers at the same moment queued behind each other (1 to 10 queries waiting on a lock in
-- the 60-teacher burst of QA 18).
--
-- The three tables now have statement triggers with transition tables (one each for insert, update and delete, because a transition
-- table is named per event). They refresh each affected school once, at the very end of the statement, so a 42-row register recounts
-- once and holds the summary row only for that last moment. The numbers in the summary are unchanged: every school still has a row
-- that equals its live data after each statement (supabase/rls-checks/report_figures.sql and integrity.sql C6 keep checking that).
--
-- Not done on purpose: skipping schools that are in no group. The summary is checked as one record for every school (reconciliation.sql,
-- report_figures.sql: "every school has a summary row, and none differs from the live data"), so a stale row for a school outside a
-- group would change what the platform may rely on.

create or replace function trg_refresh_org_summary_statement() returns trigger
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if tg_op = 'INSERT' then
    for t in select distinct tenant_id from new_rows where tenant_id is not null loop
      perform refresh_organization_tenant_summary(t);
    end loop;
  elsif tg_op = 'DELETE' then
    for t in select distinct tenant_id from old_rows where tenant_id is not null loop
      perform refresh_organization_tenant_summary(t);
    end loop;
  else
    for t in select tenant_id from new_rows where tenant_id is not null
             union select tenant_id from old_rows where tenant_id is not null loop
      perform refresh_organization_tenant_summary(t);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists refresh_org_summary_attendance on attendance;
drop trigger if exists refresh_org_summary_students on students;
drop trigger if exists refresh_org_summary_fee_invoices on fee_invoices;

create trigger refresh_org_summary_attendance_ins after insert on attendance
  referencing new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_upd after update on attendance
  referencing old table as old_rows new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_del after delete on attendance
  referencing old table as old_rows for each statement execute function trg_refresh_org_summary_statement();

create trigger refresh_org_summary_students_ins after insert on students
  referencing new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_students_upd after update on students
  referencing old table as old_rows new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_students_del after delete on students
  referencing old table as old_rows for each statement execute function trg_refresh_org_summary_statement();

create trigger refresh_org_summary_fee_invoices_ins after insert on fee_invoices
  referencing new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_fee_invoices_upd after update on fee_invoices
  referencing old table as old_rows new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_fee_invoices_del after delete on fee_invoices
  referencing old table as old_rows for each statement execute function trg_refresh_org_summary_statement();

-- The row trigger function has no trigger left on these tables.
drop function if exists trg_refresh_org_summary_for_tenant();
