/** Domain types. Mirrors supabase/schema.sql — keep the two in step. */

export type Role = "super_admin" | "school_admin" | "teacher" | "parent" | "student" | "driver";

export type TenantStatus = "active" | "trial" | "onboarding" | "overdue" | "suspended" | "setup_stalled";

export interface Tenant {
  id: string;
  name: string;
  slug: string;              // path segment: /s/<slug>
  county: string;
  level: "primary" | "secondary" | "combined";
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
  form_level: number;        // 1..4
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
}

export interface Subject {
  id: string;
  tenant_id: string;
  name: string;
  code: string;
  is_core: boolean;
}

export interface Student {
  id: string;
  tenant_id: string;
  admission_no: string;
  full_name: string;
  class_id: string;
  date_of_birth: string | null;
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
  | { kind: "class"; class_id: string }
  | { kind: "form_level"; form_level: number };

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
