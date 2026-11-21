-- READ-ONLY production review of organization-admin `area.people` delegations (FIG-1609, migration 026).
--
-- Safe to run on the target database: it is wrapped in a READ ONLY transaction and contains no
-- INSERT, UPDATE, DELETE or DDL. It returns names and ids only: no e-mail address, phone number,
-- password material, token or session data.
--
-- It also runs on a database still at migration 025 (the revoke_reason column is read tolerantly), so
-- the review can happen BEFORE 026 is applied.
--
-- Run it as a read-only database user (or the owner), never through the application. Record the
-- environment first (see "Production review procedure" in ORG-ADMIN-POLICY.md).
--
-- Result 1: one row per area.people delegation ever made (active, revoked, invalidated).
-- Result 2: a summary to record (count of active, of currently effective, per organization).
BEGIN READ ONLY;

SELECT d.id                          AS delegation_id,
       o.id                          AS organization_id,
       o.name                        AS organization,
       t.id                          AS school_id,
       t.name                        AS school,
       t.status                      AS school_status,
       d.delegate_user_id            AS recipient_user_id,
       r.full_name                   AS recipient_name,
       r.status                      AS recipient_status,
       EXISTS (SELECT 1 FROM organization_memberships om
                WHERE om.user_id = d.delegate_user_id AND om.organization_id = d.organization_id
                  AND om.role = 'org_admin')                    AS recipient_org_membership_live,
       d.granted_by                  AS grantor_user_id,
       g.full_name                   AS grantor_name,
       d.created_at                  AS granted_at,
       CASE WHEN d.revoked_at IS NULL THEN 'active'
            WHEN (to_jsonb(d) ->> 'revoke_reason') IS NOT NULL THEN 'invalidated'
            ELSE 'revoked' END       AS state,
       d.revoked_at,
       (to_jsonb(d) ->> 'revoke_reason') AS revoke_reason,  -- lifecycle triggers only (026+); NULL before 026
       d.revoked_by,
       -- Does it work today? (active, recipient enabled, live membership, organization active, school not suspended)
       (d.revoked_at IS NULL
        AND r.status = 'active'
        AND o.status = 'active'
        AND t.status <> 'suspended'
        AND EXISTS (SELECT 1 FROM organization_memberships om
                     WHERE om.user_id = d.delegate_user_id AND om.organization_id = d.organization_id
                       AND om.role = 'org_admin'))              AS currently_effective,
       -- What it lets the recipient do in that school while effective: exactly the People set.
       ARRAY['resource.learner.read','resource.learner.write','resource.staff.read','resource.staff.write',
             'resource.document.read','resource.document.write','resource.school_profile.read']
                                     AS effective_capabilities_when_effective,
       -- Also held by the same recipient in that school: can they assign staff areas (a second route to People powers)?
       EXISTS (SELECT 1 FROM org_admin_school_delegations x
                WHERE x.tenant_id = d.tenant_id AND x.delegate_user_id = d.delegate_user_id
                  AND x.revoked_at IS NULL AND x.permission_code = 'rbac.staff_areas.manage')
                                     AS recipient_also_holds_staff_areas_manage,
       -- Areas the recipient has already assigned to school staff in that school (they persist after any revocation).
       (SELECT count(*) FROM staff_area_grants s
         WHERE s.tenant_id = d.tenant_id AND s.granted_by = d.delegate_user_id)::int
                                     AS staff_areas_assigned_by_recipient,
       -- When migration 026 recorded it for review (NULL if the row was created or revoked since).
       (SELECT min(e.occurred_at) FROM security_audit_events e
         WHERE e.event_type = 'rbac.org_delegation.review_required'
           AND e.detail->>'delegationId' = d.id::text)           AS flagged_for_review_at
  FROM org_admin_school_delegations d
  JOIN tenants        t ON t.id = d.tenant_id
  JOIN organizations  o ON o.id = d.organization_id
  JOIN users          r ON r.id = d.delegate_user_id
  LEFT JOIN users     g ON g.id = d.granted_by
 WHERE d.permission_code = 'area.people'
 ORDER BY (d.revoked_at IS NULL) DESC, o.name, t.name, d.created_at, d.id;

SELECT count(*) FILTER (WHERE d.revoked_at IS NULL)::int                                   AS active_total,
       count(*) FILTER (WHERE d.revoked_at IS NULL AND r.status = 'active' AND o.status = 'active'
                          AND t.status <> 'suspended'
                          AND EXISTS (SELECT 1 FROM organization_memberships om
                                       WHERE om.user_id = d.delegate_user_id AND om.organization_id = d.organization_id
                                         AND om.role = 'org_admin'))::int                  AS active_currently_effective,
       count(*) FILTER (WHERE d.revoked_at IS NOT NULL AND (to_jsonb(d) ->> 'revoke_reason') IS NOT NULL)::int AS invalidated_total,
       count(*) FILTER (WHERE d.revoked_at IS NOT NULL AND (to_jsonb(d) ->> 'revoke_reason') IS NULL)::int   AS revoked_total,
       count(DISTINCT d.delegate_user_id) FILTER (WHERE d.revoked_at IS NULL)::int         AS distinct_active_recipients,
       count(DISTINCT d.tenant_id) FILTER (WHERE d.revoked_at IS NULL)::int                AS distinct_schools_affected
  FROM org_admin_school_delegations d
  JOIN tenants       t ON t.id = d.tenant_id
  JOIN organizations o ON o.id = d.organization_id
  JOIN users         r ON r.id = d.delegate_user_id
 WHERE d.permission_code = 'area.people';

COMMIT;
