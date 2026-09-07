/**
 * Seeds a local Supabase with the Kenyan demo data.
 *
 *   supabase start && supabase db reset
 *   npm run db:seed
 *
 * Uses the service role key, so it bypasses RLS. Never run against production.
 */

import { createClient } from "@supabase/supabase-js";
import {
  DEMO_TENANTS, DEMO_SUBJECTS, DEMO_CLASSES, DEMO_FEE_ITEMS,
  FIRST_NAMES, LAST_NAMES, DEMO_LOGINS,
} from "../packages/shared/src/demo";
import { itemsForStudent, totalCents } from "../packages/shared/src/fees";
import { studentLoginEmail } from "../packages/shared/src/auth";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required (supabase status shows it)");
if (url.includes("supabase.co") && !process.env.ALLOW_REMOTE_SEED) {
  throw new Error("Refusing to seed a remote project. Set ALLOW_REMOTE_SEED=1 if you really mean it.");
}

const db = createClient(url, key, { auth: { persistSession: false } });

const pick = <T,>(xs: readonly T[], i: number): T => xs[i % xs.length]!;
const rand = (seed: number) => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; };

async function main() {
  console.log("Seeding Figbloom demo data…");

  // ---------------------------------------------------------------- tenants
  const { data: tenants, error: tErr } = await db.from("tenants").insert(DEMO_TENANTS).select("id, slug, name");
  if (tErr) throw tErr;
  console.log(`  ${tenants!.length} schools`);

  const alliance = tenants!.find((t) => t.slug === "alliance")!;

  // ---------------------------------------------------------------- staff accounts
  const staff: Record<string, string> = {};
  for (const login of DEMO_LOGINS) {
    if (!("email" in login) || !login.email) continue;
    const { data: user, error } = await db.auth.admin.createUser({
      email: login.email,
      password: "figbloom-dev",
      email_confirm: true,
    });
    if (error) { console.warn(`  ! ${login.email}: ${error.message}`); continue; }
    await db.from("profiles").insert({
      id: user.user.id,
      tenant_id: login.role === "super_admin" ? null : alliance.id,
      role: login.role,
      full_name: login.who,
      email: login.email,
      staff_title: login.role === "school_admin" ? "Principal" : login.role === "teacher" ? "Chemistry teacher" : login.role === "driver" ? "Bus driver" : null,
    });
    staff[login.role] = user.user.id;
  }
  console.log(`  ${Object.keys(staff).length} staff accounts`);

  // ---------------------------------------------------------------- Alliance in full
  const { data: term } = await db.from("terms").insert({
    tenant_id: alliance.id, name: "Term 3, 2026", year: 2026, index: 3,
    starts_on: "2026-08-31", ends_on: "2026-11-27", is_current: true,
  }).select("id").single();

  await db.from("terms").insert({
    tenant_id: alliance.id, name: "Term 2, 2026", year: 2026, index: 2,
    starts_on: "2026-05-04", ends_on: "2026-08-01", is_current: false,
  });

  const { data: subjects } = await db.from("subjects")
    .insert(DEMO_SUBJECTS.map((s) => ({ ...s, tenant_id: alliance.id }))).select("id, name, code");

  const { data: classes } = await db.from("classes")
    .insert(DEMO_CLASSES.map((c) => ({ ...c, tenant_id: alliance.id }))).select("id, name, form_level");

  // teacher takes Chemistry across every class, and is class teacher of Form 2 West
  const form2west = classes!.find((c) => c.name === "Form 2 West")!;
  const chemistry = subjects!.find((s) => s.code === "CHE")!;
  if (staff.teacher) {
    await db.from("classes").update({ class_teacher_id: staff.teacher }).eq("id", form2west.id);
    await db.from("teaching_assignments").insert(
      classes!.map((c) => ({ tenant_id: alliance.id, teacher_id: staff.teacher!, class_id: c.id, subject_id: chemistry.id })),
    );
  }

  // ---------------------------------------------------------------- roster
  const r = rand(4102);
  const students: { tenant_id: string; admission_no: string; full_name: string; class_id: string; boarding: boolean }[] = [];
  let adm = 4000;
  for (const c of classes!) {
    const size = 38 + Math.floor(r() * 8);           // 38–45, a real Kenyan class
    for (let i = 0; i < size; i++) {
      adm += 1;
      while (adm === 4102 || adm === 4103) adm += 1; // reserved below for the demo student and sibling
      students.push({
        tenant_id: alliance.id,
        admission_no: String(adm),
        full_name: `${pick(FIRST_NAMES, Math.floor(r() * 97) + i)} ${pick(LAST_NAMES, Math.floor(r() * 89) + i)}`,
        class_id: c.id,
        boarding: r() > 0.35,
      });
    }
  }
  // the demo student, at a known admission number
  students[0] = { tenant_id: alliance.id, admission_no: "4102", full_name: "Faith Achieng", class_id: form2west.id, boarding: true };
  students[1] = { tenant_id: alliance.id, admission_no: "4103", full_name: "Samuel Achieng", class_id: classes!.find((c) => c.name === "Form 4 East")!.id, boarding: true };

  const { data: inserted, error: sErr } = await db.from("students").insert(students).select("id, admission_no, full_name, class_id, boarding");
  if (sErr) throw sErr;
  console.log(`  ${inserted!.length} learners`);

  // ---------------------------------------------------------------- demo student login
  // Students have no email, so sign-in derives a synthetic address from admission_no + PIN
  // (see studentLoginEmail() in packages/shared/src/auth.ts) — kept in sync with DEMO_LOGINS.
  const demoStudent = inserted!.find((s) => s.admission_no === "4102")!;
  const { data: studentUser, error: stuErr } = await db.auth.admin.createUser({
    email: studentLoginEmail("4102", alliance.slug),
    password: "8421",
    email_confirm: true,
  });
  if (stuErr) { console.warn(`  ! student 4102: ${stuErr.message}`); }
  else {
    await db.from("profiles").insert({
      id: studentUser.user.id, tenant_id: alliance.id, role: "student", full_name: demoStudent.full_name,
    });
    await db.from("students").update({ profile_id: studentUser.user.id }).eq("id", demoStudent.id);
  }
  console.log(`  1 student login (admission 4102)`);

  // ---------------------------------------------------------------- parent with two children
  const { data: parentUser } = await db.auth.admin.createUser({
    phone: "+254722118004", phone_confirm: true, password: "figbloom-dev",
  });
  if (parentUser?.user) {
    await db.from("profiles").insert({
      id: parentUser.user.id, tenant_id: alliance.id, role: "parent",
      full_name: "Rose Achieng", phone: "+254722118004",
    });
    const faith = inserted!.find((s) => s.admission_no === "4102")!;
    const samuel = inserted!.find((s) => s.admission_no === "4103")!;
    await db.from("guardians").insert([
      { tenant_id: alliance.id, profile_id: parentUser.user.id, student_id: faith.id, relationship: "mother", is_primary_payer: true },
      { tenant_id: alliance.id, profile_id: parentUser.user.id, student_id: samuel.id, relationship: "mother", is_primary_payer: true },
    ]);
  }

  // ---------------------------------------------------------------- fees
  const { data: feeItems } = await db.from("fee_items")
    .insert(DEMO_FEE_ITEMS.map((f) => ({ ...f, tenant_id: alliance.id, term_id: term!.id }))).select("*");

  const invoices = inserted!.map((s) => {
    const level = classes!.find((c) => c.id === s.class_id)!.form_level;
    const applicable = itemsForStudent(feeItems as never, { boarding: s.boarding }, level);
    const total = totalCents(applicable as never);
    const paidRatio = r();
    return {
      tenant_id: alliance.id, student_id: s.id, term_id: term!.id,
      total_cents: total,
      paid_cents: paidRatio > 0.7 ? total : Math.round((total * Math.floor(paidRatio * 10)) / 10 / 1000) * 1000,
      due_on: "2026-09-15",
    };
  });
  await db.from("fee_invoices").insert(invoices);
  console.log(`  ${invoices.length} fee invoices`);

  // ---------------------------------------------------------------- exams and marks
  const { data: exams } = await db.from("exams").insert([
    { tenant_id: alliance.id, term_id: term!.id, name: "Mock 1", out_of: 100, published_at: new Date().toISOString() },
    { tenant_id: alliance.id, term_id: term!.id, name: "End of Term 3", out_of: 100, published_at: null },
  ]).select("id, name");

  const mock1 = exams!.find((e) => e.name === "Mock 1")!;
  const f2w = inserted!.filter((s) => s.class_id === form2west.id);
  const marks = f2w.flatMap((s) =>
    subjects!.map((sub) => ({
      tenant_id: alliance.id, exam_id: mock1.id, student_id: s.id, subject_id: sub.id,
      score: Math.min(98, Math.max(28, Math.round(58 + (r() - 0.4) * 46))),
      entered_by: staff.teacher ?? staff.school_admin!,
    })),
  );
  await db.from("marks").insert(marks);
  console.log(`  ${marks.length} marks for Form 2 West`);

  // ---------------------------------------------------------------- attendance, last 10 school days
  const days: string[] = [];
  for (let d = 1; days.length < 10; d++) {
    const date = new Date(Date.UTC(2026, 8, 2) - d * 86400000);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) days.push(date.toISOString().slice(0, 10));
  }
  const attendance = days.flatMap((day) =>
    f2w.map((s) => {
      const roll = r();
      return {
        tenant_id: alliance.id, student_id: s.id, class_id: form2west.id, term_id: term!.id,
        taken_by: staff.teacher ?? staff.school_admin!, taken_on: day,
        mark: roll > 0.94 ? "absent" : roll > 0.9 ? "late" : "present",
      };
    }),
  );
  await db.from("attendance").insert(attendance);
  console.log(`  ${attendance.length} attendance records`);

  // ---------------------------------------------------------------- announcements + work
  await db.from("announcements").insert([
    {
      tenant_id: alliance.id, author_id: staff.school_admin ?? staff.teacher!,
      subject: "Half-term closing Friday 12 September",
      body: "School closes for half-term on Friday 12 September at 12:30pm.\n\nBoarders travelling upcountry should collect travel passes from the deputy's office on Thursday. School reopens on Monday 22 September at 8:00am.",
      audience: { kind: "whole_school" }, channels: ["in_app", "sms"],
      published_at: new Date().toISOString(),
    },
    {
      tenant_id: alliance.id, author_id: staff.teacher ?? staff.school_admin!,
      subject: "Form 2 West: chemistry practical on Thursday",
      body: "Bring your lab coat. Anyone without one will not be allowed into Lab 1.",
      audience: { kind: "class", class_id: form2west.id }, channels: ["in_app"],
      published_at: new Date().toISOString(),
    },
  ]);

  await db.from("assignments").insert([
    { tenant_id: alliance.id, class_id: form2west.id, subject_id: chemistry.id, set_by: staff.teacher ?? staff.school_admin!, title: "Organic chemistry problem set 4", body: "Questions 1 to 14 on page 88. Show your working — an answer with no working gets half marks.", due_on: "2026-09-02", hand_in: "paper" },
    { tenant_id: alliance.id, class_id: form2west.id, subject_id: subjects!.find((s) => s.code === "HIS")!.id, set_by: staff.teacher ?? staff.school_admin!, title: "Essay: the causes of the Mau Mau uprising", body: "Two pages, in your own words. Use at least three causes and say which mattered most.", due_on: "2026-09-03", hand_in: "paper" },
  ]);

  // ---------------------------------------------------------------- fleet
  if (staff.driver) {
    const { data: vehicle } = await db.from("vehicles").insert({
      tenant_id: alliance.id, plate_number: "KDA 214B", make_model: "Isuzu NQR school bus", capacity: 44,
    }).select("id").single();

    const { data: route } = await db.from("routes").insert({
      tenant_id: alliance.id, name: "Route A · Kiambu Road", description: "Runnda, Kiambu Road, school gate.",
    }).select("id").single();

    if (vehicle && route) {
      const { data: stops } = await db.from("route_stops").insert([
        { tenant_id: alliance.id, route_id: route.id, name: "Runda roundabout", lat: -1.2214, lng: 36.8172, sequence: 1 },
        { tenant_id: alliance.id, route_id: route.id, name: "Kiambu Road junction", lat: -1.2110, lng: 36.8330, sequence: 2 },
        { tenant_id: alliance.id, route_id: route.id, name: "Alliance High School gate", lat: -1.1725, lng: 36.8390, sequence: 3 },
      ]).select("id, sequence");

      await db.from("vehicle_assignments").insert({
        tenant_id: alliance.id, vehicle_id: vehicle.id, driver_id: staff.driver, route_id: route.id,
      });

      const firstStop = stops?.find((s) => s.sequence === 1);
      const demoSibling = inserted!.find((s) => s.admission_no === "4103");
      await db.from("student_transport").insert([
        { tenant_id: alliance.id, student_id: demoStudent.id, route_id: route.id, stop_id: firstStop?.id ?? null },
        // siblings riding together, same stop — lets the parent demo show the
        // "not every child is on a route" case turn into "both children are" too
        ...(demoSibling ? [{ tenant_id: alliance.id, student_id: demoSibling.id, route_id: route.id, stop_id: firstStop?.id ?? null }] : []),
      ]);
      console.log("  1 bus, 1 route with 3 stops, 1 driver assignment, 2 riders");
    }
  }

  // ---------------------------------------------------------------- oversight trail
  await db.from("audit_events").insert([
    { tenant_id: alliance.id, actor_label: "system", event: "Tenant alliance provisioned", category: "provisioning" },
    { tenant_id: alliance.id, actor_label: "Peter Mwangi", event: "Term 3 fee structure published", category: "financial" },
    { tenant_id: alliance.id, actor_label: "Joyce Kimani · Figbloom", event: "Impersonation session ended, read only", category: "access" },
  ]);

  console.log("\nDone. Sign in with:");
  for (const l of DEMO_LOGINS) console.log(`  ${l.role.padEnd(13)} ${("email" in l && l.email) || ("phone" in l && l.phone) || ("admission_no" in l && l.admission_no)}  ${l.password}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
