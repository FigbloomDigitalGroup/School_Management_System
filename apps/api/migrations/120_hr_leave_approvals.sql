-- 120: "Leave to approve" on the API (docs/HR-HANDOFF.md, slice L1). Forward-only; 001-119 untouched.
--
-- A port of the live Supabase feature (20261105800000_leave_via_hr.sql: hr_leave_access()'s `approver`, and the my-hr
-- function's `approvals` and `approval_decide` routes): an approver reads the leave applications Figbloom HR says wait on
-- them, and approves or declines them in HR, as their own HR user.
--
--   1. The permission resource.hr.leave_approvals. The school's administrators hold it (role catalogue), and so does anyone
--      holding the Leave or the Fees area (src/modules/rbac/authorize.ts, HR_LEAVE_APPROVALS_IMPLIED; added to neither
--      LEAVE_AREA_IMPLIED nor FEES_AREA_IMPLIED, which are pinned on their own), as hr_leave_access() says
--      (`school_admin or has_perm(leave) or has_perm(fees)`). An organisation administrator gets it only through a live
--      delegation of one of those two areas (the API's rule, HR-HANDOFF.md risk R5). Platform super administrators hold every
--      catalogued permission, but the routes refuse them in code: HR has no account for them.
--   2. Nothing else. No table, column, grant or function: the switch (HR_LEAVE_ENABLED) is a setting, whether HR leave is on
--      for a school is read from platform_school_links (108, 117), and the audit kind hr.leave.decided is already filed under
--      "operations" by school_audit_events() (106, 117: the `^hr\.` rule).

INSERT INTO permissions (code, description) VALUES
  ('resource.hr.leave_approvals', 'Leave to approve: read the leave applications Figbloom HR says wait on you, and approve or decline them in HR as your own HR user')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.hr.leave_approvals'),
  -- platform super administrators hold every catalogued permission (the leave routes still refuse them)
  ('super_admin', 'resource.hr.leave_approvals')
ON CONFLICT DO NOTHING;
