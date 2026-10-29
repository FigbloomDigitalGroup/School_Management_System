import { beforeAll, describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { signInAs, type SignedIn } from "./support/signInAs";

/**
 * QA 04 (FIG-1237): inside one school, can a parent, student, teacher or driver reach a record that is not theirs by
 * swapping an ID in a request? These call the same API the apps call, as each seeded user of the first demo school.
 *
 * Every write here sets a column to the value it already has, so a refusal and a wrongly allowed write look different
 * (no row comes back vs. the row comes back) and a wrongly allowed write changes nothing. Nothing is inserted.
 * The matching "allowed" cases and the heavier attacks (class not taught, un-published results, archived learners)
 * are in supabase/rls-checks/roles_in_school.sql.
 */

type Res = { data: unknown; error: PostgrestError | null };
const rows = (r: Res) => (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []);
/** A read that must show nothing (either an error or an empty list). */
const sees = (r: Res) => (r.error ? 0 : rows(r).length);
/** A write that must be refused: an error, or no row back. */
const changed = (r: Res) => (r.error ? 0 : rows(r).length);

/**
 * The tables that hold another learner's rows in the plain `npm run db:seed` data. The other per-learner tables (report cards,
 * health, documents, transport, ...) are empty there, so a test on them would pass without attacking anything; the SQL check
 * plants a row for another learner in each of them and covers those.
 */
const STUDENT_TABLES = ["fee_invoices", "attendance", "marks"] as const;

let admin: SignedIn, teacher: SignedIn, parent: SignedIn, student: SignedIn, driver: SignedIn;
let ownKids: string[] = [];
let ownStudentId = "";
/** table -> one row that belongs to a learner who is neither the parent's child nor the student, found as the school admin */
const victims = new Map<string, { id: string; student_id: string }>();

beforeAll(async () => {
  [admin, teacher, parent, student, driver] = await Promise.all(
    (["school_admin", "teacher", "parent", "student", "driver"] as const).map((r) => signInAs(r)),
  );
  const links = await parent.client.from("guardians").select("student_id").eq("profile_id", parent.userId);
  ownKids = (links.data ?? []).map((l) => l.student_id as string);
  const me = await student.client.from("students").select("id").eq("profile_id", student.userId);
  ownStudentId = (me.data?.[0]?.id as string) ?? "";
  const mine = [...ownKids, ownStudentId].filter(Boolean);
  for (const table of STUDENT_TABLES) {
    const { data } = await admin.client
      .from(table)
      .select("*")
      .not("student_id", "in", `(${mine.join(",")})`)
      .limit(1);
    const row = data?.[0] as { id?: string; student_id: string } | undefined;
    if (row) victims.set(table, { id: row.id ?? row.student_id, student_id: row.student_id });
  }
}, 60_000);

describe("setup", () => {
  it("found the parent's children and the student's own record", () => {
    expect(ownKids.length).toBeGreaterThan(0);
    expect(ownStudentId).not.toBe("");
  });
  it("found other learners' rows to attack in the seeded tables (fees, attendance, marks)", () => {
    for (const t of ["fee_invoices", "attendance", "marks"]) expect(victims.has(t), `no rows of another learner in ${t}`).toBe(true);
  });
});

describe("parent: only their own children", () => {
  it("reads only their linked children in students", async () => {
    const { data, error } = await parent.client.from("students").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((s) => s.id as string).sort()).toEqual([...ownKids].sort());
  });

  it.each(STUDENT_TABLES)("control: reads their own children's rows in %s (the same request shape works)", async (table) => {
    const res = await parent.client.from(table).select("*").in("student_id", ownKids);
    expect(res.error).toBeNull();
    expect(rows(res).length).toBeGreaterThan(0);
  });

  it.each(STUDENT_TABLES)("swapping the student id: %s of another learner comes back empty", async (table) => {
    const v = victims.get(table)!;
    expect(v, `no row of another learner in ${table}`).toBeTruthy();
    const res = await parent.client.from(table).select("*").eq("student_id", v.student_id);
    expect(res.error).toBeNull();
    expect(sees(res)).toBe(0);
  });

  it("reads another learner's record by id: nothing", async () => {
    const res = await parent.client.from("students").select("id").eq("id", victims.get("fee_invoices")!.student_id);
    expect(sees(res)).toBe(0);
  });

  it("cannot mark an invoice paid (own child's invoice, same value written back)", async () => {
    const { data } = await parent.client.from("fee_invoices").select("id, paid_cents").in("student_id", ownKids).limit(1);
    const inv = data?.[0];
    expect(inv).toBeTruthy();
    const res = await parent.client.from("fee_invoices").update({ paid_cents: inv!.paid_cents }).eq("id", inv!.id).select();
    expect(changed(res)).toBe(0);
  });

  it("cannot link themself to another learner", async () => {
    const other = victims.get("fee_invoices")!.student_id;
    const res = await parent.client.from("guardians").update({ student_id: other }).eq("profile_id", parent.userId).select();
    expect(changed(res)).toBe(0);
  });

  it("cannot upload a payment proof on another learner's invoice", async () => {
    const inv = victims.get("fee_invoices")!;
    const res = await parent.client
      .from("payment_proofs")
      .insert({ tenant_id: (await tenantOf(parent)) as string, invoice_id: inv.id, uploaded_by: parent.userId, file_path: "qa/none.png", file_name: "none.png" })
      .select();
    expect(changed(res)).toBe(0);
  });
});

describe("student: only their own record", () => {
  it("reads only themself in students", async () => {
    const { data, error } = await student.client.from("students").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((s) => s.id)).toEqual([ownStudentId]);
  });

  it.each(STUDENT_TABLES)("control: reads their own rows in %s (the same request shape works)", async (table) => {
    const res = await student.client.from(table).select("*").eq("student_id", ownStudentId);
    expect(res.error).toBeNull();
    expect(rows(res).length).toBeGreaterThan(0);
  });

  it.each(STUDENT_TABLES)("swapping the student id: %s of another learner comes back empty", async (table) => {
    const v = victims.get(table)!;
    expect(v, `no row of another learner in ${table}`).toBeTruthy();
    const res = await student.client.from(table).select("*").eq("student_id", v.student_id);
    expect(res.error).toBeNull();
    expect(sees(res)).toBe(0);
  });

  it("cannot mark their own invoice paid", async () => {
    const { data } = await student.client.from("fee_invoices").select("id, paid_cents").eq("student_id", ownStudentId).limit(1);
    const inv = data?.[0];
    expect(inv).toBeTruthy();
    const res = await student.client.from("fee_invoices").update({ paid_cents: inv!.paid_cents }).eq("id", inv!.id).select();
    expect(changed(res)).toBe(0);
  });
});

describe("teacher: writes follow the class and subject, never exams or fee data", () => {
  it("cannot change a mark in a subject they are not assigned", async () => {
    const mine = await teacher.client.from("teaching_assignments").select("subject_id").eq("teacher_id", teacher.userId);
    const assigned = new Set((mine.data ?? []).map((a) => a.subject_id as string));
    expect(assigned.size).toBeGreaterThan(0);
    const { data } = await admin.client.from("marks").select("id, score, subject_id").not("score", "is", null).limit(1000);
    const foreign = (data ?? []).find((m) => !assigned.has(m.subject_id as string));
    expect(foreign, "no mark in a subject the teacher does not teach").toBeTruthy();
    const res = await teacher.client.from("marks").update({ score: foreign!.score }).eq("id", foreign!.id).select();
    expect(changed(res)).toBe(0);
  });

  it("cannot edit an exam", async () => {
    const { data } = await admin.client.from("exams").select("id, name").limit(1);
    const exam = data?.[0];
    expect(exam).toBeTruthy();
    const res = await teacher.client.from("exams").update({ name: exam!.name }).eq("id", exam!.id).select();
    expect(changed(res)).toBe(0);
  });

  it("cannot touch fee data", async () => {
    const { data } = await admin.client.from("fee_invoices").select("id, paid_cents").limit(1);
    const inv = data?.[0];
    expect(inv).toBeTruthy();
    const res = await teacher.client.from("fee_invoices").update({ paid_cents: inv!.paid_cents }).eq("id", inv!.id).select();
    expect(changed(res)).toBe(0);
  });

  it("cannot overwrite a private document or change a payment proof", async () => {
    for (const table of ["student_documents", "payment_proofs"] as const) {
      const { data } = await admin.client.from(table).select("id").limit(1);
      if (!data?.length) continue; // none seeded; the SQL check plants one
      const res = await teacher.client.from(table).update({ file_name: "x" }).eq("id", data[0]!.id).select();
      expect(changed(res), table).toBe(0);
    }
  });

  it("publish_marks refuses a subject they are not assigned", async () => {
    const mine = await teacher.client.from("teaching_assignments").select("subject_id").eq("teacher_id", teacher.userId);
    const assigned = new Set((mine.data ?? []).map((a) => a.subject_id as string));
    const subjects = await admin.client.from("subjects").select("id");
    const notMine = (subjects.data ?? []).find((s) => !assigned.has(s.id as string));
    const exam = (await admin.client.from("exams").select("id").limit(1)).data?.[0];
    const cls = (await admin.client.from("classes").select("id").limit(1)).data?.[0];
    expect(notMine && exam && cls).toBeTruthy();
    const { error } = await teacher.client.rpc("publish_marks", { p_exam_id: exam!.id, p_class_id: cls!.id, p_subject_id: notMine!.id });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/don't teach/i);
  });
});

describe("driver: nothing about learners' records", () => {
  it.each(["students", "fee_invoices", "attendance", "marks", "student_documents", "student_health"] as const)("reads no rows of %s", async (table) => {
    const res = await driver.client.from(table).select("*").limit(5);
    expect(sees(res)).toBe(0);
  });
});

async function tenantOf(who: SignedIn): Promise<string | null> {
  const { data } = await who.client.from("profiles").select("tenant_id").eq("id", who.userId);
  return (data?.[0]?.tenant_id as string) ?? null;
}
