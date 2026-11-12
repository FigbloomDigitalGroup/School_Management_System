import { beforeAll, describe, expect, it } from "vitest";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import { loadParentData } from "../../packages/shared/src/parentData";
import { loadStudentFeeData } from "../../packages/shared/src/studentData";
import { TEST_ROLES, signInAs, type SignedIn } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * FIG-1497: the receipts a family sees (the parent's home and Fees, the learner's own Fees) come from successful payments reached
 * through the children's invoices. This runs the apps' own loaders, signed in as the seeded parent and student, and compares what they
 * list with the payments the school admin can read for the same learners: the same payments, newest first, and nobody else's.
 *
 * The query used to start from every payment of every school (8 s, cut off with error 57014, at a school of 1,500 learners); the speed
 * is measured in tests/load (app-calls.ts parent, the parents_once scenario) and by the index checks in supabase/rls-checks/integrity.sql.
 * This file guards what the screen shows.
 */

let admin: SignedIn;

/** The ids of a learner's successful payments, newest first, as the school admin reads them (many learners would use a smaller query). */
async function paymentsOf(studentId: string): Promise<string[]> {
  const invoices = await admin.client.from("fee_invoices").select("id").eq("student_id", studentId);
  expect(invoices.error).toBeNull();
  const ids = (invoices.data ?? []).map((i) => i.id as string);
  if (!ids.length) return [];
  const rows = await admin.client.from("payments").select("id, completed_at").in("invoice_id", ids).eq("status", "success");
  expect(rows.error).toBeNull();
  return (rows.data ?? [])
    .sort((a, b) => String(b.completed_at ?? "9999").localeCompare(String(a.completed_at ?? "9999")))
    .map((p) => p.id as string);
}

beforeAll(async () => {
  const url = assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL);
  initSupabase({ url: url.origin, anonKey: process.env.VITE_SUPABASE_ANON_KEY!, detectSessionInUrl: false });
  admin = await signInAs("school_admin");
}, 60_000);

describe("FIG-1497: the receipts a family sees", () => {
  it("the parent's home lists each child's successful payments, and only theirs", async () => {
    const login = TEST_ROLES.parent;
    const { data, error } = await supabase().auth.signInWithPassword({ email: login.email, password: login.password });
    if (error) throw new Error(`parent sign-in failed: ${error.message}`);
    const home = await loadParentData(data.user.id);
    expect(home.children.length, "the seeded parent has children").toBeGreaterThan(0);

    let listed = 0;
    for (const child of home.children) {
      const want = await paymentsOf(child.id);
      expect(child.receipts.map((r) => r.id), `${child.name}'s receipts`).toEqual(want);
      listed += want.length;
    }
    expect(listed, "the seed gives the parent's children payments to show").toBeGreaterThan(0);
  });

  it("the learner's own Fees lists their successful payments, and only theirs", async () => {
    const login = TEST_ROLES.student;
    const { data, error } = await supabase().auth.signInWithPassword({ email: login.email, password: login.password });
    if (error) throw new Error(`student sign-in failed: ${error.message}`);
    const fees = await loadStudentFeeData(data.user.id);
    expect(fees, "the seeded student has a fees view").not.toBeNull();
    const me = await admin.client.from("students").select("id").eq("profile_id", data.user.id).single();
    expect(me.error).toBeNull();
    const want = await paymentsOf(me.data!.id as string);
    expect(fees!.receipts.map((r) => r.id)).toEqual(want);
  });
});
