-- The audit log can be given out, like any other part of the admin console.
--
-- Until now the audit trail stayed with full admins (the school admin, the
-- organization's admins, Figbloom staff), and a school's own console had no
-- page for it at all. Since 20261104000000 every action is in it, so a
-- school can now hand the audit log to a deputy, or to one of its named
-- roles, from Access & roles: a new admin area, 'audit'.
--
-- audit_read becomes has_perm(tenant_id, 'audit'): full admins (has_perm
-- includes may_administer), and a teacher or other staff member at that
-- school who holds the area, directly or through a school role. The area is
-- read only: nobody writes audit events except the database itself.
-- Events with no school (platform tables) stay with Figbloom staff.

create or replace function is_admin_area(p_area text) returns boolean
language sql immutable as $$
  select p_area in ('people', 'fees', 'academics', 'attendance', 'transport', 'communication',
                    'inventory', 'activities', 'visitors', 'medical', 'leave', 'audit')
$$;

alter policy audit_read on audit_events to authenticated
  using (has_perm(tenant_id, 'audit'));
