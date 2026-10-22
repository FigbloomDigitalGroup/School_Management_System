/**
 * Seeds a CBE (Competency-Based Education) demo school into a local Supabase,
 * next to the 8-4-4 demo school from seed.ts.
 *
 *   supabase start && supabase db reset
 *   npm run db:seed          # optional: the 8-4-4 demo school + platform admin
 *   npm run db:seed-cbe
 *
 * Kijani Ridge Academy is a "combined" school with one class each at PP2,
 * Grade 3, Grade 5, Grade 8 and Grade 10 (STEM pathway), so every rubric and
 * band is exercised. Learning areas come from the KICD catalogue the
 * migrations seed; the strands are the SCHOOL'S OWN (tenant-owned), labelled
 * as demo data -- the official strand list is loaded by Figbloom staff from
 * KICD's designs, and this script doesn't pretend to be that.
 *
 * Uses the service role key, so it bypasses RLS. Never run against production.
 * Remote projects need ALLOW_REMOTE_SEED=1; add WITH_ORG=1 to also create the
 * "Kijani Ridge Group" organisation that owns the school.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DEMO_TENANTS, FIRST_NAMES, LAST_NAMES } from "../packages/shared/src/demo";
import { loginIdEmail } from "../packages/shared/src/auth";
import { CBC_RUBRIC_4, CBC_RUBRIC_8 } from "../packages/shared/src/gradingSchemes";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required (supabase status shows it)");
if (url.includes("supabase.co") && !process.env.ALLOW_REMOTE_SEED) {
  throw new Error("Refusing to seed a remote project. Set ALLOW_REMOTE_SEED=1 if you really mean it.");
}

const db = createClient(url, key, { auth: { persistSession: false } });

const SLUG = "kijani-ridge";
// Local runs keep the well-known dev password. Against a remote project every
// login gets a random one instead, printed once at the end -- unless
// SEED_PASSWORD sets one (a demo project where one shared password is fine).
const REMOTE = url.includes("supabase.co");
const PASSWORD = process.env.SEED_PASSWORD ?? (REMOTE ? randomBytes(9).toString("base64url") : "figbloom-dev");
// WITH_ORG=1 also creates a group-owner organisation that owns the school, with
// an org_admin login (see organizations.sql). Existing organisations are never touched.
const WITH_ORG = process.env.WITH_ORG === "1";
// FLEET_ONLY=1 adds just the buses, routes and drivers (seedFleet) to an
// existing Kijani Ridge -- tops up whatever buses it doesn't have yet.
const FLEET_ONLY = process.env.FLEET_ONLY === "1";
// LIFE_ONLY=1 adds just the day-to-day records (seedSchoolLife: fees and M-Pesa
// payments, attendance, timetables, announcements, homework, leave) to an existing
// Kijani Ridge -- skipped if this term's fee structure is already there.
const LIFE_ONLY = process.env.LIFE_ONLY === "1";

type Login = { login_id?: string; email?: string };

/** An auth user plus its profile in the school, signing in by email or login_id. */
async function createAccount(tenantId: string, login: Login, role: string, fullName: string, extra: Record<string, unknown> = {}) {
  const email = login.email ?? loginIdEmail(login.login_id!, SLUG);
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`${role} ${fullName}: ${error.message}`);
  const { error: pErr } = await db.from("profiles").insert({
    id: data.user.id, tenant_id: tenantId, role, full_name: fullName,
    email: login.email ?? null, login_id: login.login_id ?? null, ...extra,
  });
  if (pErr) throw new Error(`profile ${fullName}: ${pErr.message}`);
  return data.user.id;
}

type StopSeed = { name: string; lat: number; lng: number };

/**
 * Two buses on two routes in Nairobi, each with its own driver, and one of the
 * parent's children on each -- so the parent switching between Amani and
 * Zawadi follows two different buses, and the fleet map has two to show.
 * Sequence 1 is the school end of every route. Stop coordinates are illustrative.
 */
// Buses run by school section, so siblings in different sections ride different buses
// home: lower primary finishes first and its bus leaves first; the junior school bus
// follows on the same road a few minutes later (start its simulator with START_DELAY_MIN).
const IMARA_DAIMA: StopSeed[] = [
  { name: "Kijani Ridge Academy", lat: -1.3104, lng: 36.8340 },
  { name: "South B shops", lat: -1.3098, lng: 36.8420 },
  { name: "Enterprise Road", lat: -1.3191, lng: 36.8652 },
  { name: "Imara Daima", lat: -1.3290, lng: 36.8790 },
];
const FLEET: { driver: { login_id: string; name: string }; plate: string; make: string; capacity: number;
  route: string; description: string; stops: StopSeed[]; riders: { name: string; stop?: string }[] }[] = [
  {
    driver: { login_id: "BD-0001", name: "Joseph Kamau" }, plate: "KDK 482M", make: "Toyota Coaster school bus", capacity: 33,
    route: "Route 1 · Enterprise Road", description: "Primary section: Kijani Ridge gate to Imara Daima, via South B and Enterprise Road.",
    stops: IMARA_DAIMA,
    riders: [{ name: "Amani Mwangi" }],
  },
  {
    driver: { login_id: "BD-0002", name: "Peter Otieno" }, plate: "KDM 917T", make: "Isuzu NQR school bus", capacity: 41,
    route: "Route 2 · Lang'ata", description: "Kijani Ridge gate to Lang'ata, via Nyayo Stadium and Madaraka.",
    stops: [
      { name: "Kijani Ridge Academy", lat: -1.3104, lng: 36.8340 },
      { name: "Nyayo Stadium", lat: -1.3046, lng: 36.8240 },
      { name: "Madaraka", lat: -1.3085, lng: 36.8150 },
      { name: "Lang'ata (T-Mall)", lat: -1.3125, lng: 36.8070 },
    ],
    riders: [{ name: "Baraka Njoroge" }],   // no parent login: this route is shown from the admin/teacher side
  },
  {
    driver: { login_id: "BD-0003", name: "Mary Wanjiru" }, plate: "KDN 640P", make: "Nissan Civilian school bus", capacity: 29,
    route: "Route 3 · Enterprise Road (Junior School)", description: "Junior school section: same road as Route 1, leaving after the junior school day ends.",
    stops: IMARA_DAIMA,
    riders: [{ name: "Zawadi Mwangi" }],
  },
];

/**
 * The buses, routes and drivers in FLEET. Re-runnable: a bus whose plate is
 * already there is skipped, and riders are moved onto their FLEET route (a
 * learner rides one route), so it can top up a school seeded with fewer buses.
 */
async function seedFleet(tenantId: string, riderIdsByName: Record<string, string>) {
  for (const bus of FLEET) {
    const { data: found } = await db.from("vehicles").select("id").eq("tenant_id", tenantId).eq("plate_number", bus.plate).maybeSingle();
    let routeId: string;
    if (found) {
      const a = ok(await db.from("vehicle_assignments").select("route_id").eq("vehicle_id", found.id).eq("active", true).single(), `assignment ${bus.plate}`);
      routeId = a.route_id!;
    } else {
      const driverId = await createAccount(tenantId, { login_id: bus.driver.login_id }, "driver", bus.driver.name, { staff_title: "Bus driver" });
      const vehicle = ok(await db.from("vehicles").insert({
        tenant_id: tenantId, plate_number: bus.plate, make_model: bus.make, capacity: bus.capacity,
      }).select("id").single(), `vehicle ${bus.plate}`);
      const route = ok(await db.from("routes").insert({ tenant_id: tenantId, name: bus.route, description: bus.description }).select("id").single(), `route ${bus.route}`);
      routeId = route.id;
      ok(await db.from("route_stops").insert(bus.stops.map((st, i) => ({ tenant_id: tenantId, route_id: routeId, ...st, sequence: i + 1 }))).select("id"), `stops ${bus.route}`);
      const { error: aErr } = await db.from("vehicle_assignments").insert({ tenant_id: tenantId, vehicle_id: vehicle.id, driver_id: driverId, route_id: routeId });
      if (aErr) throw new Error(`vehicle_assignments: ${aErr.message}`);
      console.log(`  bus ${bus.plate} on ${bus.route} (${bus.stops.length} stops), driver ${bus.driver.login_id}`);
    }
    // riders get off at their named stop, or the far end, so the parent has a stop to watch the bus reach
    const stops = ok(await db.from("route_stops").select("id, name").eq("route_id", routeId).order("sequence"), "route stops");
    const stopFor = (name?: string) => (name ? stops.find((st) => st.name === name)! : stops[stops.length - 1]!).id;
    const riders = bus.riders.flatMap((x) => (riderIdsByName[x.name] ? [{ student_id: riderIdsByName[x.name]!, stop_id: stopFor(x.stop) }] : []));
    if (riders.length) {
      const { error } = await db.from("student_transport").upsert(
        riders.map((x) => ({ tenant_id: tenantId, route_id: routeId, ...x })),
        { onConflict: "student_id" },
      );
      if (error) throw new Error(`student_transport: ${error.message}`);
    }
  }
}

const pick = <T,>(xs: readonly T[], i: number): T => xs[i % xs.length]!;
const rand = (seed: number) => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; };
const ok = <T,>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error || r.data == null) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
};

type Level = "pre_primary" | "primary" | "junior_secondary" | "senior_school";

/** One class, and the KICD learning areas it studies. */
const CLASSES: { name: string; level: Level; year: number; pathway?: "stem"; areas: string[]; size: number }[] = [
  { name: "PP2 Sunflower",   level: "pre_primary",      year: 2,  areas: ["PP-LANG", "PP-MATH", "PP-ENV"],                size: 14 },
  { name: "Grade 3 Acacia",  level: "primary",          year: 3,  areas: ["LP-ENG", "LP-MATH", "LP-ENV"],                 size: 16 },
  { name: "Grade 5 Baobab",  level: "primary",          year: 5,  areas: ["UP-ENG", "UP-MATH", "UP-SCT"],                 size: 16 },
  { name: "Grade 8 Cedar",   level: "junior_secondary", year: 8,  areas: ["JS-ENG", "JS-MATH", "JS-ISC"],                 size: 18 },
  { name: "Grade 10 Fig",    level: "senior_school",    year: 10, pathway: "stem", areas: ["SS-ENG", "SS-MATH", "SS-PHY"], size: 16 },
];

/**
 * Illustrative strands, keyed `AREA-CODE:grade`. Each entry is a strand and
 * its sub-strands. Modelled on how KICD's designs are shaped (strand ->
 * sub-strand), NOT copied from them -- wording and coverage are demo-only.
 */
const STRANDS: Record<string, [string, string[]][]> = {
  "PP-LANG:2": [["Listening and Speaking", ["Oral Instructions", "Songs and Rhymes"]], ["Reading", ["Pre-reading", "Picture Reading"]], ["Writing", ["Pre-writing", "Letter Formation"]]],
  "PP-MATH:2": [["Numbers", ["Counting 1-20", "Number Recognition"]], ["Measurement", ["Length", "Capacity"]], ["Geometry", ["Shapes"]]],
  "PP-ENV:2":  [["Social Environment", ["My Family", "My School"]], ["Natural Environment", ["Plants", "Animals", "Weather"]]],
  "LP-ENG:3":  [["Listening and Speaking", ["Conversation", "Poems"]], ["Reading", ["Fluency", "Comprehension"]], ["Writing", ["Handwriting", "Simple Sentences"]]],
  "LP-MATH:3": [["Numbers", ["Whole Numbers up to 1000", "Addition", "Subtraction", "Multiplication"]], ["Measurement", ["Length", "Mass", "Time"]], ["Geometry", ["2-D Shapes", "Angles"]]],
  "LP-ENV:3":  [["Social Environment", ["Our Community", "Safety"]], ["Natural Environment", ["Soil", "Water", "Plants"]], ["Health Practices", ["Personal Hygiene"]]],
  "UP-ENG:5":  [["Listening and Speaking", ["Debate", "Oral Narratives"]], ["Reading", ["Intensive Reading", "Extensive Reading"]], ["Grammar in Use", ["Tenses", "Prepositions"]], ["Writing", ["Composition", "Letters"]]],
  "UP-MATH:5": [["Numbers", ["Whole Numbers", "Fractions", "Decimals"]], ["Measurement", ["Area", "Volume", "Time"]], ["Geometry", ["Angles", "Triangles"]], ["Data Handling", ["Bar Graphs"]]],
  "UP-SCT:5":  [["Living Things and Their Environment", ["Plant Parts", "Food Chains"]], ["Matter", ["States of Matter", "Mixtures"]], ["Energy", ["Sources of Energy", "Light"]]],
  "JS-ENG:8":  [["Listening and Speaking", ["Public Speaking"]], ["Reading", ["Fiction", "Non-fiction"]], ["Writing", ["Narrative", "Argumentative"]], ["Grammar in Use", ["Reported Speech", "Conditionals"]]],
  "JS-MATH:8": [["Numbers", ["Indices", "Rates and Ratios"]], ["Algebra", ["Linear Equations", "Algebraic Expressions"]], ["Measurements", ["Circles", "Surface Area"]], ["Geometry", ["Pythagoras' Theorem", "Transformations"]], ["Data Handling and Probability", ["Statistics", "Probability"]]],
  "JS-ISC:8":  [["Scientific Investigation", ["Safety in the Lab", "Experiments"]], ["Mixtures, Elements and Compounds", ["Separating Mixtures"]], ["Living Things and Their Environment", ["Cells", "Reproduction"]], ["Force and Energy", ["Force", "Simple Machines"]]],
  "SS-ENG:10": [["Listening and Speaking", ["Oral Presentation"]], ["Reading", ["Literary Texts", "Informational Texts"]], ["Writing", ["Report Writing", "Essays"]]],
  "SS-MATH:10": [["Numbers and Algebra", ["Surds", "Quadratic Equations"]], ["Geometry and Measurement", ["Trigonometry", "Vectors"]], ["Statistics and Probability", ["Data Presentation"]]],
  "SS-PHY:10": [["Measurement", ["Units and Measuring Instruments"]], ["Mechanics", ["Motion", "Forces"]], ["Waves", ["Light", "Sound"]], ["Electricity", ["Current and Circuits"]]],
};

const COMMENTS: Record<"high" | "mid" | "low", string[]> = {
  high: ["Consistently exceeds the expected competencies and helps classmates. Keep challenging yourself.", "Excellent work this term; applies learning confidently in new situations."],
  mid: ["Meets the expected competencies and is growing in confidence. Keep practising.", "Good steady progress; participates well in group tasks."],
  low: ["Is developing the expected competencies and needs more practice and support at home.", "Shows effort; revisit the strands marked below expectations with the teacher."],
};

const SLOTS = ["08:00", "08:40", "09:20", "10:20", "11:00", "11:40", "14:00", "14:40"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
// the periods other (unseeded) staff teach, filling each class's week around Daniel's lessons
const OTHER_PERIODS: Record<Level, string[]> = {
  pre_primary:      ["Creative Activities", "Story time", "Religious Activities", "Outdoor play", "Music and movement"],
  primary:          ["Kiswahili", "Creative Activities", "Religious Education", "Physical Education", "Reading time"],
  junior_secondary: ["Kiswahili", "Social Studies", "Pre-Technical Studies", "Agriculture", "Creative Arts", "CRE", "Physical Education"],
  senior_school:    ["Kiswahili", "Chemistry", "Biology", "Computer Studies", "Community Service Learning", "Physical Education"],
};
const LAB_AREAS = ["UP-SCT", "JS-ISC", "SS-PHY"];
const OUTDOOR = ["Physical Education", "Outdoor play"];

/**
 * A full week for every class with no clashes for Daniel, who teaches all 15
 * class/learning-area pairs: six lessons a day in six different slots, each
 * pair twice a week on different days. Every other slot is a free-text period.
 */
function weekTimetable() {
  const pairs = [0, 1, 2].flatMap((a) => CLASSES.map((c) => ({ cls: c, code: c.areas[a]! })));
  const lessons = new Map<string, string>();   // "class|day|slot" -> learning-area code
  DAYS.forEach((d, di) => [0, 1, 2, 3, 5, 6].forEach((slot, j) => {
    const pair = pairs[(di * 6 + j) % pairs.length]!;
    lessons.set(`${pair.cls.name}|${d}|${slot}`, pair.code);
  }));
  return CLASSES.flatMap((c) => {
    const home = `${c.name.split(" ").pop()} room`;
    let other = 0;
    return DAYS.flatMap((d) => SLOTS.map((start, slot) => {
      const code = lessons.get(`${c.name}|${d}|${slot}`);
      if (code) return { cls: c.name, day: d, start, code, label: null, room: LAB_AREAS.includes(code) ? "Science lab" : home };
      const label = OTHER_PERIODS[c.level][other++ % OTHER_PERIODS[c.level].length]!;
      return { cls: c.name, day: d, start, code: null, label, room: OUTDOOR.includes(label) ? "Field" : home };
    }));
  });
}

/**
 * The day-to-day records a demo walks through: this term's fee structure with
 * an invoice per learner (Zawadi part-paid in two M-Pesa instalments, Amani
 * paid up), every class's register from the start of term to yesterday --
 * today is left for the teacher to take live -- a clash-free timetable for
 * every class, announcements, homework across Daniel's classes, and his leave
 * requests (one approved, one waiting on the head). Looks everything up by
 * tenant, so it runs the same on a fresh seed or under LIFE_ONLY.
 */
async function seedSchoolLife(tenantId: string) {
  const term = ok(await db.from("terms").select("id, starts_on, ends_on").eq("tenant_id", tenantId).eq("is_current", true).single(), "current term");

  const staff = ok(await db.from("profiles").select("id, role, login_id").eq("tenant_id", tenantId).in("role", ["school_admin", "teacher"]), "staff");
  const headId = staff.find((p) => p.role === "school_admin")!.id;
  const teacherId = staff.find((p) => p.login_id === "TC-0001")!.id;
  const classes = ok(await db.from("classes").select("id, name").eq("tenant_id", tenantId), "classes");
  const classOf = (name: string) => classes.find((c) => c.name === name)!.id;
  const subjects = ok(await db.from("subjects").select("id, code, name").eq("tenant_id", tenantId), "subjects");
  const subjectOf = (code: string) => subjects.find((s) => s.code === code)!.id;
  const students = ok(await db.from("students").select("id, full_name, class_id, boarding").eq("tenant_id", tenantId), "students");
  const zawadi = students.find((s) => s.full_name === "Zawadi Mwangi")!;
  const amani = students.find((s) => s.full_name === "Amani Mwangi")!;
  const r = rand(808);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const at = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
  const g8 = classOf("Grade 8 Cedar");
  // each section skips itself if its rows are already there, so a run that failed partway can be re-run
  const seeded = async (table: string) => {
    const { count } = await db.from(table).select("*", { count: "exact", head: true }).eq("tenant_id", tenantId);
    if (count) console.log(`  ${table} already seeded; skipped`);
    return !!count;
  };

  // ---------------------------------------------------------------- fees
  if (await seeded("fee_items")) {
    // a run that stopped after the invoices: put the two demo children's balances right
    const fix = async (id: string, paid: (total: number) => number) => {
      const inv = ok(await db.from("fee_invoices").select("id, total_cents").eq("student_id", id).eq("term_id", term.id).single(), "invoice");
      const cents = paid(inv.total_cents);
      ok(await db.from("fee_invoices").update({ paid_cents: cents, status: cents >= inv.total_cents ? "paid" : "part_paid" }).eq("id", inv.id).select("id"), "invoice update");
    };
    await fix(zawadi.id, () => 2_000_000);
    await fix(amani.id, (total) => total);
  } else {
    const items = [
      { name: "Tuition", amount_cents: 2_200_000, applies_to: "all" },
      { name: "Lunch programme", amount_cents: 850_000, applies_to: "day" },
      { name: "Boarding and meals", amount_cents: 1_600_000, applies_to: "boarders" },
      { name: "Activity and clubs", amount_cents: 250_000, applies_to: "all" },
      { name: "ICT and digital learning", amount_cents: 150_000, applies_to: "all" },
    ] as const;
    ok(await db.from("fee_items").insert(items.map((f) => ({ ...f, tenant_id: tenantId, term_id: term.id, form_level: null }))).select("id"), "fee_items");
    const invoices = ok(await db.from("fee_invoices").insert(students.map((s) => {
      const total = items.filter((f) => f.applies_to === "all" || f.applies_to === (s.boarding ? "boarders" : "day")).reduce((a, f) => a + f.amount_cents, 0);
      // Zawadi part-paid in instalments, Amani paid up, everyone else a spread. paid_cents is
      // set directly rather than through payments, so this also seeds a database that doesn't
      // have the apply_payment fix (20261008000000) yet -- before it, every successful payment failed.
      const roll = r();
      const paid = s.id === zawadi.id ? 2_000_000 : s.id === amani.id ? total : roll > 0.65 ? total : Math.round((total * roll) / 100_000) * 100_000;
      return {
        tenant_id: tenantId, student_id: s.id, term_id: term.id, total_cents: total, paid_cents: paid, due_on: "2026-10-30",
        status: paid >= total ? "paid" : paid > 0 ? "part_paid" : "unpaid",
      };
    })).select("id"), "fee_invoices");
    console.log(`  ${items.length} fee items, ${invoices.length} invoices (Zawadi part-paid, Amani paid up)`);
  }

  // ---------------------------------------------------------------- attendance, start of term to yesterday
  if (!(await seeded("attendance"))) {
    const last = day(-1) < term.ends_on ? day(-1) : term.ends_on;
    const days: string[] = [];
    for (let d = new Date(`${term.starts_on}T00:00:00Z`); d.toISOString().slice(0, 10) <= last; d = new Date(d.getTime() + 86_400_000)) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
    }
    const attendance = days.flatMap((taken_on) => students.map((s) => {
      const roll = r();
      // Zawadi: one late morning and nothing worse
      const mark = s.id === zawadi.id ? (taken_on === days[days.length - 6] ? "late" : "present")
        : roll > 0.95 ? "absent" : roll > 0.91 ? "late" : roll > 0.9 ? "excused" : "present";
      return { tenant_id: tenantId, student_id: s.id, class_id: s.class_id, term_id: term.id, taken_by: teacherId, taken_on, mark };
    }));
    for (let i = 0; i < attendance.length; i += 1000) {
      const { error } = await db.from("attendance").insert(attendance.slice(i, i + 1000));
      if (error) throw new Error(`attendance: ${error.message}`);
    }
    console.log(`  ${attendance.length} attendance records over ${days.length} school days (today left to take live)`);
  }

  // ---------------------------------------------------------------- timetables, every class
  if (!(await seeded("timetable_slots"))) {
    const slots = weekTimetable().map((p) => {
      const subject = p.code ? subjects.find((s) => s.code === p.code)! : null;
      return { tenant_id: tenantId, class_id: classOf(p.cls), day: p.day, start_time: p.start, label: subject?.name ?? p.label!, room: p.room, subject_id: subject?.id ?? null };
    });
    ok(await db.from("timetable_slots").insert(slots).select("id"), "timetable_slots");
    console.log(`  ${slots.length} timetable slots (all ${CLASSES.length} classes; Daniel teaches 30 lessons a week, no clashes)`);
  }

  // ---------------------------------------------------------------- announcements
  if (!(await seeded("announcements"))) {
    ok(await db.from("announcements").insert([
      {
        tenant_id: tenantId, author_id: headId, subject: "Term 3 fee balances due by Friday 30 October",
        body: "Please clear Term 3 balances by Friday 30 October. You can pay by M-Pesa from the parent app, in instalments if that suits your family better.\n\nIf you need a payment plan, talk to the bursar's office; we would rather agree a plan than have a learner miss lessons.",
        audience: { kind: "role", role: "parent" }, channels: ["in_app", "sms"], published_at: at(-6),   // money talk goes to payers, not staff or learners
      },
      {
        tenant_id: tenantId, author_id: headId, subject: "No school on Tuesday 20 October: Mashujaa Day",
        body: "School is closed on Tuesday 20 October for Mashujaa Day. Buses run as normal on Monday 19 and Wednesday 21 October.",
        audience: { kind: "whole_school" }, channels: ["in_app", "sms"], published_at: at(-2),
      },
      {
        tenant_id: tenantId, author_id: teacherId, subject: "Grade 8 Cedar: science fair projects due Friday 16 October",
        body: "Each group presents a working model on separating mixtures. Bring materials from home on Wednesday; we build in the science lab on Thursday.",
        audience: { kind: "class", class_id: g8, recipients: "both" }, channels: ["in_app"], published_at: at(-1),
      },
      {
        tenant_id: tenantId, author_id: teacherId, subject: "Grade 8 parents' meeting: Saturday 24 October, 9am",
        body: "We will go through each learner's Term 3 progress report and the Grade 9 pathway choices. Tea will be served in the hall.",
        audience: { kind: "class", class_id: g8, recipients: "guardians" }, channels: ["in_app", "sms"], published_at: at(-1),
      },
    ]).select("id"), "announcements");
    console.log("  4 announcements");
  }

  // ---------------------------------------------------------------- homework
  if (!(await seeded("assignments"))) {
    const work = ok(await db.from("assignments").insert([
      { tenant_id: tenantId, class_id: g8, subject_id: subjectOf("JS-MATH"), set_by: teacherId, title: "Linear equations: exercise 4B", body: "Questions 1 to 12 on page 61. Show every step; checking your answer by substitution earns a bonus mark.", due_on: day(-3), hand_in: "paper" },
      { tenant_id: tenantId, class_id: g8, subject_id: subjectOf("JS-ENG"), set_by: teacherId, title: "Argumentative essay: should phones be allowed in school?", body: "One and a half pages. Give at least three arguments, answer one from the other side, and end with your own position.", due_on: day(1), hand_in: "paper" },
      { tenant_id: tenantId, class_id: g8, subject_id: subjectOf("JS-ISC"), set_by: teacherId, title: "Separating mixtures: practical write-up", body: "Write up Thursday's filtration and evaporation practical: aim, apparatus, method, results and one thing you would change.", due_on: day(6), hand_in: "in_person" },
      { tenant_id: tenantId, class_id: classOf("Grade 3 Acacia"), subject_id: subjectOf("LP-MATH"), set_by: teacherId, title: "Multiplication: page 42", body: "Do the first row together with a parent, then the rest on your own.", due_on: day(2), hand_in: "paper" },
      { tenant_id: tenantId, class_id: classOf("Grade 5 Baobab"), subject_id: subjectOf("UP-SCT"), set_by: teacherId, title: "Food chains: draw one from the school garden", body: "Find at least four living things in the school garden and draw the food chain that links them. Label the producer.", due_on: day(4), hand_in: "paper" },
      { tenant_id: tenantId, class_id: classOf("Grade 10 Fig"), subject_id: subjectOf("SS-PHY"), set_by: teacherId, title: "Motion: speed-time graphs worksheet", body: "Complete the worksheet handed out in class. Question 6 is a stretch question; try it before Friday's lesson.", due_on: day(-1), hand_in: "upload" },
    ]).select("id, title"), "assignments");
    // the overdue tasks have hand-ins from most of the class, so the teacher's view has something to look at
    const handIns = work.filter((w) => w.title.startsWith("Linear") || w.title.startsWith("Motion")).flatMap((w) => {
      const cls = w.title.startsWith("Linear") ? g8 : classOf("Grade 10 Fig");
      return students.filter((s) => s.class_id === cls && (s.id === zawadi.id || r() > 0.25)).map((s) => ({ assignment_id: w.id, student_id: s.id }));
    });
    ok(await db.from("assignment_submissions").insert(handIns).select("student_id"), "assignment_submissions");
    console.log(`  ${work.length} homework tasks, ${handIns.length} hand-ins`);
  }

  // ---------------------------------------------------------------- leave: one taken, one for the head to decide live
  if (!(await seeded("leave_requests"))) {
    ok(await db.from("leave_requests").insert([
      { tenant_id: tenantId, teacher_id: teacherId, starts_on: "2026-09-21", ends_on: "2026-09-22", reason: "CBE assessment training at KICD",
        status: "approved", reviewed_by: headId, reviewed_at: "2026-09-15T10:05:00+03:00", review_note: "Approved. Please share the training notes at the next staff meeting." },
      { tenant_id: tenantId, teacher_id: teacherId, starts_on: day(13), ends_on: day(14), reason: "Family wedding in Eldoret",
        status: "pending" },
    ]).select("id"), "leave_requests");
    console.log("  2 leave requests for Daniel (1 approved, 1 pending)");
  }
}

async function main() {
  console.log("Seeding CBE demo school…");

  const { data: existing } = await db.from("tenants").select("id").eq("slug", SLUG).maybeSingle();
  if (FLEET_ONLY) {
    // add the bus, route and driver to a Kijani Ridge seeded before they existed
    if (!existing) throw new Error(`${SLUG} doesn't exist yet; run without FLEET_ONLY first.`);
    const { data: kids } = await db.from("students").select("id, full_name").eq("tenant_id", existing.id).in("full_name", FLEET.flatMap((b) => b.riders.map((x) => x.name)));
    await seedFleet(existing.id, Object.fromEntries((kids ?? []).map((k) => [k.full_name, k.id])));
    console.log(`\nDone. Drivers ${FLEET.map((b) => b.driver.login_id).join(", ")} (password ${PASSWORD}), Kijani Ridge Academy.`);
    return;
  }
  if (LIFE_ONLY) {
    if (!existing) throw new Error(`${SLUG} doesn't exist yet; run without LIFE_ONLY first.`);
    await seedSchoolLife(existing.id);
    console.log("\nDone. Kijani Ridge Academy now has fees, attendance, timetables, announcements and homework.");
    return;
  }
  if (existing) throw new Error(`${SLUG} already exists. supabase db reset to start clean.`);

  // ---------------------------------------------------------------- organisation
  let orgId: string | null = null;
  if (WITH_ORG) {
    const { data: found } = await db.from("organizations").select("id").eq("slug", "kijani-ridge-group").maybeSingle();
    if (found) throw new Error("kijani-ridge-group already exists; refusing to reuse it.");
    orgId = ok(await db.from("organizations").insert({
      name: "Kijani Ridge Group", slug: "kijani-ridge-group", kind: "group_owner", county: "Nairobi",
      contact_name: "Grace Wambui", contact_email: "head@kijaniridge.sc.ke", status: "active",
    }).select("id").single(), "organization").id;
  }

  // ---------------------------------------------------------------- school
  const tenant = ok(await db.from("tenants").insert({
    ...DEMO_TENANTS[0]!, name: "Kijani Ridge Academy", slug: SLUG, county: "Nairobi", level: "combined",
    organization_id: orgId, moe_registration: "31/4/0201", plan: "standard", status: "active", accent: "#0F5257", licensed_seats: 400,
  }).select("id").single(), "tenant");
  const tenantId = tenant.id;

  // ---------------------------------------------------------------- staff, parent
  const account = (login: Login, role: string, fullName: string, extra: Record<string, unknown> = {}) =>
    createAccount(tenantId, login, role, fullName, extra);

  await account({ email: "head@kijaniridge.sc.ke" }, "school_admin", "Grace Wambui", { staff_title: "Head Teacher" });
  const teacherId = await account({ login_id: "TC-0001" }, "teacher", "Daniel Kiprop", { staff_title: "Class teacher" });
  const parentId = await account({ login_id: "PT-0001" }, "parent", "Lucy Mwangi", { phone: "+254722000111" });
  if (orgId) {
    const { data, error } = await db.auth.admin.createUser({ email: "group@kijaniridge.sc.ke", password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`org_admin: ${error.message}`);
    const { error: pErr } = await db.from("profiles").insert({
      id: data.user.id, tenant_id: null, role: "org_admin", full_name: "Kijani Ridge Group Admin", email: "group@kijaniridge.sc.ke",
    });
    if (pErr) throw new Error(`org_admin profile: ${pErr.message}`);
    const { error: oErr } = await db.from("organization_admins").insert({ profile_id: data.user.id, organization_id: orgId });
    if (oErr) throw new Error(`organization_admins: ${oErr.message}`);
  }
  console.log(`  head teacher, 1 teacher, 1 parent${orgId ? ", 1 org admin" : ""}`);

  // ---------------------------------------------------------------- term
  await db.from("terms").insert({
    tenant_id: tenantId, name: "Term 2, 2026", year: 2026, index: 2,
    starts_on: "2026-05-04", ends_on: "2026-08-01", is_current: false,
  });
  const term = ok(await db.from("terms").insert({
    tenant_id: tenantId, name: "Term 3, 2026", year: 2026, index: 3,
    starts_on: "2026-08-31", ends_on: "2026-11-27", is_current: true,
  }).select("id").single(), "term");

  // ---------------------------------------------------------------- learning areas -> subjects
  const wanted = [...new Set(CLASSES.flatMap((c) => c.areas))];
  const areas = ok(await db.from("learning_areas").select("id, code, name, level, min_grade, max_grade, is_core").in("code", wanted), "learning_areas");
  if (areas.length !== wanted.length) {
    throw new Error(`Catalogue is missing learning areas (${areas.length}/${wanted.length}). Run supabase db reset so the KICD seed migration applies.`);
  }
  const subjects = ok(await db.from("subjects").insert(areas.map((a) => ({
    tenant_id: tenantId, name: a.name, code: a.code, is_core: a.is_core, learning_area_id: a.id,
    level: a.level, min_form_level: a.min_grade, max_form_level: a.max_grade,
  }))).select("id, code, learning_area_id"), "subjects");

  // ---------------------------------------------------------------- classes, teaching
  const classes = ok(await db.from("classes").insert(CLASSES.map((c) => ({
    tenant_id: tenantId, name: c.name, level: c.level, form_level: c.year, pathway: c.pathway ?? null,
  }))).select("id, name, level, form_level"), "classes");
  await db.from("classes").update({ class_teacher_id: teacherId }).eq("id", classes.find((c) => c.name === "Grade 8 Cedar")!.id);

  const subjectOf = (code: string) => subjects.find((s) => s.code === code)!;
  const classOf = (name: string) => classes.find((c) => c.name === name)!;
  await db.from("teaching_assignments").insert(CLASSES.flatMap((c) =>
    c.areas.map((code) => ({ tenant_id: tenantId, teacher_id: teacherId, class_id: classOf(c.name).id, subject_id: subjectOf(code).id }))));
  console.log(`  ${areas.length} subjects (linked to KICD learning areas), ${classes.length} classes`);

  // ---------------------------------------------------------------- strands (school-owned demo strands)
  const areaId = (code: string) => areas.find((a) => a.code === code)!.id;
  const strandIds = new Map<string, string[]>();   // "CODE:grade" -> assessed (top-level) strand ids
  let strandCount = 0;
  for (const [k, list] of Object.entries(STRANDS)) {
    const [code, grade] = k.split(":") as [string, string];
    const source = "Demo data: illustrative, not KICD text";
    const parents = ok(await db.from("strands").insert(list.map(([name], i) => ({
      tenant_id: tenantId, learning_area_id: areaId(code), grade: Number(grade), name, sort_order: (i + 1) * 10, source,
    }))).select("id, name"), `strands ${k}`);
    await db.from("strands").insert(list.flatMap(([name, subs]) =>
      subs.map((sub, i) => ({
        tenant_id: tenantId, learning_area_id: areaId(code), grade: Number(grade), parent_id: parents.find((p) => p.name === name)!.id,
        name: sub, sort_order: (i + 1) * 10, source,
      }))));
    strandIds.set(k, parents.map((p) => p.id));
    strandCount += list.length + list.reduce((n, [, s]) => n + s.length, 0);
  }
  console.log(`  ${strandCount} demo strands and sub-strands (owned by the school)`);

  // ---------------------------------------------------------------- learners
  const r = rand(2026);
  let adm = 7000;
  const roster = CLASSES.flatMap((c) => Array.from({ length: c.size }, (_, i) => {
    adm += 1;
    return {
      tenant_id: tenantId, admission_no: String(adm), class_id: classOf(c.name).id,
      full_name: `${pick(FIRST_NAMES, Math.floor(r() * 97) + i)} ${pick(LAST_NAMES, Math.floor(r() * 89) + i)}`,
      boarding: c.level === "senior_school" ? r() > 0.4 : false,
    };
  }));
  // two known learners for the parent and student logins
  const g3 = roster.findIndex((s) => s.class_id === classOf("Grade 3 Acacia").id);
  const g8 = roster.findIndex((s) => s.class_id === classOf("Grade 8 Cedar").id);
  const g5 = roster.findIndex((s) => s.class_id === classOf("Grade 5 Baobab").id);
  roster[g3]!.full_name = "Amani Mwangi"; roster[g8]!.full_name = "Zawadi Mwangi"; roster[g5]!.full_name = "Baraka Njoroge";
  const students = ok(await db.from("students").insert(roster).select("id, full_name, class_id"), "students");
  const amani = students.find((s) => s.full_name === "Amani Mwangi")!;
  const zawadi = students.find((s) => s.full_name === "Zawadi Mwangi")!;
  await db.from("guardians").insert([amani, zawadi].map((s) => ({
    tenant_id: tenantId, profile_id: parentId, student_id: s.id, relationship: "mother", is_primary_payer: true,
  })));
  const studentProfile = await account({ login_id: "ST-0001" }, "student", zawadi.full_name);
  await db.from("students").update({ profile_id: studentProfile }).eq("id", zawadi.id);
  console.log(`  ${students.length} learners (parent PT-0001 has Grade 3 and Grade 8 children)`);

  // ---------------------------------------------------------------- fleet
  const baraka = students.find((s) => s.full_name === "Baraka Njoroge")!;
  await seedFleet(tenantId, { [amani.full_name]: amani.id, [zawadi.full_name]: zawadi.id, [baraka.full_name]: baraka.id });

  // ---------------------------------------------------------------- assessments, results, comments
  let resultCount = 0;
  const ability = new Map(students.map((s) => [s.id, r()]));
  for (const c of CLASSES) {
    const cls = classOf(c.name);
    const scale = c.level === "pre_primary" || c.level === "primary" ? CBC_RUBRIC_4 : CBC_RUBRIC_8;
    const learners = students.filter((s) => s.class_id === cls.id);
    for (const code of c.areas) {
      const strands = strandIds.get(`${code}:${c.year}`)!;
      const make = async (title: string, kind: "formative" | "summative", published: boolean, on: string) => {
        const a = ok(await db.from("cbe_assessments").insert({
          tenant_id: tenantId, term_id: term.id, class_id: cls.id, subject_id: subjectOf(code).id, title, kind,
          assessed_on: on, published_at: published ? new Date().toISOString() : null, created_by: teacherId,
        }).select("id").single(), `assessment ${title}`);
        const rows = learners.flatMap((s) => strands.map((strand_id) => {
          const score = Math.min(0.999, Math.max(0, ability.get(s.id)! * 0.8 + 0.1 + (r() - 0.5) * 0.35));
          const lvl = scale[Math.min(scale.length - 1, Math.floor((1 - score) * scale.length))]!;
          return { tenant_id: tenantId, assessment_id: a.id, student_id: s.id, strand_id, level_code: lvl.code, points: lvl.points, entered_by: teacherId };
        }));
        const { error } = await db.from("cbe_results").insert(rows);
        if (error) throw new Error(`results ${title}: ${error.message}`);
        resultCount += rows.length;
        if (published) {
          await db.from("cbe_assessment_comments").insert(learners.map((s) => {
            const band = ability.get(s.id)! > 0.66 ? "high" : ability.get(s.id)! > 0.33 ? "mid" : "low";
            return { tenant_id: tenantId, assessment_id: a.id, student_id: s.id, comment: pick(COMMENTS[band], Math.floor(r() * 10)) };
          }));
        }
      };
      await make("Term 3 opening assessment", "summative", true, "2026-09-18");
      // an unpublished draft the teacher is still marking, to show the publish step
      if (c.name === "Grade 8 Cedar" && code === "JS-MATH") await make("Week 6 check-in (draft)", "formative", false, "2026-10-02");
    }
  }
  console.log(`  ${resultCount} strand judgements`);

  // ---------------------------------------------------------------- fees, registers, timetables, notices, homework
  await seedSchoolLife(tenantId);

  console.log("\nDone. Kijani Ridge Academy sign-ins (password " + PASSWORD + "):");
  if (orgId) console.log("  org_admin     group@kijaniridge.sc.ke   (Kijani Ridge Group, owns the school)");
  console.log("  school_admin  head@kijaniridge.sc.ke");
  console.log("  teacher       TC-0001   (all five classes; class teacher of Grade 8 Cedar)");
  console.log("  parent        PT-0001   (Amani, Grade 3 · Zawadi, Grade 8)");
  console.log("  student       ST-0001   (Zawadi, Grade 8)");
  console.log("  driver        BD-0001   (Route 1 · primary bus, leaves first; Amani rides it to Imara Daima)");
  console.log("  driver        BD-0002   (Route 2 · Lang'ata; Baraka Njoroge, Grade 5, rides it)");
  console.log("  driver        BD-0003   (Route 3 · junior school bus, same road 5 min later; Zawadi rides it to Imara Daima)");
  console.log("Log-in IDs are scoped by school; pick Kijani Ridge Academy at sign-in.");
}

main().catch((e) => { console.error(e); process.exit(1); });
