import { randomUUID } from "node:crypto";

/**
 * Shared route-sweep helpers (extracted from the FIG-1604 sweep so the RBAC matrix uses the SAME valid-body fixtures: a route
 * that validates its body before authorizing would otherwise answer 400 and hide the authorization behaviour under test).
 */
/**
 * Valid bodies for routes whose handler validates the body BEFORE authenticating. The OpenAPI
 * schema generator cannot produce them (patterns, at-least-one-field rules), and a 400 would
 * mask the gate. A 400 is treated as a test failure below, so a new validation-first route
 * must add a fixture here.
 */
export const BODY_FIXTURES: Record<string, unknown> = {
  // Account lifecycle: patterns/length bounds are not produced by sampleBody
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/assign": { owner_user_id: null },
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/notes": { note: "Fixture note text" },
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/escalate": { reason: "Fixture reason" },
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/resolve": { resolution: "other_evidenced", reason: "Fixture reason text", evidence: "Fixture evidence text" },
  "POST /v1/platform/finance/unmatched-callbacks/{caseId}/reopen": { reason: "Fixture reason text" },
  "POST /v1/tenants/{tenantId}/guardians/{guardianId}/account-link/revoke": { reason: "Fixture reason" },
  "POST /v1/platform/schools": { school_name: "Fixture School", slug: "fixture-school", admin_email: "admin@fixture.example" },
  "POST /v1/tenants/{tenantId}/invitations": { email: "fixture@example.com", role: "staff" },
  "POST /v1/tenants/{tenantId}/finance/reconciliation-findings/{findingId}/assign": { owner_user_id: null },
  "POST /v1/tenants/{tenantId}/finance/payments/{paymentId}/withdraw-unacknowledged-prompt": { reason: "Fixture reason", evidence: "Fixture evidence" },
  "PATCH /v1/tenants/{tenantId}/guardians/{guardianId}": { full_name: "Fixture Guardian" },
  // PatchLearnerRequest has no required fields (every field is optional, at least one must be
  // present), so the schema generator produces {} and the refine would answer 400 first.
  "PATCH /v1/tenants/{tenantId}/learners/{learnerId}": { full_name: "Fixture Learner" },
  "PATCH /v1/tenants/{tenantId}/school-profile": { county: "Nairobi" },
  "POST /v1/tenants/{tenantId}/staff": { full_name: "Fixture Staff" },
  // Stage 11: the patch body requires at least one field, so the empty sample would answer 400 before the gate.
  "PATCH /v1/tenants/{tenantId}/finance/fee-items/{feeItemId}": { name: "Fixture fee" },
  // the phone number is pattern-constrained, so the generic "x" sample would answer 400 before the gate
  "POST /v1/tenants/{tenantId}/finance/mpesa/prompts": { invoice_id: "00000000-0000-4000-8000-000000000001", amount_minor: 100000, msisdn: "254712345678" },
  // Remediation batch 1: the cancel reason has a 10-character minimum, so the generic "x" sample would answer 400 first
  "POST /v1/tenants/{tenantId}/finance/payments/{paymentId}/settlement-job/cancel": { reason: "Fixture cancellation reason" },
  "POST /v1/tenants/{tenantId}/finance/payments/{paymentId}/mpesa-reconciliation": { action: "refresh", note: "Fixture reconciliation note" },
  "PATCH /v1/tenants/{tenantId}/staff/{staffId}": { full_name: "Fixture Staff" },
  // Stage 9/10: date/time patterns and ordering constraints are not produced by sampleBody.
  "POST /v1/tenants/{tenantId}/academic-years": {
    label: "2026",
    starts_on: "2020-01-01",
    ends_on: "2035-12-31",
  },
  "POST /v1/tenants/{tenantId}/academic-terms": {
    academic_year_id: randomUUID(),
    index: 1,
    label: "Term 1",
    starts_on: "2020-01-01",
    ends_on: "2035-12-31",
  },
  "POST /v1/tenants/{tenantId}/subjects": { code: "ENG", name: "English" },
  // Migration 101: both patch bodies need at least one field, so the empty sample would answer 400 first.
  "PATCH /v1/tenants/{tenantId}/subjects/{subjectId}": { name: "Fixture subject" },
  "PATCH /v1/tenants/{tenantId}/classes/{classId}": { room: "Fixture room" },
  "POST /v1/tenants/{tenantId}/classes": {
    academic_year_id: randomUUID(),
    name: "Form 1A",
  },
  "POST /v1/tenants/{tenantId}/class-memberships": {
    learner_id: randomUUID(),
    class_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/teaching-assignments": {
    staff_member_id: randomUUID(),
    class_id: randomUUID(),
    subject_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/timetable-slots": {
    class_id: randomUUID(),
    subject_id: randomUUID(),
    day_of_week: 1,
    starts_at: "08:00:00",
    ends_at: "08:40:00",
  },
  "POST /v1/tenants/{tenantId}/attendance-registers": {
    learner_id: randomUUID(),
    class_id: randomUUID(),
    term_id: randomUUID(),
    taken_on: "2020-01-01",
    mark: "present",
  },
  "PUT /v1/tenants/{tenantId}/attendance-settings": {
    afternoon_enabled: false,
    percentage_mode: "session",
  },
  "POST /v1/tenants/{tenantId}/early-sign-outs": {
    learner_id: randomUUID(),
    reason: "Appointment",
    collected_by_name: "Parent",
    collected_by_relationship: "mother",
    id_number: "12345678",
    phone: "+254700000000",
    authorised_by: "Office",
  },
  "POST /v1/tenants/{tenantId}/early-sign-outs/{signOutId}/void": { reason: "Entered in error" },
  "POST /v1/tenants/{tenantId}/assessments": {
    class_id: randomUUID(),
    subject_id: randomUUID(),
    term_id: randomUUID(),
    title: "Midterm",
    kind: "exam",
    max_score: 100,
  },
  "POST /v1/tenants/{tenantId}/assessments/{assessmentId}/marks": {
    learner_id: randomUUID(),
    score: 10,
    row_version: 0,
  },
  "POST /v1/tenants/{tenantId}/homework-items": {
    class_id: randomUUID(),
    subject_id: randomUUID(),
    term_id: randomUUID(),
    title: "Homework",
    due_on: "2020-01-15",
    body: "Complete exercises 1–5",
  },
  "POST /v1/tenants/{tenantId}/learning-materials": {
    title: "Worksheet",
    class_id: randomUUID(),
    subject_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/grading-schemes": {
    name: "Percent",
    rules: { bands: [{ min: 0, grade: "E" }] },
  },
  "POST /v1/tenants/{tenantId}/report-cards": {
    class_id: randomUUID(),
    term_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/curriculum-provenance": {
    source_kind: "school_configured",
    source_label: "School catalogue",
  },
  "POST /v1/tenants/{tenantId}/learning-areas": {
    provenance_id: randomUUID(),
    code: "LA1",
    name: "Languages",
  },
  "POST /v1/tenants/{tenantId}/strands": {
    learning_area_id: randomUUID(),
    code: "S1",
    name: "Strand",
  },
  "POST /v1/tenants/{tenantId}/sub-strands": {
    strand_id: randomUUID(),
    code: "SS1",
    name: "Sub-strand",
  },
  "POST /v1/tenants/{tenantId}/learning-outcomes": {
    sub_strand_id: randomUUID(),
    code: "LO1",
    statement: "Can read",
  },
  "POST /v1/tenants/{tenantId}/rubric-configs": {
    name: "Default",
    descriptors: [{ level_code: "EE", label: "Exceeding", points: 4 }],
  },
  "POST /v1/tenants/{tenantId}/cbe-assessments": {
    class_id: randomUUID(),
    learning_area_id: randomUUID(),
    term_id: randomUUID(),
    title: "CBE check",
  },
  "POST /v1/tenants/{tenantId}/cbe-assessments/{cbeAssessmentId}/results": {
    learner_id: randomUUID(),
    strand_id: randomUUID(),
    level_code: "ME",
    points: 3,
  },
  "POST /v1/tenants/{tenantId}/competency-ratings": {
    term_id: randomUUID(),
    learner_id: randomUUID(),
    kind: "competency",
    item: "communication",
    level_code: "ME",
  },
  "POST /v1/tenants/{tenantId}/evidence-assets": {
    learner_id: randomUUID(),
    title: "Photo",
    provenance_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/he-courses": { code: "CS101", title: "Intro" },
  "POST /v1/tenants/{tenantId}/he-sections": {
    course_id: randomUUID(),
    term_id: randomUUID(),
    label: "A",
  },
  "POST /v1/tenants/{tenantId}/he-enrolments": {
    section_id: randomUUID(),
    learner_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/he-enrolments/{enrolmentId}/grade": {
    score: 4,
    grade: "A",
  },
  "POST /v1/tenants/{tenantId}/online-exam-papers": {
    title: "Paper 1",
    class_id: randomUUID(),
    subject_id: randomUUID(),
    max_score: 100,
  },
  "POST /v1/tenants/{tenantId}/online-exam-papers/{paperId}/attempts": {
    learner_id: randomUUID(),
  },
  "POST /v1/tenants/{tenantId}/online-exam-attempts/{attemptId}/submit": {
    score: 1,
  },
  // Stages 12–16: enums / min lengths that sampleBody may not satisfy.
  "POST /v1/tenants/{tenantId}/inventory/items": {
    name: "Fixture item",
    category: "other",
    tracking: "asset",
  },
  "POST /v1/tenants/{tenantId}/inventory/issues": {
    item_id: randomUUID(),
    learner_id: randomUUID(),
    quantity: 1,
  },
  "POST /v1/tenants/{tenantId}/inventory/issues/{issueId}/close": { status: "returned" },
  "POST /v1/tenants/{tenantId}/activities": { name: "Chess", category: "club" },
  "POST /v1/tenants/{tenantId}/leave-requests": {
    start_on: "2020-01-01",
    end_on: "2020-01-02",
    reason: "Medical appointment",
  },
  "POST /v1/tenants/{tenantId}/leave-requests/{leaveId}/review": { status: "approved" },
  "POST /v1/tenants/{tenantId}/health/sick-bay/visits": {
    learner_id: randomUUID(),
    complaint: "Headache",
  },
  "PUT /v1/tenants/{tenantId}/health/medical-settings": { notify_guardians: "serious" },
  "POST /v1/tenants/{tenantId}/imports/learners/preview": {
    csv: "admission_no,full_name,gender\nIM-9,Fixture,female\n",
  },
  "POST /v1/tenants/{tenantId}/imports/learners/apply": { import_id: randomUUID() },
  "POST /v1/tenants/{tenantId}/vehicles": { plate_number: "KDA123A" },
  "POST /v1/tenants/{tenantId}/transport-routes": { name: "West loop" },
  "POST /v1/auth/mfa/recovery-codes/regenerate": { code: "123456" },
  "POST /v1/auth/mfa/admin-reset": { user_id: randomUUID(), reason: "lost device fixture" },
  "POST /v1/tenants/{tenantId}/driver/trips": { vehicle_id: randomUUID(), direction: "to_school" },
  "POST /v1/tenants/{tenantId}/trips/{tripId}/driver-location": { lat: -1.28, lng: 36.81 },
  "POST /v1/tenants/{tenantId}/trips/{tripId}/events": { event_type: "delayed" },
  "POST /v1/tenants/{tenantId}/trips/{tripId}/cancel": { reason: "fixture" },
  "POST /v1/tenants/{tenantId}/trips": {
    vehicle_id: randomUUID(),
    driver_user_id: randomUUID(),
  },
};

/** Build a minimal body from the documented request schema so validation does not mask the gate. */
export function sampleBody(spec: any, op: any): unknown {
  const schema = op?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return undefined;
  const resolve = (s: any): any => {
    if (s?.$ref) {
      const name = String(s.$ref).split("/").pop()!;
      return resolve(spec.components.schemas[name]);
    }
    return s;
  };
  const make = (raw: any): unknown => {
    const s = resolve(raw);
    if (!s) return {};
    if (s.enum) return s.enum[0];
    const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
    if (type === "string") {
      if (s.format === "uuid") return randomUUID();
      if (s.format === "date") return "2020-01-01";
      if (s.format === "date-time") return "2020-01-01T08:00:00.000Z";
      if (s.format === "time") return "08:00:00";
      if (typeof s.pattern === "string" && s.pattern.includes("d{4}")) return "2020-01-01";
      if (typeof s.pattern === "string" && s.pattern.includes("d{2}")) return "08:00:00";
      // Respect minLength (e.g. a correction reason of 5+ characters) so validation cannot mask the gate.
      return "x".repeat(Math.max(1, typeof s.minLength === "number" ? s.minLength : 1));
    }
    if (type === "integer" || type === "number") return s.minimum ?? 1;
    if (type === "boolean") return false;
    if (type === "array") return s.minItems ? [make(s.items)] : [];
    const out: Record<string, unknown> = {};
    for (const key of s.required ?? []) out[key] = make(s.properties?.[key]);
    return out;
  };
  return make(schema);
}
