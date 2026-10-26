-- Open signup, schools that work straight away, and password resets for
-- login-ID accounts.
--
-- 1. Organizations no longer wait for approval.
--    signup-organization and create-organization used to create every new
--    organization as 'pending' until a super_admin pressed Approve, and
--    tenant_write_org_admin only lets an 'active' organization's admin add
--    schools. Approval is paused for now: both functions create organizations
--    'active', and anything still waiting in the queue is let in here so
--    nobody is left on the "under review" screen. The 'pending' status, the
--    Approve button and the holding screen all stay, so approval can be
--    switched back on by changing the two functions, without a migration.
update organizations set status = 'active' where status = 'pending';

-- 2. Schools an organization adds itself are usable straight away.
--    The org console now inserts new schools as 'active' (the insert policy
--    never constrained status). Schools an org admin added before this change
--    sit at 'onboarding', where nobody can find them at sign-in, and only a
--    super_admin could change that. org_activate_school lets the
--    organization's own admin open one of its schools for sign-in. It only
--    ever moves 'onboarding' -> 'active': a school Figbloom has suspended or
--    flagged stays that way.
create or replace function org_activate_school(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_super() or (is_org_admin() and p_tenant_id in (select my_organization_tenant_ids()))) then
    raise exception 'You do not administer this school.' using errcode = '42501';
  end if;
  update tenants set status = 'active' where id = p_tenant_id and status = 'onboarding';
end $$;

revoke execute on function org_activate_school(uuid) from public, anon;
grant execute on function org_activate_school(uuid) to authenticated;

-- 3. "Forgot password?" for accounts that sign in with a school ID.
--    Learners, parents, teachers and drivers have no mailbox (their auth
--    email is a synthetic {id}@login.{school}.figbloom.internal), so an email
--    link can't reach them. Instead the public request-password-reset
--    function records a request here, and the school office (or, for a
--    learner, their parent) sets a new temporary password with
--    reset-user-password, which also marks the request resolved.
--    Written only by those two functions with the service role; the school's
--    own admins (and org admins of the owning organization) can read the
--    open requests to act on them.
create table password_reset_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  profile_id  uuid not null references profiles on delete cascade,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles on delete set null
);
-- at most one open request per account: asking twice doesn't queue twice
create unique index password_reset_requests_one_open on password_reset_requests (profile_id) where resolved_at is null;
create index on password_reset_requests (tenant_id) where resolved_at is null;

alter table password_reset_requests enable row level security;
revoke all on password_reset_requests from anon;
revoke insert, update, delete on password_reset_requests from authenticated;

create policy password_reset_requests_admin_read on password_reset_requests for select
  using (may_administer(tenant_id));
