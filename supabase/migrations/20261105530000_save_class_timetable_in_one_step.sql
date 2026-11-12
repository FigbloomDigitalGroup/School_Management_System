-- FIG-1431: saving a class's timetable is one step, so a save the database refuses leaves the old timetable as it was.
--
-- saveClassTimetable deleted every period of the class and then inserted the new ones as two requests. If the insert was refused (a
-- time the database does not accept, two admins saving at once, a dropped connection between the two), the delete had already been
-- saved and the class lost its whole week: a class with 3 periods, then a save with a period at 25:99, ended with 0 periods.
--
-- save_class_timetable() does both in one call, so one transaction: a refusal undoes the delete too. It is SECURITY INVOKER (the default),
-- so the caller's own rights decide, exactly as the two requests did: the timetable_write rule and the same-school checks still apply
-- to every row, and a caller who may not change this class's timetable changes nothing.
--
-- p_slots is an array of {day, start_time, label, room, subject_id}. The app has already dropped the periods with no label and trimmed
-- the text; an empty array clears the class's timetable, as before.

create or replace function save_class_timetable(p_tenant_id uuid, p_class_id uuid, p_slots jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from timetable_slots where class_id = p_class_id and tenant_id = p_tenant_id;

  insert into timetable_slots (tenant_id, class_id, day, start_time, label, room, subject_id)
  select p_tenant_id, p_class_id, s.day, s.start_time, s.label, nullif(s.room, ''), s.subject_id
    from jsonb_to_recordset(coalesce(p_slots, '[]'::jsonb)) as s(day text, start_time text, label text, room text, subject_id uuid);
end $$;

revoke execute on function save_class_timetable(uuid, uuid, jsonb) from public, anon;
grant execute on function save_class_timetable(uuid, uuid, jsonb) to authenticated;
