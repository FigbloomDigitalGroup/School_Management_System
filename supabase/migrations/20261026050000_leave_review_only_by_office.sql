-- A teacher could approve their own leave.
--
-- leave_update lets the requester update their own still-pending request, and
-- leave_insert lets a teacher create one, but neither said which columns or
-- values: a teacher could insert a request already 'approved', or update their
-- pending one to 'approved' and sign it with a reviewer of their choice. Leave
-- feeds cover planning (coverage.ts reads approved leave), so a self-approved
-- request wrongly empties a teacher's timetable.
--
-- RLS can't compare old and new rows, so a trigger does. Outside the office:
--   - a new request starts 'pending', with no reviewer;
--   - the requester may change the dates and reason of a pending request and
--     withdraw it (pending -> cancelled), nothing else;
--   - review fields (reviewed_by / reviewed_at / review_note), owner and school
--     never change.
-- The service role (auth.uid() is null) and the office (may_administer) keep
-- full control, which is how a principal approves or rejects.

create or replace function guard_leave_review() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or may_administer(coalesce(old.tenant_id, new.tenant_id)) then return new; end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null then
      raise exception 'A leave request starts pending. Only the office reviews it.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.review_note is distinct from old.review_note
     or new.teacher_id is distinct from old.teacher_id
     or new.tenant_id is distinct from old.tenant_id then
    raise exception 'Only the office reviews leave.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'You can withdraw a pending leave request, but only the office approves or rejects it.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger leave_requests_guard_review before insert or update on leave_requests
  for each row execute function guard_leave_review();
