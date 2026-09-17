-- FIG-332: the read-only data an org_admin can actually see, plus an audit
-- log of every cross-tenant look. org_admin gets ZERO direct RLS access to
-- students/marks/attendance/fee_invoices/payments — a derived, job-populated
-- summary table instead of a live view over those tables, so there is no
-- query path back to raw PII rows even if a future column got added
-- carelessly. A live view would only be as safe as its own definition; a
-- table populated by triggers has no such live path at all.

create or replace function is_org_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'org_admin' from profiles where id = auth.uid()), false)
$$;

-- the tenant_ids this org_admin may see (empty set for everyone else)
create or replace function my_organization_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select t.id
  from tenants t
  join organization_admins oa on oa.organization_id = t.organization_id
  where oa.profile_id = auth.uid()
$$;

-- ---------------------------------------------------------------- summary

create table organization_tenant_summary (
  tenant_id            uuid primary key references tenants on delete cascade,
  organization_id      uuid references organizations on delete cascade,
  name                 text not null,
  institution_type     institution_type not null,
  status               tenant_status not null,
  active_students      int not null default 0,
  present_today        int not null default 0,
  fees_billed_cents    bigint not null default 0,
  fees_collected_cents bigint not null default 0,
  updated_at           timestamptz not null default now()
);
create index on organization_tenant_summary (organization_id);

/** Recomputes one tenant's row from scratch — cheap enough per call (a
 *  handful of aggregate counts scoped by tenant_id, all indexed), and only
 *  ever triggered by a write to that same tenant's data, never a bulk scan. */
create or replace function refresh_organization_tenant_summary(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    delete from organization_tenant_summary where tenant_id = p_tenant_id;
    return;
  end if;

  insert into organization_tenant_summary (
    tenant_id, organization_id, name, institution_type, status,
    active_students, present_today, fees_billed_cents, fees_collected_cents, updated_at
  )
  select
    t.id, t.organization_id, t.name, t.institution_type, t.status,
    (select count(*) from students s where s.tenant_id = t.id and s.active),
    (select count(*) from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark = 'present'),
    (select coalesce(sum(fi.total_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
    (select coalesce(sum(fi.paid_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
    now()
  from tenants t
  where t.id = p_tenant_id
  on conflict (tenant_id) do update set
    organization_id = excluded.organization_id,
    name = excluded.name,
    institution_type = excluded.institution_type,
    status = excluded.status,
    active_students = excluded.active_students,
    present_today = excluded.present_today,
    fees_billed_cents = excluded.fees_billed_cents,
    fees_collected_cents = excluded.fees_collected_cents,
    updated_at = now();
end $$;

-- backfill every existing tenant once, set-based rather than one call per row
insert into organization_tenant_summary (
  tenant_id, organization_id, name, institution_type, status,
  active_students, present_today, fees_billed_cents, fees_collected_cents
)
select
  t.id, t.organization_id, t.name, t.institution_type, t.status,
  (select count(*) from students s where s.tenant_id = t.id and s.active),
  (select count(*) from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark = 'present'),
  (select coalesce(sum(fi.total_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
  (select coalesce(sum(fi.paid_cents), 0) from fee_invoices fi where fi.tenant_id = t.id)
from tenants t;

-- keep it current: one trigger per table that can move the numbers, each
-- just re-deriving the affected tenant(s) rather than trying to patch deltas.
create or replace function trg_refresh_org_summary_for_tenant() returns trigger
language plpgsql as $$
begin
  perform refresh_organization_tenant_summary(coalesce(new.tenant_id, old.tenant_id));
  return null;
end $$;

create trigger refresh_org_summary_students
  after insert or update or delete on students
  for each row execute function trg_refresh_org_summary_for_tenant();

create trigger refresh_org_summary_attendance
  after insert or update or delete on attendance
  for each row execute function trg_refresh_org_summary_for_tenant();

create trigger refresh_org_summary_fee_invoices
  after insert or update or delete on fee_invoices
  for each row execute function trg_refresh_org_summary_for_tenant();

-- tenants itself: name/status/institution_type/organization_id can all change.
-- The row is keyed by tenant_id, not organization_id, so reassigning a tenant
-- to a different (or no) organization is just an update to the existing row
-- via the upsert in refresh_organization_tenant_summary — nothing to clean up.
create or replace function trg_refresh_org_summary_for_tenant_row() returns trigger
language plpgsql as $$
begin
  perform refresh_organization_tenant_summary(new.id);
  return null;
end $$;

create trigger refresh_org_summary_tenants
  after insert or update on tenants
  for each row execute function trg_refresh_org_summary_for_tenant_row();

create trigger refresh_org_summary_tenants_delete
  after delete on tenants
  for each row execute function trg_refresh_org_summary_for_tenant();

alter table organization_tenant_summary enable row level security;

create policy organization_tenant_summary_read on organization_tenant_summary for select
  using (is_super() or tenant_id in (select my_organization_tenant_ids()));
-- no write policy: only the trigger functions (security definer, running as
-- the table owner) ever write here — no role, org_admin included, writes directly.

-- ---------------------------------------------------------------- audit log

-- Mirrors impersonation_sessions: every /org/* page load logs a row here, so
-- a school has the same "who from outside looked at us" visibility into an
-- owning organization that it already has into Figbloom staff.
create table organization_access_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations on delete cascade,
  profile_id      uuid not null references profiles on delete cascade,
  tenant_id       uuid references tenants on delete set null, -- null = an org-wide view, not one school
  action          text not null,
  accessed_at     timestamptz not null default now()
);
create index on organization_access_log (organization_id, accessed_at desc);
create index on organization_access_log (tenant_id);

alter table organization_access_log enable row level security;

create policy org_access_log_read_own_org on organization_access_log for select
  using (is_super() or organization_id in (select organization_id from organization_admins where profile_id = auth.uid()));
create policy org_access_log_read_own_tenant on organization_access_log for select
  using (tenant_id = my_tenant() and my_role() = 'school_admin');
-- any signed-in org_admin may log their own access; nobody may edit or delete a log entry
create policy org_access_log_insert on organization_access_log for insert
  with check (is_super() or (is_org_admin() and profile_id = auth.uid()));
