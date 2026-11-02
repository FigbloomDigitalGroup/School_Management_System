-- Figbloom Schools in the Figbloom console (console.figbloom.org).
--
-- The console's backend (bloomHR's /api) calls the platform-schools edge
-- function with a shared secret; that function calls the two functions
-- below with the service role. Nobody else can run them: execute is revoked
-- from public, anon and authenticated and granted to service_role only.
--
--   platform_console_schools(school)  every school (or one), with counts and
--     one support contact, in one query instead of one per school. Counts,
--     statuses and the first school admin's email only: no names, no records.
--
--   platform_console_set_school_status(school, status, reason, actor_email)
--     suspends or reactivates a school with the same mechanism Schools' own
--     platform console uses: an update of tenants.status. Everything that
--     makes a suspension bite hangs off that column (20261026080000):
--     my_tenant() answers a no-match id for the school's users, and the
--     tenants_sync_suspension trigger bans them in Auth (and lifts exactly
--     those bans on reactivation). So a school suspended from the Figbloom
--     console is locked out exactly as one suspended from Schools' own.
--     It writes its own, worded audit event naming the console operator
--     ("x@figbloom.org via Figbloom console") and the reason, and skips the
--     generic "Tenants: ... changed" line for that update (figbloom.self_audited,
--     the FIG-1326 convention), so the change is logged once.
--
-- Only 'active' and 'suspended' can be set from the console. Reactivating
-- means suspended -> active; any other status (trial, overdue, onboarding,
-- setup_stalled) is Schools' own business and is refused. The function
-- answers {outcome: ok | not_found | already | not_settable}; the edge
-- function turns those into 200 / 404 / 409 / 422.
--
-- tenants.status_reason is new: why the school is in its current status, when
-- the console said. Any other status change (Schools' own console, an org
-- admin activating a school) clears it, so it never describes an old status.
--
-- supabase/rls-checks/platform_console.sql checks it.

-- ------------------------------------------------------------ status_reason
alter table tenants
  add column status_reason text check (status_reason is null or char_length(status_reason) between 1 and 500);
comment on column tenants.status_reason is
  'Why the school has its current status, as given in the Figbloom console; cleared by any status change that does not set it.';

create or replace function tenants_clear_status_reason() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status_reason is not distinct from old.status_reason then
    new.status_reason := null;
  end if;
  return new;
end $$;
revoke execute on function tenants_clear_status_reason() from public, anon, authenticated;

create trigger tenants_clear_status_reason before update of status on tenants
  for each row execute function tenants_clear_status_reason();

-- ------------------------------------------------------------ the list
-- One jsonb array, one element per school, in the shape the console contract
-- gives a list row. Timestamps are UTC, to the second, with a Z.
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
  -- the first school admin with a real mailbox (not a synthetic login-ID address)
  admins as (
    select distinct on (a.tenant_id) a.tenant_id, a.email
      from (select p.tenant_id, p.created_at, p.id, coalesce(nullif(trim(p.email), ''), u.email) as email
              from profiles p
              left join auth.users u on u.id = p.id
             where p.role = 'school_admin' and p.tenant_id in (select id from s)) a
     where a.email is not null and a.email not like '%.figbloom.internal'
     order by a.tenant_id, a.created_at, a.id
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
           'students', coalesce(l.students, 0),
           'teachers', coalesce(pe.teachers, 0),
           'parents', coalesce(pe.parents, 0),
           'last_activity_at', to_char(pe.last_sign_in_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         ) order by s.name, s.id), '[]'::jsonb)
    from s
    left join organizations o on o.id = s.organization_id
    left join people pe on pe.tenant_id = s.id
    left join learners l on l.tenant_id = s.id
    left join admins ad on ad.tenant_id = s.id
$$;
revoke execute on function platform_console_schools(uuid) from public, anon, authenticated;
grant execute on function platform_console_schools(uuid) to service_role;

-- ------------------------------------------------------------ suspend / reactivate
create or replace function platform_console_set_school_status(
  p_school_id uuid, p_status text, p_reason text, p_actor_email text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(trim(p_reason), '');
  v_actor text := nullif(trim(p_actor_email), '');
  v_old tenant_status;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)

  if p_status is null or p_status not in ('active', 'suspended') then
    return jsonb_build_object('outcome', 'not_settable');
  end if;
  if v_actor is null then
    raise exception 'actor_email is required' using errcode = '22023';
  end if;
  if p_status = 'suspended' and v_reason is null then
    raise exception 'a reason is required to suspend a school' using errcode = '22023';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'the reason is longer than 500 characters' using errcode = '22023';
  end if;

  select t.status into v_old from tenants t where t.id = p_school_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_old::text = p_status then
    return jsonb_build_object('outcome', 'already');
  end if;
  if p_status = 'active' and v_old <> 'suspended' then
    return jsonb_build_object('outcome', 'not_settable');
  end if;

  -- the same update Schools' own console makes; tenants_sync_suspension does the rest
  update tenants set status = p_status::tenant_status, status_reason = v_reason where id = p_school_id;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_school_id, null, v_actor || ' via Figbloom console',
          case p_status when 'suspended' then 'School suspended' else 'School reactivated' end
            || ' via Figbloom console' || coalesce(': ' || v_reason, ''),
          'access',
          jsonb_build_object('table', 'tenants', 'op', 'update', 'via', 'Figbloom console',
                             'actor_email', v_actor, 'reason', v_reason,
                             'changes', jsonb_build_object('status', jsonb_build_object('from', v_old::text, 'to', p_status))));

  return jsonb_build_object('outcome', 'ok', 'school', platform_console_schools(p_school_id) -> 0);
end $$;
revoke execute on function platform_console_set_school_status(uuid, text, text, text) from public, anon, authenticated;
grant execute on function platform_console_set_school_status(uuid, text, text, text) to service_role;
