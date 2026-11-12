-- FIG-1433: one teacher's pending and approved leave cannot overlap, and the same dates cannot be filed twice.
--
-- The table only checked that a request ends on or after the day it starts. A teacher could file 10 to 12 May, have it approved, then file
-- 12 to 14 May (overlapping) and 10 to 12 May again (the same dates), all accepted, and the principal could approve the overlapping one:
-- two approved requests for the same days, and days off counted twice.
--
-- A trigger refuses a pending or approved request that shares a day with another pending or approved request of the same teacher.
-- Withdrawn (cancelled) and rejected requests do not count, so a rejected or withdrawn request can be filed again. It runs when a request
-- is added, when its dates change, and when a request becomes pending or approved (so the principal cannot approve one that overlaps leave
-- already approved, which can only exist from before this rule). Security definer so it always sees all of the teacher's requests, whoever
-- writes. The message gives both periods in words.

create or replace function leave_does_not_overlap() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if new.status not in ('pending', 'approved') then return new; end if;
  if tg_op = 'UPDATE' and new.status = old.status and new.starts_on = old.starts_on and new.ends_on = old.ends_on
     and new.teacher_id = old.teacher_id then
    return new;
  end if;

  select starts_on, ends_on, status into o
    from leave_requests
   where teacher_id = new.teacher_id and id <> new.id and status in ('pending', 'approved')
     and starts_on <= new.ends_on and ends_on >= new.starts_on
   order by starts_on
   limit 1;

  if found then
    raise exception 'Leave from % to % overlaps leave already % for this teacher (% to %).',
      to_char(new.starts_on, 'FMDD Mon YYYY'), to_char(new.ends_on, 'FMDD Mon YYYY'),
      case o.status when 'approved' then 'approved' else 'asked for' end,
      to_char(o.starts_on, 'FMDD Mon YYYY'), to_char(o.ends_on, 'FMDD Mon YYYY')
      using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists leave_requests_no_overlap on leave_requests;
create trigger leave_requests_no_overlap before insert or update on leave_requests
  for each row execute function leave_does_not_overlap();
