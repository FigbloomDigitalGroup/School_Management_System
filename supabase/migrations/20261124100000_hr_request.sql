-- "Request Figbloom HR" (HR_CONNECT_SPEC.md, shared by Fleet, Property and Schools).
--
--   The HR & Payroll page shows whether Figbloom HR is there for the school (connected / setting up / not connected,
--   worked out by open-hr from the platform). A school without it can ask Figbloom for it; Figbloom staff see the
--   request in the console (platform-schools "list": hr_requested_at) and switch HR on there.
--
--   Who may ask: the same people who may open HR & Payroll (hr_handoff_status(), 20261105700000): the school's admin,
--   an org admin of its organisation, or a teacher or other staff member holding the fees area. open-hr checks that as
--   the caller, and that HR isn't already on (409 already_connected), then records the request here with the service
--   role. The first request is kept: asking again changes nothing and answers the first one's time.
--
--   tenants.hr_requested_at / hr_requested_by: when, and by whom. Signed-in people can't write them (tenants is written
--   by Figbloom staff and these functions only, 20260901000001 tenant_write_super).
--
--   platform_console_schools() (20261105610000) gains hr_requested_at per school (ISO, UTC, seconds; null when never).
--
-- supabase/rls-checks/hr_request.sql checks it.

alter table tenants
  add column if not exists hr_requested_at timestamptz,
  add column if not exists hr_requested_by uuid references profiles (id) on delete set null;

-- open-hr's record of a request (service role only): the first request is kept, and its time is the answer.
create or replace function platform_record_hr_request(p_tenant_id uuid, p_profile_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  update tenants set hr_requested_at = now(), hr_requested_by = p_profile_id
   where id = p_tenant_id and hr_requested_at is null;
  select hr_requested_at into v_at from tenants where id = p_tenant_id;
  return v_at;
end $$;
revoke execute on function platform_record_hr_request(uuid, uuid) from public, anon, authenticated;
grant execute on function platform_record_hr_request(uuid, uuid) to service_role;

-- 20261105610000's function, with hr_requested_at added (everything else unchanged).
create or replace function platform_console_schools(p_school_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (
    select t.* from tenants t where p_school_id is null or t.id = p_school_id
  ),
  people as (
    select p.tenant_id,
           count(*) filter (where p.role = 'teacher') as teachers,
           count(*) filter (where p.role = 'parent')  as parents,
           max(u.last_sign_in_at)                     as last_sign_in_at
      from profiles p
      left join auth.users u on u.id = p.id
     where p.tenant_id in (select id from s)
     group by p.tenant_id
  ),
  learners as (
    select st.tenant_id, count(*) as students
      from students st
     where st.active and st.tenant_id in (select id from s)
     group by st.tenant_id
  ),
  -- the first school admin with a real mailbox (not a synthetic login-ID address): unchanged
  admins as (
    select distinct on (a.tenant_id) a.tenant_id, a.email
      from (select p.tenant_id, p.created_at, p.id, coalesce(nullif(trim(p.email), ''), u.email) as email
              from profiles p
              left join auth.users u on u.id = p.id
             where p.role = 'school_admin' and p.tenant_id in (select id from s)) a
     where a.email is not null and a.email not like '%.figbloom.internal'
     order by a.tenant_id, a.created_at, a.id
  ),
  -- every current school admin with a real email, oldest first, at most 20 a school
  admin_list as (
    select x.tenant_id,
           jsonb_agg(jsonb_build_object('email', x.email, 'name', x.full_name, 'role', 'school_admin') order by x.created_at, x.id) as admins
      from (select p.tenant_id, p.id, p.full_name, p.created_at,
                   coalesce(platform_real_email(p.email), platform_real_email(u.email)) as email,
                   row_number() over (partition by p.tenant_id order by p.created_at, p.id) as n
              from profiles p
              left join auth.users u on u.id = p.id
             where p.role = 'school_admin' and p.archived_at is null and p.tenant_id in (select id from s)
               and coalesce(platform_real_email(p.email), platform_real_email(u.email)) is not null) x
     where x.n <= 20
     group by x.tenant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'name', s.name,
           'slug', s.slug,
           'status', s.status::text,
           'status_reason', s.status_reason,
           'organization', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name) end,
           'created_at', to_char(s.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'admin_email', ad.email,
           'admins', coalesce(al.admins, '[]'::jsonb),
           'students', coalesce(l.students, 0),
           'teachers', coalesce(pe.teachers, 0),
           'parents', coalesce(pe.parents, 0),
           'last_activity_at', to_char(pe.last_sign_in_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'hr_requested_at', to_char(s.hr_requested_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         ) order by s.name, s.id), '[]'::jsonb)
    from s
    left join organizations o on o.id = s.organization_id
    left join people pe on pe.tenant_id = s.id
    left join learners l on l.tenant_id = s.id
    left join admins ad on ad.tenant_id = s.id
    left join admin_list al on al.tenant_id = s.id
$$;
revoke execute on function platform_console_schools(uuid) from public, anon, authenticated;
grant execute on function platform_console_schools(uuid) to service_role;
