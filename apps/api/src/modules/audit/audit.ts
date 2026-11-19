import type { Db } from "../../db/pool.js";
import { normalizeIp } from "../../http/ip.js";

export type SecurityEventType =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.session.revoked"
  | "auth.tenant.selected"
  | "auth.password.changed"
  | "auth.password_change.required"
  | "rbac.staff_areas.changed"
  | "rbac.school_role.changed"
  | "rbac.org_delegation.granted"
  | "rbac.org_delegation.revoked"
  | "rbac.org_delegation.denied"
  | "rbac.org_delegation.legacy_inert"
  | "rbac.guardian_access.granted"
  | "rbac.guardian_access.revoked"
  | "rbac.guardian_access.denied"
  | "rbac.staff_areas.denied"
  | "rbac.permission.denied"
  | "identity.external.linked"
  | "rate_limit.denied"
  | "directory.learner.created"
  | "directory.learner.updated"
  | "directory.learner.archived"
  | "directory.learner.restored"
  | "directory.guardian.created"
  | "directory.guardian.linked"
  | "directory.guardian.updated"
  | "directory.guardian.link_archived"
  | "directory.guardian.archived"
  | "directory.guardian.restored"
  | "directory.staff.created"
  | "directory.staff.updated"
  | "directory.staff.archived"
  | "directory.staff.restored"
  | "directory.school_profile.updated"
  | "directory.document.registered"
  | "directory.document.archived"
  | "academics.year.created"
  | "academics.year.current_set"
  | "academics.term.created"
  | "academics.term.current_set"
  | "academics.subject.created"
  | "academics.class.created"
  | "academics.membership.assigned"
  | "academics.membership.archived"
  | "academics.teaching_assignment.created"
  | "academics.timetable.slot_created"
  | "academics.assessment.created"
  | "academics.mark.upserted"
  | "academics.mark.corrected"
  | "academics.marks.published"
  | "academics.homework.created"
  | "academics.material.registered"
  | "academics.report_card.published"
  | "academics.cbe.provenance.created"
  | "academics.cbe.learning_area.created"
  | "academics.cbe.strand.created"
  | "academics.cbe.result.recorded"
  | "academics.cbe.result.revised"
  | "academics.cbe.outcome.created"
  | "academics.cbe.evidence.registered"
  | "academics.cbe.rubric_config.upserted"
  | "academics.he.course.created"
  | "academics.he.enrolment.created"
  | "academics.online_exam.created"
  | "academics.online_exam.attempt_started"
  | "academics.online_exam.attempt_submitted"
  | "academics.he.grade.recorded"
  | "academics.he.grade.corrected"
  | "attendance.settings.updated"
  | "attendance.register.upserted"
  | "attendance.register.stale_ignored"
  | "attendance.early_sign_out.recorded"
  | "attendance.early_sign_out.voided";

export async function recordSecurityEvent(
  db: Db,
  input: {
    eventType: SecurityEventType;
    actorUserId?: string | null;
    tenantId?: string | null;
    detail?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  // R2-02: never pass a non-inet value into ::inet (zone IDs / garbage → null).
  const ip = normalizeIp(input.ip);
  await db.query(
    `INSERT INTO security_audit_events (actor_user_id, tenant_id, event_type, detail, ip)
     VALUES ($1, $2, $3, $4::jsonb, $5::inet)`,
    [
      input.actorUserId ?? null,
      input.tenantId ?? null,
      input.eventType,
      JSON.stringify(input.detail ?? {}),
      ip,
    ],
  );
}
