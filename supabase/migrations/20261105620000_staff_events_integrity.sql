-- Follow-up to 20261105600000_platform_staff_events (merged with PR #250), for the database checks
-- (supabase/rls-checks: integrity.sql A5/A6, same_school_refs.sql). Fixed forward rather than by editing the
-- merged migration, so a database that has it already gets the same result.
--
--   profiles.archived_by points at a profile: it gets the same-school check every school-to-school reference has
--     (20261103600000; named zz_ so it runs last, 20261105300000). An org admin or Figbloom staff member (no
--     school) may still archive.
--   platform_event_deliveries is a school's record (tenant_id NOT NULL, a foreign key, gone with the school);
--     profile_id is a foreign key too (kept as null if the person is removed), with the same-school check. Before
--     switch-on a delivery for a school Schools doesn't have is acknowledged but not recorded, and the person is
--     recorded only if they belong to the school the delivery names.
--   platform_sync_queue.tenant_id (the school of a staff event) is a foreign key (a school's events go with it).
--     It stays nullable: an organisation's or a school's own registration row belongs to no school
--     (integrity.sql A6 lists it). local_id (an organisation's or a school's id) and event_id (the event's own
--     id, not a reference) have no foreign key, by design (A5 lists them).

-- ------------------------------------------------------------ profiles.archived_by: same school
create trigger zz_profiles_same_school before insert or update on profiles
  for each row execute function enforce_same_school_refs('archived_by', 'profiles');

-- ------------------------------------------------------------ platform_event_deliveries: a school's record
delete from platform_event_deliveries d where d.tenant_id is null or not exists (select 1 from tenants t where t.id = d.tenant_id);
update platform_event_deliveries d set profile_id = null
 where d.profile_id is not null and not exists (select 1 from profiles p where p.id = d.profile_id and p.tenant_id = d.tenant_id);
alter table platform_event_deliveries
  alter column tenant_id set not null,
  add constraint platform_event_deliveries_tenant_id_fkey foreign key (tenant_id) references tenants on delete cascade,
  add constraint platform_event_deliveries_profile_id_fkey foreign key (profile_id) references profiles on delete set null;
create index on platform_event_deliveries (tenant_id);
create trigger zz_platform_event_deliveries_same_school before insert or update on platform_event_deliveries
  for each row execute function enforce_same_school_refs('profile_id', 'profiles');

-- hr.employee.left: outcomes duplicate | not_enabled | archived | already_archived | not_found | tenant_mismatch | not_staff.
create or replace function platform_staff_left(
  p_delivery_id text, p_event_id text, p_tenant_id uuid, p_profile_id uuid, p_left_on date,
  p_employee_number text default null, p_apply boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p profiles;
  v_detail jsonb := jsonb_build_object('employee_number', left(p_employee_number, 100), 'left_on', p_left_on);
begin
  if exists (select 1 from platform_event_deliveries where delivery_id = p_delivery_id) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if not p_apply then
    -- recorded against its school (when Schools has it), and the person only when they are that school's
    if not exists (select 1 from tenants where id = p_tenant_id) then
      return jsonb_build_object('outcome', 'not_enabled', 'recorded', false);
    end if;
    insert into platform_event_deliveries (delivery_id, event_type, event_id, tenant_id, profile_id, outcome, detail)
    values (p_delivery_id, 'hr.employee.left', p_event_id, p_tenant_id,
            (select id from profiles where id = p_profile_id and tenant_id = p_tenant_id), 'not_enabled', v_detail)
    on conflict (delivery_id) do nothing;
    return jsonb_build_object('outcome', case when found then 'not_enabled' else 'duplicate' end);
  end if;

  select * into p from profiles where id = p_profile_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if p.tenant_id is distinct from p_tenant_id then return jsonb_build_object('outcome', 'tenant_mismatch'); end if;
  if not platform_is_staff_role(p.role) then return jsonb_build_object('outcome', 'not_staff'); end if;

  insert into platform_event_deliveries (delivery_id, event_type, event_id, tenant_id, profile_id, outcome, detail)
  values (p_delivery_id, 'hr.employee.left', p_event_id, p_tenant_id, p_profile_id, 'received', v_detail)
  on conflict (delivery_id) do nothing;
  if not found then return jsonb_build_object('outcome', 'duplicate'); end if;

  if p.archived_at is not null then
    update platform_event_deliveries set outcome = 'already_archived' where delivery_id = p_delivery_id;
    return jsonb_build_object('outcome', 'already_archived');
  end if;

  perform set_config('figbloom.self_audited', 'true', true);   -- its own audit event (FIG-1326)
  perform set_config('figbloom.staff_archive', 'true', true);
  perform set_config('figbloom.platform_event', 'true', true);  -- HR knows: not sent back as schools.staff.left
  update profiles set archived_at = now(), archived_by = null,
                      left_on = coalesce(p_left_on, (now() at time zone 'Africa/Nairobi')::date)
   where id = p.id;
  perform set_config('figbloom.platform_event', '', true);
  perform set_config('figbloom.staff_archive', '', true);
  perform set_staff_login_ban(array[p.id], true);

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p.tenant_id, null, 'Figbloom HR (via Figbloom platform)',
          format('Staff member %s archived: left on %s (recorded in Figbloom HR)', p.full_name,
                 to_char(coalesce(p_left_on, (now() at time zone 'Africa/Nairobi')::date), 'DD Mon YYYY')),
          'provisioning',
          jsonb_build_object('table', 'profiles', 'op', 'update', 'via', 'Figbloom platform', 'profile_ids', jsonb_build_array(p.id),
                             'names', jsonb_build_array(p.full_name), 'left_on', p_left_on,
                             'employee_number', left(p_employee_number, 100), 'delivery_id', p_delivery_id, 'event_id', p_event_id));

  update platform_event_deliveries set outcome = 'archived' where delivery_id = p_delivery_id;
  return jsonb_build_object('outcome', 'archived');
end $$;

-- ------------------------------------------------------------ platform_sync_queue.tenant_id: a foreign key
delete from platform_sync_queue q where q.tenant_id is not null and not exists (select 1 from tenants t where t.id = q.tenant_id);
alter table platform_sync_queue
  add constraint platform_sync_queue_tenant_id_fkey foreign key (tenant_id) references tenants on delete cascade;
create index on platform_sync_queue (tenant_id) where tenant_id is not null;
