/** Domain types. Mirrors supabase/schema.sql — keep the two in step. */

export type Role = "super_admin" | "school_admin" | "teacher" | "parent" | "student" | "driver" | "org_admin";

export type TenantStatus = "active" | "trial" | "onboarding" | "overdue" | "suspended" | "setup_stalled";

export type InstitutionType = "k12" | "higher_ed";

/** Descriptive only (FIG-357 v1) — a university/college/short_course/tvet
 *  tenant behave identically today (same courses/sections/GPA tables); this
 *  is a label, not yet a functional distinction. null for k12 tenants. */
export type HigherEdSubtype = "university" | "college" | "short_course" | "tvet";

/** A class's own grading band — independent of Tenant.level, which stays a
 *  whole-tenant descriptor. A 'combined' tenant's classes each carry their
 *  own ClassLevel so grading can key per-class (FIG-356). */
export type ClassLevel = "primary" | "junior_secondary" | "secondary";

/** Descriptive only (FIG-358 v1) — attendance/timetable stay roll-call/
 *  fixed-grid regardless of this value; only nav/routes (Fleet, Bus) are
 *  actually gated by it. */
export type DeliveryMode = "in_person" | "online" | "hybrid";

export interface Tenant {
  id: string;
  name: string;
  slug: string;              // path segment: /s/<slug>
  county: string;
  country: string;           // ISO 3166-1 alpha-2, e.g. "KE" — keys the grading-scheme registry
  level: "primary" | "secondary" | "combined";
  institution_type: InstitutionType;
  higher_ed_subtype: HigherEdSubtype | null;
  delivery_mode: DeliveryMode;
  role_labels: Partial<Record<"teacher" | "class_teacher" | "student" | "parent", string>>;
  moe_registration: string | null;
  plan: "standard" | "institution" | "county";
  status: TenantStatus;
  accent: string;            // hex, school-chosen
  logo_url: string | null;
  licensed_seats: number;
  payment_paybill: string | null;
  payment_till: string | null;
  payment_bank_details: string | null;
  payment_notes: string | null;
  price_cents_override: number | null;
  trial_ends_at: string | null;
  renews_on: string | null;
  organization_id: string | null;
  created_at: string;
}

export type OrganizationKind = "government" | "county" | "constituency" | "group_owner";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  kind: OrganizationKind;
  county: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  status: "pending" | "active" | "suspended";
  created_at: string;
  created_by: string | null;
}

export interface OrganizationAdmin {
  id: string;
  profile_id: string;
  organization_id: string;
  added_at: string;
  added_by: string | null;
}

/**
 * Aggregate-only, never a row of students/marks/attendance/fee_invoices
 * itself — trigger-maintained (FIG-332) rather than a live view, so an
 * org_admin's RLS grant on this table can never turn into a path back to PII.
 */
export interface OrganizationTenantSummary {
  tenant_id: string;
  organization_id: string | null;
  name: string;
  institution_type: InstitutionType;
  higher_ed_subtype: HigherEdSubtype | null;
  delivery_mode: DeliveryMode;
  status: TenantStatus;
  active_students: number;
  present_today: number;
  fees_billed_cents: number;
  fees_collected_cents: number;
  updated_at: string;
}

export interface OrganizationAccessLog {
  id: string;
  organization_id: string;
  profile_id: string;
  tenant_id: string | null; // null = an org-wide view, not one school
  action: string;
  accessed_at: string;
}

export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3";
export type IncidentStatus = "investigating" | "fix_in_review" | "resolved";

export interface PlatformIncident {
  id: string;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  affected_schools: number;
  status: IncidentStatus;
  opened_at: string;
  resolved_at: string | null;
  created_by: string | null;
}

/** "Overdue" isn't stored — nothing flips it on a schedule, so it's derived
 *  from due_date at read time instead of drifting stale. */
export type PlatformInvoiceStatus = "due" | "paid";

export interface PlatformInvoice {
  id: string;
  tenant_id: string;
  amount_cents: number;
  due_date: string;
  status: PlatformInvoiceStatus;
  paid_at: string | null;
  created_at: string;
}

export interface Profile {
  id: string;                // = auth.users.id
  tenant_id: string | null;  // null for super admins
  role: Role;
  full_name: string;
  email: string | null;
  phone: string | null;
  staff_title: string | null;
  /** School-assigned sign-in credential (e.g. "TC-0001") for every role
   *  except org_admin/super_admin, who keep real email (FIG-396/397). */
  login_id: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface Term {
  id: string;
  tenant_id: string;
  name: string;              // "Term 3, 2026"
  year: number;
  index: 1 | 2 | 3;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
}

export interface ClassGroup {
  id: string;
  tenant_id: string;
  name: string;              // "Form 2 West"
  level: ClassLevel;         // primary: form_level 1-6, junior_secondary: 7-9, secondary: 1-4 (Form 1-4)
  form_level: number;
  stream: string | null;     // "West"
  class_teacher_id: string | null;
  room: string | null;
}

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri";

export interface TimetableSlot {
  id: string;
  tenant_id: string;
  class_id: string;
  day: Weekday;
  start_time: string;        // "08:00"
  label: string;             // subject name, or "Games"/"Library"/"Class meeting" etc.
  room: string | null;
  /** Optional link to subjects — who teaches this period is then derived from
   *  teaching_assignments(class_id, subject_id), not stored here directly.
   *  Null for non-subject periods (Games, Library, Class meeting). */
  subject_id: string | null;
}

export interface Subject {
  id: string;
  tenant_id: string;
  name: string;
  code: string;
  is_core: boolean;
  min_form_level: number | null; // null = no lower bound, applies from the first form/grade
  max_form_level: number | null; // null = no upper bound, applies through the last form/grade
}

export interface Student {
  id: string;
  tenant_id: string;
  admission_no: string;
  full_name: string;
  class_id: string | null;   // null only for higher_ed students, who enroll into course_sections instead
  date_of_birth: string | null;
  gender: "male" | "female" | null; // null only for a record predating this field
  boarding: boolean;
  active: boolean;
}

/** A parent may have several children; a child may have several guardians. */
export interface Guardian {
  id: string;
  tenant_id: string;
  profile_id: string;
  student_id: string;
  relationship: "mother" | "father" | "guardian";
  is_primary_payer: boolean;
}

export type AttendanceMark = "present" | "absent" | "late" | "excused";

export interface AttendanceRecord {
  id: string;
  tenant_id: string;
  student_id: string;
  class_id: string;
  term_id: string;
  taken_by: string;
  taken_on: string;          // ISO date, one register per class per day
  mark: AttendanceMark;
  note: string | null;
  synced_at: string | null;  // null while still in the offline queue
}

export interface Exam {
  id: string;
  tenant_id: string;
  term_id: string;
  name: string;              // "Mock 1"
  out_of: number;            // 100
  published_at: string | null;
}

export interface Mark {
  id: string;
  tenant_id: string;
  exam_id: string;
  student_id: string;
  subject_id: string;
  score: number | null;
  entered_by: string;
  entered_at: string;
}

export interface FeeItem {
  id: string;
  tenant_id: string;
  term_id: string;
  name: string;              // "Tuition", "Boarding", "Activity"
  amount_cents: number;
  applies_to: "all" | "boarders" | "day" | "form_level";
  form_level: number | null;
}

export type InvoiceStatus = "unpaid" | "part_paid" | "paid" | "overdue";

export interface FeeInvoice {
  id: string;
  tenant_id: string;
  student_id: string;
  term_id: string;
  total_cents: number;
  paid_cents: number;
  due_on: string;
  status: InvoiceStatus;
}

export type PaymentStatus = "pending" | "success" | "failed" | "cancelled" | "timeout";

export interface Payment {
  id: string;
  tenant_id: string;
  invoice_id: string;
  amount_cents: number;
  method: "mpesa" | "bank" | "cash";
  msisdn: string | null;
  checkout_request_id: string | null;
  mpesa_receipt: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export type Audience =
  | { kind: "whole_school" }
  | { kind: "role"; role: Role }
  /** recipients omitted -- e.g. an admin's whole-class broadcast --
   *  reaches both a class's parents and its students, same as before this
   *  field existed. A teacher's per-class message (the only composer that
   *  ever sets it) picks one explicitly, since "to parents" and "to
   *  students" are genuinely different audiences reading the same inbox. */
  | { kind: "class"; class_id: string; recipients?: "guardians" | "students" | "both" }
  | { kind: "form_level"; form_level: number }
  | { kind: "user"; user_id: string };

/** Whether a `class`-kind Audience's `recipients` (undefined included)
 *  covers `side` -- shared by parentData.ts/studentData.ts so the two inbox
 *  filters can't drift apart on what "to parents" vs "to students" means. */
export function classAudienceIncludes(
  recipients: "guardians" | "students" | "both" | undefined,
  side: "guardians" | "students",
): boolean {
  return !recipients || recipients === "both" || recipients === side;
}

export interface Announcement {
  id: string;
  tenant_id: string;
  author_id: string;
  subject: string;
  body: string;
  audience: Audience;
  channels: ("in_app" | "sms" | "email" | "push")[];
  published_at: string | null;
  created_at: string;
}

export interface Assignment {
  id: string;
  tenant_id: string;
  class_id: string;
  subject_id: string;
  set_by: string;
  title: string;
  body: string;
  due_on: string;
  hand_in: "paper" | "in_person" | "upload";
}

export interface AuditEvent {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  actor_label: string;
  event: string;
  category: "provisioning" | "access" | "academic" | "financial";
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ImpersonationSession {
  id: string;
  tenant_id: string;
  staff_id: string;
  reason: string;
  scope: "read_only" | "write";
  started_at: string;
  ended_at: string | null;
  writes_count: number;
}

// ---------------------------------------------------------------- fleet

export interface Vehicle {
  id: string;
  tenant_id: string;
  plate_number: string;
  make_model: string | null;
  capacity: number | null;
  active: boolean;
  last_lat: number | null;
  last_lng: number | null;
  last_ping_at: string | null;
  speed_limit_kmh: number;
  created_at: string;
}

export interface Route {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  active: boolean;
}

export interface RouteStop {
  id: string;
  tenant_id: string;
  route_id: string;
  name: string;
  lat: number;
  lng: number;
  sequence: number;
}

export interface VehicleAssignment {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  driver_id: string;
  route_id: string | null;
  active: boolean;
}

export type TripStatus = "active" | "completed" | "cancelled";
export type TripDirection = "to_school" | "from_school";

export interface Trip {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  route_id: string | null;
  driver_id: string;
  direction: TripDirection;
  status: TripStatus;
  started_at: string;
  ended_at: string | null;
}

export interface VehicleLocation {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  trip_id: string | null;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  heading: number | null;
  recorded_at: string;
}

// ---------------------------------------------------------------- higher-ed

export interface Semester {
  id: string;
  tenant_id: string;
  name: string;
  year: number;
  index: 1 | 2 | 3;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
}

export interface Course {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  credits: number;
  department: string | null;
}

export interface CourseSection {
  id: string;
  tenant_id: string;
  course_id: string;
  semester_id: string;
  section_label: string;
  instructor_id: string | null;
  room: string | null;
  capacity: number | null;
}

export type EnrollmentStatus = "enrolled" | "dropped" | "completed";

export interface Enrollment {
  id: string;
  tenant_id: string;
  student_id: string;
  course_section_id: string;
  status: EnrollmentStatus;
  enrolled_at: string;
}

export interface CourseSectionTimetableSlot {
  id: string;
  tenant_id: string;
  course_section_id: string;
  day: Weekday;
  start_time: string;
  label: string;
  room: string | null;
}

export interface CourseAssessment {
  id: string;
  tenant_id: string;
  course_section_id: string;
  name: string;              // "Midterm", "Assignment 3", "Final"
  weight_pct: number;
  out_of: number;
  published_at: string | null;
}

export interface CourseMark {
  id: string;
  tenant_id: string;
  assessment_id: string;
  student_id: string;
  score: number | null;
  entered_by: string;
  entered_at: string;
}

export type LetterGrade = "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "D-" | "F";

export interface CourseGrade {
  id: string;
  tenant_id: string;
  student_id: string;
  course_section_id: string;
  weighted_score: number | null;
  letter_grade: LetterGrade | null;
  grade_points: number | null;
  finalized_at: string;
}

export type AlertKind = "speed" | "geofence";

export interface VehicleAlert {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  trip_id: string | null;
  kind: AlertKind;
  detail: string;
  lat: number;
  lng: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

export interface StudentTransport {
  id: string;
  tenant_id: string;
  student_id: string;
  route_id: string;
  stop_id: string | null;
}
