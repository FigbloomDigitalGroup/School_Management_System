-- FIG-1432: a school's terms cannot overlap or run out of order.
--
-- The terms table only required the end after the start, a term number of 1 to 3, one term per school, year and number, and one
-- current term. Nothing compared two terms' dates: Term 1 of 2040 (5 Jan to 1 Apr) and a Term 2 of 2040 starting 1 Mar were both
-- accepted, and so was a Term 3 of 2040 dated December 2039, before Term 1. On the screen, a Term 1 of 2027 starting 1 October 2026 while
-- Term 3 of 2026 runs to 27 November was saved, and Term 3 was switched off at once though its dates still said 27 November.
--
-- The rule: of any two terms of one school, the one that comes later (by year, then number) must start after the other has ended. That
-- refuses both an overlap and the wrong order. It is checked when a term is added and when a term's dates, year or number change; an update
-- that leaves those alone (switching a term on or off as the current one, renaming it) is not looked at, so a school whose terms were saved
-- before this rule can still end its current term.
--
-- It is a SECURITY DEFINER trigger so it always sees every term of the school, whoever writes. The error is the exclusion-violation code
-- (23P01) with the two terms named in words.

create or replace function terms_follow_one_another() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if tg_op = 'UPDATE' and new.starts_on = old.starts_on and new.ends_on = old.ends_on and new.year = old.year and new.index = old.index then
    return new;
  end if;

  for o in select name, year, index, starts_on, ends_on from terms where tenant_id = new.tenant_id and id <> new.id loop
    if ((new.year, new.index) > (o.year, o.index) and new.starts_on <= o.ends_on)
       or ((new.year, new.index) < (o.year, o.index) and new.ends_on >= o.starts_on) then
      raise exception '% (% to %) overlaps or runs out of order with % (% to %). A school''s terms follow one another.',
        new.name, to_char(new.starts_on, 'FMDD Mon YYYY'), to_char(new.ends_on, 'FMDD Mon YYYY'),
        o.name, to_char(o.starts_on, 'FMDD Mon YYYY'), to_char(o.ends_on, 'FMDD Mon YYYY')
        using errcode = '23P01';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists terms_follow_one_another on terms;
create trigger terms_follow_one_another before insert or update on terms
  for each row execute function terms_follow_one_another();
