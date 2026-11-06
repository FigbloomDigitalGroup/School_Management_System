-- FIG-1450: Platform > Usage & capacity counts every active learner, not the first 1,000.
--
-- The page read every active learner of every school through the API and counted them in the browser. The API answers at most 1,000
-- rows and says nothing when it stops, so past 1,000 active learners on the platform "Seats in use" and every school's "In use" were
-- too low (1,004 shown for 1,623), and a school whose learners fell outside the first 1,000 rows read as "Never used".
--
-- platform_usage_counts() returns the two counts per school, added up in the database: active learners, and staff accounts (school
-- admins and teachers, the two roles the page has always counted as seats). Only a platform admin gets rows, as only a platform admin
-- could read every school's learners before.

create or replace function platform_usage_counts()
returns table(tenant_id uuid, learners bigint, staff bigint)
language sql stable security definer set search_path = public as $$
  select t.id,
         (select count(*) from students s where s.tenant_id = t.id and s.active),
         (select count(*) from profiles p where p.tenant_id = t.id and p.role in ('school_admin', 'teacher'))
    from tenants t
   where is_super()
$$;

revoke execute on function platform_usage_counts() from public, anon;
grant execute on function platform_usage_counts() to authenticated;
