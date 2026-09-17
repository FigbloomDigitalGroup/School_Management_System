import type { Tenant } from "./types";

/**
 * Demo data for local development and the Playwright suite.
 * Real Kenyan school names, counties and fee levels so the UI is exercised at
 * realistic string lengths — "Moi Girls Eldoret" breaks layouts that "Acme" does not.
 */

export const DEMO_TENANTS: Omit<Tenant, "id" | "created_at">[] = [
  { name: "Alliance High School", slug: "alliance", county: "Kiambu", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "32/1/0084", plan: "institution", status: "active", accent: "#7A1F2B", logo_url: null, licensed_seats: 2000, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Kenya High School", slug: "kenya-high", county: "Nairobi", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "01/2/0011", plan: "institution", status: "active", accent: "#123C63", logo_url: null, licensed_seats: 1700, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Mang'u High School", slug: "mangu", county: "Kiambu", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "32/1/0102", plan: "institution", status: "active", accent: "#5C2E1F", logo_url: null, licensed_seats: 1900, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Lenana School", slug: "lenana", county: "Nairobi", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "01/2/0043", plan: "institution", status: "active", accent: "#3B3B6D", logo_url: null, licensed_seats: 1500, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "St. Mary's Yala", slug: "stmarys-yala", county: "Siaya", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "41/3/0067", plan: "standard", status: "active", accent: "#1B4D2E", logo_url: null, licensed_seats: 1000, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Moi Girls Eldoret", slug: "moi-girls-eldoret", county: "Uasin Gishu", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "27/1/0019", plan: "standard", status: "overdue", accent: "#7A1F2B", logo_url: null, licensed_seats: 1300, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Kisumu Boys High", slug: "kisumu-boys", county: "Kisumu", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "42/1/0008", plan: "standard", status: "overdue", accent: "#0F5257", logo_url: null, licensed_seats: 1100, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Nakuru Girls High", slug: "nakuru-girls", county: "Nakuru", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "31/2/0055", plan: "standard", status: "trial", accent: "#5C2E1F", logo_url: null, licensed_seats: 1200, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Kabarak High School", slug: "kabarak", county: "Nakuru", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "31/1/0071", plan: "standard", status: "onboarding", accent: "#1B4D2E", logo_url: null, licensed_seats: 1300, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
  { name: "Bungoma Secondary", slug: "bungoma-sec", county: "Bungoma", country: "KE", level: "secondary", institution_type: "k12", delivery_mode: "in_person", role_labels: {}, higher_ed_subtype: null, organization_id: null, moe_registration: "37/2/0090", plan: "standard", status: "setup_stalled", accent: "#123C63", logo_url: null, licensed_seats: 900, payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null, trial_ends_at: null, renews_on: null },
];

export const DEMO_SUBJECTS = [
  { name: "Mathematics", code: "MAT", is_core: true },
  { name: "English", code: "ENG", is_core: true },
  { name: "Kiswahili", code: "KIS", is_core: true },
  { name: "Chemistry", code: "CHE", is_core: true },
  { name: "Physics", code: "PHY", is_core: false },
  { name: "Biology", code: "BIO", is_core: false },
  { name: "Geography", code: "GEO", is_core: false },
  { name: "History", code: "HIS", is_core: false },
  { name: "CRE", code: "CRE", is_core: false },
];

export const DEMO_CLASSES = [
  { name: "Form 1 East", form_level: 1, stream: "East", room: "1 East" },
  { name: "Form 1 West", form_level: 1, stream: "West", room: "1 West" },
  { name: "Form 2 East", form_level: 2, stream: "East", room: "2 East" },
  { name: "Form 2 West", form_level: 2, stream: "West", room: "2 West" },
  { name: "Form 3 East", form_level: 3, stream: "East", room: "3 East" },
  { name: "Form 3 West", form_level: 3, stream: "West", room: "3 West" },
  { name: "Form 4 East", form_level: 4, stream: "East", room: "4 East" },
  { name: "Form 4 West", form_level: 4, stream: "West", room: "4 West" },
];

/** Kenyan given and family names, so rosters sort and wrap like the real thing. */
export const FIRST_NAMES = [
  "Faith", "Samuel", "Grace", "Brian", "Mercy", "Kevin", "Joy", "Dennis", "Cynthia", "Victor",
  "Esther", "Collins", "Nancy", "Felix", "Sharon", "Alex", "Ann", "Peter", "Lucy", "Michael",
  "Beatrice", "Emmanuel", "Purity", "Isaac", "Naomi", "Timothy", "Winnie", "George", "Caroline", "Daniel",
];

export const LAST_NAMES = [
  "Achieng", "Mwangi", "Wanjiru", "Otieno", "Njeri", "Kimani", "Odhiambo", "Wafula", "Chebet", "Kariuki",
  "Mutua", "Nyambura", "Omondi", "Kiptoo", "Muthoni", "Barasa", "Auma", "Kirui", "Wekesa", "Njoroge",
];

/** Term 3 fee structure at a mid-range boarding school, in cents. */
export const DEMO_FEE_ITEMS = [
  { name: "Tuition", amount_cents: 1_050_000, applies_to: "all" as const, form_level: null },
  { name: "Boarding and meals", amount_cents: 1_800_000, applies_to: "boarders" as const, form_level: null },
  { name: "Lunch programme", amount_cents: 450_000, applies_to: "day" as const, form_level: null },
  { name: "Activity and clubs", amount_cents: 150_000, applies_to: "all" as const, form_level: null },
  { name: "Examination fund", amount_cents: 200_000, applies_to: "all" as const, form_level: null },
  { name: "KCSE registration", amount_cents: 350_000, applies_to: "form_level" as const, form_level: 4 },
];

export const DEMO_TIMETABLE: Record<string, [string, string, string][]> = {
  Mon: [["08:00", "Mathematics", "Lab 2"], ["08:40", "English", "2 West"], ["09:20", "Chemistry", "Lab 1"], ["10:20", "History", "2 West"], ["11:00", "Kiswahili", "2 West"], ["12:00", "Biology", "Lab 3"], ["14:00", "Games", "Field"], ["14:40", "Physics", "Lab 1"]],
  Tue: [["08:00", "Kiswahili", "2 West"], ["08:40", "Chemistry", "Lab 1"], ["09:20", "Mathematics", "2 West"], ["10:20", "Geography", "2 West"], ["11:00", "English", "2 West"], ["12:00", "Physics", "Lab 1"], ["14:00", "Biology", "Lab 3"], ["14:40", "Library", "Library"]],
  Wed: [["08:00", "Physics", "Lab 1"], ["08:40", "Mathematics", "2 West"], ["09:20", "English", "2 West"], ["10:20", "Chemistry", "Lab 1"], ["11:00", "CRE", "2 West"], ["12:00", "Kiswahili", "2 West"], ["14:00", "Games", "Field"], ["14:40", "Biology", "Lab 3"]],
  Thu: [["08:00", "Biology", "Lab 3"], ["08:40", "Geography", "2 West"], ["09:20", "Kiswahili", "2 West"], ["10:20", "Mathematics", "2 West"], ["11:00", "Physics", "Lab 1"], ["12:00", "English", "2 West"], ["14:00", "History", "2 West"], ["14:40", "Chemistry", "Lab 1"]],
  Fri: [["08:00", "English", "2 West"], ["08:40", "Biology", "Lab 3"], ["09:20", "Physics", "Lab 1"], ["10:20", "Kiswahili", "2 West"], ["11:00", "Mathematics", "2 West"], ["12:00", "Chemistry", "Lab 1"], ["14:00", "Class meeting", "2 West"], ["14:40", "Games", "Field"]],
};

/**
 * FIG-396: only super_admin/school_admin keep a real email login now —
 * teacher/driver/parent/student all sign in with a school-assigned
 * login_id (see ROLE_ID_PREFIX/loginIdEmail in ./auth.ts) instead of
 * email/phone+SMS-OTP/admission+PIN.
 */
export const DEMO_LOGINS = [
  { role: "super_admin",  who: "Joyce Kimani",  email: "joyce@figbloom.co.ke",        password: "figbloom-dev" },
  { role: "school_admin", who: "Peter Mwangi",  email: "principal@alliance.sc.ke",    password: "figbloom-dev" },
  { role: "teacher",      who: "Mr Otieno",     login_id: "TC-0001", school: "Alliance High School", password: "figbloom-dev" },
  { role: "driver",       who: "James Kariuki", login_id: "BD-0001", school: "Alliance High School", password: "figbloom-dev" },
  { role: "parent",       who: "Rose Achieng",  login_id: "PT-0001", school: "Alliance High School", password: "figbloom-dev" },
  { role: "student",      who: "Faith Achieng", login_id: "ST-0001", school: "Alliance High School", password: "figbloom-dev" },
] as const;
