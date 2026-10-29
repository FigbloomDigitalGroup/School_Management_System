import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import { loadParentData, type ChildInfo } from "../../packages/shared/src/parentData";
import { TEST_ROLES, signInAs, type SignedIn } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 07 (FIG-1240): is the balance a parent sees (web Fees, mobile Pay and Fees) the one stored for THIS term's invoice?
 *
 * This runs the app's own loader, loadParentData(), signed in as the seeded parent of the first demo school. A throwaway learner
 * (admission number QA07-...) is linked to that parent and billed for this term (3,000,000 cents) and for an older term
 * (5,000,000 cents, with a late payment of 1,000,000 on it). Everything is removed in afterAll; the one audit event record_payment
 * writes stays (a school admin cannot delete audit events).
 *
 * The loader reads EVERY invoice of the parent's children (no term filter, no ordering) and keeps the last row it is handed per
 * child. The older term's invoice gets a term id that sorts after any real one, so it is last whichever way the database walks the
 * table (heap order, which a payment changes, or the (student, term) index, which sorts by term id).
 * The known defect is written as the behaviour we want and uses it.fails: it passes while the defect exists, and fails the day
 * it is fixed. Then change it.fails to it.
 */

const run = Date.now().toString(16).slice(-8);
let admin: SignedIn;
let parentId = "";
let tenantId = "";
let studentId = "";
let currentTermId = "";
let currentInvoiceId = "";
// sorts after any random uuid, and unique per run
const OLD_TERM_ID = `ffffffff-ffff-4fff-8fff-0000${run}`;

const childOf = async (): Promise<ChildInfo> => {
  const data = await loadParentData(parentId);
  const child = data.children.find((c) => c.id === studentId);
  if (!child) throw new Error("the throwaway learner is not among the parent's children");
  return child;
};

beforeAll(async () => {
  const url = assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL);
  initSupabase({ url: url.origin, anonKey: process.env.VITE_SUPABASE_ANON_KEY!, detectSessionInUrl: false });
  const login = TEST_ROLES.parent;
  const { data, error } = await supabase().auth.signInWithPassword({ email: login.email, password: login.password });
  if (error) throw new Error(`parent sign-in failed: ${error.message}`);
  parentId = data.user.id;

  admin = await signInAs("school_admin");
  const me = await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single();
  tenantId = me.data!.tenant_id as string;
  await sweep();

  const term = await admin.client.from("terms").select("id").eq("tenant_id", tenantId).eq("is_current", true).single();
  currentTermId = term.data!.id as string;
  const cls = await admin.client.from("classes").select("id").eq("tenant_id", tenantId).order("id").limit(1).single();
  const stu = await admin.client.from("students")
    .insert({ tenant_id: tenantId, admission_no: `QA07-${run}`, full_name: "QA07 Probe Learner", boarding: false, active: true, class_id: cls.data!.id }).select("id").single();
  if (stu.error) throw new Error(`could not add the learner: ${stu.error.message}`);
  studentId = stu.data.id as string;
  const link = await admin.client.from("guardians").insert({ tenant_id: tenantId, profile_id: parentId, student_id: studentId });
  if (link.error) throw new Error(`could not link the parent: ${link.error.message}`);
  const inv = await admin.client.from("fee_invoices")
    .insert({ tenant_id: tenantId, student_id: studentId, term_id: currentTermId, total_cents: 3_000_000, due_on: "2033-12-31" }).select("id").single();
  if (inv.error) throw new Error(`could not bill this term: ${inv.error.message}`);
  currentInvoiceId = inv.data.id as string;
}, 60_000);

/** Learners can only be deleted once nothing is on file for them: invoices first (they take their payments with them), then the learner. */
async function sweep() {
  await admin.client.from("terms").delete().eq("tenant_id", tenantId).like("name", "QA07 %");
  const old = await admin.client.from("students").select("id").eq("tenant_id", tenantId).like("admission_no", "QA07-%");
  for (const s of old.data ?? []) {
    await admin.client.from("fee_invoices").delete().eq("student_id", s.id as string);
    await admin.client.from("students").delete().eq("id", s.id as string);
  }
}

afterAll(async () => {
  if (admin) await sweep();
}, 60_000);

describe("QA 07: what the parent's Fees screen is built from", () => {
  it("control: with only this term billed, the parent sees this term's invoice, billed and balance", async () => {
    const child = await childOf();
    expect(child.invoiceId).toBe(currentInvoiceId);
    expect(child.billed).toBe(3_000_000);
    expect(child.balance).toBe(3_000_000);
  });

  it.fails("FIG-1327 (open): after an older term is billed and gets a late payment, the parent still sees THIS term's invoice, and the Pay button still targets it", async () => {
    const term = await admin.client.from("terms")
      .insert({ id: OLD_TERM_ID, tenant_id: tenantId, name: `QA07 older term ${run}`, year: 2032, index: 1, starts_on: "2032-01-05", ends_on: "2032-04-02", is_current: false }).select("id").single();
    expect(term.error).toBeNull();
    const old = await admin.client.from("fee_invoices")
      .insert({ tenant_id: tenantId, student_id: studentId, term_id: OLD_TERM_ID, total_cents: 5_000_000, due_on: "2032-02-01" }).select("id").single();
    expect(old.error).toBeNull();
    const paid = await admin.client.rpc("record_payment", { p_invoice_id: old.data!.id, p_amount_cents: 1_000_000, p_method: "cash", p_reference: null });
    expect(paid.error).toBeNull();

    const child = await childOf();
    expect(child.invoiceId, "the invoice the Pay button pays").toBe(currentInvoiceId);
    expect(child.billed).toBe(3_000_000);
    expect(child.balance).toBe(3_000_000);
  });
});
