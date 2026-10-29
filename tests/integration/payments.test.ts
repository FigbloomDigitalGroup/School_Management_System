import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { planTermBilling } from "../../packages/shared/src/fees";
import { fetchAllPages } from "../../packages/shared/src/paging";
import type { ClassLevel, FeeItem } from "../../packages/shared/src/types";
import { anonClient, signInAs, type SignedIn } from "./support/signInAs";

/**
 * QA 05 (FIG-1238), recording payments: does every shilling recorded end up correctly on the invoice, and can money be recorded
 * or changed in a way it should not be? These call the same API the admin screens call, as the seeded school admin of the first
 * demo school, against the live definitions of record_payment() and the invoice triggers (main's, with has_perm(..., 'fees')).
 *
 * Every expected amount is worked out by hand in the test, not read back from the code under test. Each test makes its own
 * invoices in a throwaway term, and afterAll deletes the terms (which cascades to their invoices, payments and fee items) and
 * the learners made for the billing run. A crashed run is swept by the next one (names start with "QA05"). The audit events that
 * record_payment writes cannot be deleted by a school admin, so a few "financial" audit rows stay in the local database.
 *
 * The billing-run tests use the app's own planTermBilling() and fetchAllPages() with the same queries as BillTermModal in
 * apps/web/src/screens/admin/FeeCollection.tsx. They do NOT click the button: if that component's queries change (for
 * instance its `.eq("active", true)`), this file will not notice. Exporting fetchBillingInputs would close that gap.
 *
 * The "known defects" block uses it.fails: it passes while the defect exists and fails when it is fixed, so the fix gets
 * noticed. Then change it.fails to it. The same gaps are KNOWN lines in supabase/rls-checks/fees.sql.
 */

type Res = { data: unknown; error: PostgrestError | null };
const run = Date.now().toString(36);
const RUN = run.toUpperCase();

let admin: SignedIn, teacher: SignedIn, parent: SignedIn, student: SignedIn, driver: SignedIn;
let kijaniAdmin: SupabaseClient;
let kijaniTenantId = "";
let tenantId = "";
let payTerm = "";
const pool: string[] = [];
const madeStudents: string[] = [];
const madeTerms: string[] = [];

interface InvoiceState { total_cents: number; paid_cents: number; status: string }
interface LedgerRow { amount_cents: number; method: string; reference: string | null; mpesa_receipt: string | null; status: string; recorded_by: string | null }

const sb = () => admin.client;
const num = (v: unknown) => Number(v);

async function makeInvoice(total: number, dueOn = "2033-12-31"): Promise<string> {
  const studentId = pool.shift();
  if (!studentId) throw new Error("ran out of learners for test invoices");
  const { data, error } = await sb().from("fee_invoices")
    .insert({ tenant_id: tenantId, student_id: studentId, term_id: payTerm, total_cents: total, due_on: dueOn }).select("id").single();
  if (error) throw new Error(`could not make a test invoice: ${error.message}`);
  return data.id as string;
}

async function state(id: string): Promise<InvoiceState> {
  const { data, error } = await sb().from("fee_invoices").select("total_cents, paid_cents, status").eq("id", id).single();
  if (error) throw new Error(error.message);
  return { total_cents: num(data.total_cents), paid_cents: num(data.paid_cents), status: data.status as string };
}

async function ledger(id: string): Promise<LedgerRow[]> {
  const { data, error } = await sb().from("payments")
    .select("amount_cents, method, reference, mpesa_receipt, status, recorded_by").eq("invoice_id", id).order("amount_cents");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, amount_cents: num(r.amount_cents) })) as LedgerRow[];
}

/** The same call the "Record payment" form makes. */
function pay(id: string, cents: unknown, method = "cash", reference: string | null = null, as: SupabaseClient = sb()): PromiseLike<Res> {
  return as.rpc("record_payment", { p_invoice_id: id, p_amount_cents: cents, p_method: method, p_reference: reference });
}

const auditCount = async () => {
  const { count } = await sb().from("audit_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  return count ?? 0;
};

/** Money that was received must equal what the invoice shows paid, and never exceed the total. */
async function expectLedgerReconciles(id: string) {
  const inv = await state(id);
  const sum = (await ledger(id)).filter((p) => p.status === "success").reduce((a, p) => a + p.amount_cents, 0);
  expect(sum, "payments received vs paid_cents").toBe(inv.paid_cents);
  expect(inv.paid_cents).toBeLessThanOrEqual(inv.total_cents);
}

async function sweepLeftovers() {
  await sb().from("terms").delete().eq("tenant_id", tenantId).like("name", "QA05 %");
  await sb().from("students").delete().eq("tenant_id", tenantId).like("admission_no", "QA05-%");
}

async function makeTerm(label: string, index: number): Promise<string> {
  const { data, error } = await sb().from("terms")
    .insert({ tenant_id: tenantId, name: `QA05 ${label} ${run}`, year: 2033, index, starts_on: "2033-01-05", ends_on: "2033-04-02", is_current: false })
    .select("id").single();
  if (error) throw new Error(`could not make a test term: ${error.message}`);
  madeTerms.push(data.id as string);
  return data.id as string;
}

beforeAll(async () => {
  [admin, teacher, parent, student, driver] = await Promise.all(
    (["school_admin", "teacher", "parent", "student", "driver"] as const).map((r) => signInAs(r)),
  );
  kijaniAdmin = anonClient();
  const k = await kijaniAdmin.auth.signInWithPassword({ email: "head@kijaniridge.sc.ke", password: "figbloom-dev" });
  if (k.error) throw new Error(`Kijani Ridge admin could not sign in (npm run db:seed-org?): ${k.error.message}`);
  const kp = await kijaniAdmin.from("profiles").select("tenant_id").eq("id", k.data.user.id).single();
  kijaniTenantId = kp.data!.tenant_id as string;

  const me = await sb().from("profiles").select("tenant_id").eq("id", admin.userId).single();
  tenantId = me.data!.tenant_id as string;
  await sweepLeftovers();
  payTerm = await makeTerm("pay", 1);
  const { data } = await sb().from("students").select("id").eq("tenant_id", tenantId).eq("active", true).order("id").limit(80);
  pool.push(...(data ?? []).map((s) => s.id as string));
}, 60_000);

afterAll(async () => {
  if (madeTerms.length) await sb().from("terms").delete().in("id", madeTerms);
  if (madeStudents.length) await sb().from("students").delete().in("id", madeStudents);
}, 60_000);

describe("setup", () => {
  it("has a school, a throwaway term and learners to invoice", () => {
    expect(tenantId).not.toBe("");
    expect(payTerm).not.toBe("");
    expect(pool.length).toBeGreaterThanOrEqual(60);
  });
});

describe("record_payment: amounts, against numbers worked out by hand", () => {
  it("partial then exact moves unpaid -> part_paid -> paid", async () => {
    const id = await makeInvoice(1_000_000);
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 0, status: "unpaid" });
    expect((await pay(id, 400_000)).error).toBeNull();
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 400_000, status: "part_paid" });
    expect((await pay(id, 600_000, "bank", "SLIP-1")).error).toBeNull();
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid" });
    await expectLedgerReconciles(id);
  });

  it("a part-paid invoice past its due date reads overdue, and the last payment still makes it paid", async () => {
    const id = await makeInvoice(1_000_000, "2020-01-01");
    expect((await pay(id, 250_000)).error).toBeNull();
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 250_000, status: "overdue" });
    expect((await pay(id, 750_000)).error).toBeNull();
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid" });
  });

  it("one cent paid is a real payment", async () => {
    const id = await makeInvoice(1_000_000);
    expect((await pay(id, 1)).error).toBeNull();
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1, status: "part_paid" });
  });

  it.each([[0], [-500], [null]])("refuses %s as the amount (22023) and changes nothing", async (amount) => {
    const id = await makeInvoice(1_000_000);
    const res = await pay(id, amount);
    expect(res.error?.code).toBe("22023");
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 0, status: "unpaid" });
    expect(await ledger(id)).toEqual([]);
  });

  it.each([["one cent over", 1_000_001], ["the largest bigint", "9223372036854775807"]])("refuses %s the balance (22023)", async (_label, amount) => {
    const id = await makeInvoice(1_000_000);
    expect((await pay(id, amount)).error?.code).toBe("22023");
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 0, status: "unpaid" });
  });

  it("refuses an amount above what is still owed after a part payment, and a payment on a paid invoice", async () => {
    const id = await makeInvoice(1_000_000);
    await pay(id, 700_000);
    expect((await pay(id, 300_001)).error?.code).toBe("22023");
    expect((await pay(id, 300_000)).error).toBeNull();
    expect((await pay(id, 1)).error?.code).toBe("22023");
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid" });
    await expectLedgerReconciles(id);
  });

  it.each([[100.5], ["100.5"], ["abc"], ["1e2"]])("refuses an amount that is not whole cents: %s", async (amount) => {
    const id = await makeInvoice(1_000_000);
    const res = await pay(id, amount);
    expect(res.error, "must be refused").not.toBeNull();
    expect(res.error!.code).toBe("22P02");
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 0, status: "unpaid" });
    expect(await ledger(id)).toEqual([]);
  });
});

describe("record_payment: methods", () => {
  it("cash, M-Pesa, bank and cheque add up to the invoice and are stored as recorded", async () => {
    const id = await makeInvoice(1_000_000);
    const code = `mp${run}`;
    expect((await pay(id, 100_000, "cash", "   ")).error).toBeNull();
    expect((await pay(id, 200_000, "mpesa", code)).error).toBeNull();
    expect((await pay(id, 300_000, "bank", "BNK-1")).error).toBeNull();
    expect((await pay(id, 400_000, "cheque", "CHQ-1")).error).toBeNull();
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid" });
    expect((await ledger(id)).map((p) => [p.method, p.amount_cents, p.reference, p.mpesa_receipt, p.status, p.recorded_by])).toEqual([
      ["cash", 100_000, null, null, "success", admin.userId],
      ["mpesa", 200_000, `MP${RUN}`, `MP${RUN}`, "success", admin.userId],
      ["bank", 300_000, "BNK-1", null, "success", admin.userId],
      ["cheque", 400_000, "CHQ-1", null, "success", admin.userId],
    ]);
    await expectLedgerReconciles(id);
  });

  it.each([["mpesa"], ["bank"], ["cheque"]])("%s needs a receipt, slip or cheque number", async (method) => {
    const id = await makeInvoice(1_000_000);
    expect((await pay(id, 1000, method, null)).error?.code).toBe("22023");
    expect((await pay(id, 1000, method, "   ")).error?.code).toBe("22023");
    expect((await state(id)).paid_cents).toBe(0);
  });

  it("an M-Pesa code can be used once, in any letter case, on any invoice", async () => {
    const a = await makeInvoice(1_000_000);
    const b = await makeInvoice(1_000_000);
    const code = `dup${run}`;
    expect((await pay(a, 1000, "mpesa", code)).error).toBeNull();
    expect((await pay(a, 1000, "mpesa", code.toUpperCase())).error?.code).toBe("23505");
    expect((await pay(b, 1000, "mpesa", ` ${code} `)).error?.code).toBe("23505");
    expect((await state(a)).paid_cents).toBe(1000);
    expect((await state(b)).paid_cents).toBe(0);
  });

  it("every recorded payment leaves exactly one financial audit event naming the invoice and amount", async () => {
    const id = await makeInvoice(1_000_000);
    await pay(id, 111_000);
    await pay(id, 222_000, "bank", "AUD-1");
    const { data } = await sb().from("audit_events").select("category, actor_id, metadata").contains("metadata", { invoice_id: id });
    expect((data ?? []).map((e) => [e.category, e.actor_id, num((e.metadata as { amount_cents: number }).amount_cents)]).sort())
      .toEqual([["financial", admin.userId, 111_000], ["financial", admin.userId, 222_000]]);
  });
});

describe("record_payment: who may record", () => {
  let id = "";
  beforeAll(async () => { id = await makeInvoice(1_000_000); });

  it.each([["teacher"], ["parent"], ["student"], ["driver"]] as const)("a %s is refused (42501) and nothing moves", async (who) => {
    const client = { teacher, parent, student, driver }[who].client;
    const res = await pay(id, 1000, "cash", null, client);
    expect(res.error?.code).toBe("42501");
    expect(res.error?.message).toBe("That invoice could not be found.");
  });

  it("the admin of ANOTHER school is refused with the same answer as for a missing invoice", async () => {
    const res = await pay(id, 1000, "cash", null, kijaniAdmin);
    expect(res.error?.code).toBe("42501");
    expect(res.error?.message).toBe("That invoice could not be found.");
    const missing = await pay("00000000-0000-0000-0000-000000000000", 1000, "cash", null, kijaniAdmin);
    expect(missing.error?.message).toBe(res.error?.message);
  });

  it("a visitor with no sign-in is refused", async () => {
    const res = await pay(id, 1000, "cash", null, anonClient());
    expect(res.error).not.toBeNull();
  });

  it("none of those moved the invoice, and the school admin still can", async () => {
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 0, status: "unpaid" });
    expect(await ledger(id)).toEqual([]);
    expect((await pay(id, 1000)).error).toBeNull();
  });
});

describe("tamper-proofing: a balance only moves with a payment behind it", () => {
  it("the admin cannot set paid_cents or status on an invoice directly", async () => {
    const id = await makeInvoice(1_000_000);
    const paid = await sb().from("fee_invoices").update({ paid_cents: 1_000_000 }).eq("id", id).select();
    expect(paid.error?.code).toBe("42501");
    const status = await sb().from("fee_invoices").update({ status: "paid" }).eq("id", id).select();
    expect(status.error?.code).toBe("42501");
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 0, status: "unpaid" });
  });

  it("a new invoice cannot be created already paid", async () => {
    const studentId = pool.shift()!;
    const res = await sb().from("fee_invoices")
      .insert({ tenant_id: tenantId, student_id: studentId, term_id: payTerm, total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid", due_on: "2033-12-31" }).select();
    expect(res.error?.code).toBe("42501");
  });

  it("a client cannot insert, edit or delete payment rows", async () => {
    const id = await makeInvoice(1_000_000);
    await pay(id, 300_000);
    const ins = await sb().from("payments").insert({ tenant_id: tenantId, invoice_id: id, amount_cents: 700_000, method: "cash", status: "success" }).select();
    expect(ins.error?.code).toBe("42501");
    const upd = await sb().from("payments").update({ amount_cents: 1 }).eq("invoice_id", id).select();
    expect(upd.error ? 0 : (upd.data ?? []).length).toBe(0);
    const del = await sb().from("payments").delete().eq("invoice_id", id).select();
    expect(del.error ? 0 : (del.data ?? []).length).toBe(0);
    expect((await ledger(id)).map((p) => p.amount_cents)).toEqual([300_000]);
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 300_000, status: "part_paid" });
  });
});

describe("concurrency: simultaneous record_payment() calls on one invoice", () => {
  const ok = (rs: Res[]) => rs.filter((r) => !r.error).length;
  const refused = (rs: Res[]) => rs.filter((r) => r.error?.code === "22023").length;

  it("four at once for 400,000 on 1,000,000: exactly two are taken, paid_cents is 800,000", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await makeInvoice(1_000_000);
      const rs = await Promise.all([1, 2, 3, 4].map(() => pay(id, 400_000)));
      expect(ok(rs)).toBe(2);
      expect(refused(rs)).toBe(2);
      expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 800_000, status: "part_paid" });
      expect(await ledger(id)).toHaveLength(2);
      await expectLedgerReconciles(id);
    }
  });

  it("twenty at once for 10,000: all twenty land, none is lost (200,000 paid, twenty rows)", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await makeInvoice(1_000_000);
      const rs = await Promise.all(Array.from({ length: 20 }, () => pay(id, 10_000)));
      expect(ok(rs)).toBe(20);
      expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 200_000, status: "part_paid" });
      expect(await ledger(id)).toHaveLength(20);
      await expectLedgerReconciles(id);
    }
  });

  it("two at once for the whole balance: one pays the invoice, the other is refused", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await makeInvoice(1_000_000);
      const rs = await Promise.all([pay(id, 1_000_000), pay(id, 1_000_000)]);
      expect(ok(rs)).toBe(1);
      expect(refused(rs)).toBe(1);
      expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid" });
      expect(await ledger(id)).toHaveLength(1);
    }
  });

  it("fifteen at once for 100,000: exactly ten fit, five are refused, and the invoice is paid", async () => {
    const id = await makeInvoice(1_000_000);
    const rs = await Promise.all(Array.from({ length: 15 }, () => pay(id, 100_000)));
    expect(ok(rs)).toBe(10);
    expect(refused(rs)).toBe(5);
    expect(await state(id)).toEqual({ total_cents: 1_000_000, paid_cents: 1_000_000, status: "paid" });
    await expectLedgerReconciles(id);
  });

  it("the same M-Pesa code sent twice at once is recorded once", async () => {
    const id = await makeInvoice(1_000_000);
    const code = `race${run}`;
    const rs = await Promise.all([pay(id, 5000, "mpesa", code), pay(id, 5000, "mpesa", code)]);
    expect(ok(rs)).toBe(1);
    expect(rs.find((r) => r.error)?.error?.code).toBe("23505");
    expect((await state(id)).paid_cents).toBe(5000);
  });
});

// ---------------------------------------------------------------- the billing run
// The same queries as BillTermModal (apps/web/src/screens/admin/FeeCollection.tsx), with the app's own planTermBilling().
interface StudentRow { id: string; boarding: boolean; classes: { form_level: number; level: ClassLevel } | null }

async function billingInputs(termId: string) {
  const [students, invoiced] = await Promise.all([
    fetchAllPages<StudentRow>((from, to) =>
      sb().from("students").select("id, boarding, classes(form_level, level)")
        .eq("tenant_id", tenantId).eq("active", true).order("id").range(from, to).returns<StudentRow[]>()),
    fetchAllPages<{ student_id: string }>((from, to) =>
      sb().from("fee_invoices").select("student_id").eq("term_id", termId).order("id").range(from, to)),
  ]);
  return { students, invoiced: new Set(invoiced.map((i) => i.student_id)) };
}

async function runBilling(termId: string, dueOn = "2033-01-05") {
  const [{ students, invoiced }, items] = await Promise.all([
    billingInputs(termId),
    sb().from("fee_items").select("*").eq("term_id", termId).then((r) => (r.data ?? []) as FeeItem[]),
  ]);
  const plan = planTermBilling(
    students.map((s) => ({ id: s.id, boarding: s.boarding, formLevel: s.classes?.form_level ?? null, classLevel: s.classes?.level ?? null })),
    items, invoiced,
  );
  const rows = plan.invoices.map((i) => ({ ...i, tenant_id: tenantId, term_id: termId, due_on: dueOn }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb().from("fee_invoices").upsert(rows.slice(i, i + 500), { onConflict: "student_id,term_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  return { plan, rows };
}

const invoicesOfTerm = (termId: string) =>
  fetchAllPages<{ student_id: string; total_cents: number; paid_cents: number; status: string }>((from, to) =>
    sb().from("fee_invoices").select("student_id, total_cents, paid_cents, status").eq("term_id", termId).order("id").range(from, to));

let classId = "";

/** A K-12 learner must be in a class. The fee items below name no form level, so the class does not change what they are billed. */
async function addLearner(label: string, boarding: boolean): Promise<string> {
  if (!classId) {
    const { data: c } = await sb().from("classes").select("id").eq("tenant_id", tenantId).order("id").limit(1).single();
    classId = c!.id as string;
  }
  const { data, error } = await sb().from("students")
    .insert({ tenant_id: tenantId, admission_no: `QA05-${run}-${label}`, full_name: `QA05 ${label}`, boarding, active: true, class_id: classId }).select("id").single();
  if (error) throw new Error(`could not add a learner: ${error.message}`);
  madeStudents.push(data.id as string);
  return data.id as string;
}

async function addFeeItems(termId: string) {
  const { error } = await sb().from("fee_items").insert([
    { tenant_id: tenantId, term_id: termId, name: "QA05 Tuition", amount_cents: 1_000_000, applies_to: "all" },
    { tenant_id: tenantId, term_id: termId, name: "QA05 Boarding", amount_cents: 500_000, applies_to: "boarders" },
  ]);
  if (error) throw new Error(error.message);
}

const countOf = async (client: SupabaseClient, table: string, filter: (q: any) => any) => {
  const { count, error } = await filter(client.from(table).select("id", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  return count as number;
};

describe("billing run: Fees -> Bill learners", () => {
  let term = "";
  let dayId = "", boarderId = "", archivedId = "", lateId = "";
  let active = 0, boarders = 0;
  let kijaniBefore = 0;

  beforeAll(async () => {
    term = await makeTerm("bill", 2);
    await addFeeItems(term);
    dayId = await addLearner("DAY", false);
    boarderId = await addLearner("BOARDER", true);
    archivedId = await addLearner("ARCHIVED", true);
    const archived = await sb().rpc("archive_learners", { p_ids: [archivedId] });
    if (archived.error) throw new Error(archived.error.message);
    // The expected numbers come from counting the database, not from the planner.
    active = await countOf(sb(), "students", (q) => q.eq("tenant_id", tenantId).eq("active", true));
    boarders = await countOf(sb(), "students", (q) => q.eq("tenant_id", tenantId).eq("active", true).eq("boarding", true));
    // Filter by tenant: an unfiltered count makes row-level security judge every school's invoices (about 4.5 ms each, so it
    // reaches the 8 s statement timeout once the table has ~1,800 rows) while this file has hundreds of test invoices in it.
    kijaniBefore = await countOf(kijaniAdmin, "fee_invoices", (q) => q.eq("tenant_id", kijaniTenantId));
  }, 60_000);

  it("setup: an archived learner is not active, the others are", async () => {
    const { data } = await sb().from("students").select("id, active, archived_at").in("id", [dayId, boarderId, archivedId]);
    const by = new Map((data ?? []).map((s) => [s.id as string, s]));
    expect(by.get(dayId)?.active).toBe(true);
    expect(by.get(boarderId)?.active).toBe(true);
    expect(by.get(archivedId)?.active).toBe(false);
    expect(by.get(archivedId)?.archived_at).not.toBeNull();
  });

  it("first run: one invoice per ACTIVE learner, each the exact total worked out by hand", async () => {
    const { plan } = await runBilling(term);
    expect(plan.invoices).toHaveLength(active);
    const invoices = await invoicesOfTerm(term);
    expect(invoices).toHaveLength(active);
    const of = new Map(invoices.map((i) => [i.student_id, i]));
    // tuition 1,000,000 for everyone; boarding 500,000 more for boarders; none of these learners has a class
    expect(of.get(dayId)?.total_cents).toBe(1_000_000);
    expect(of.get(boarderId)?.total_cents).toBe(1_500_000);
    expect(of.has(archivedId), "the archived learner must not be billed").toBe(false);
    expect(invoices.reduce((a, i) => a + i.total_cents, 0)).toBe(1_000_000 * active + 500_000 * boarders);
    expect(invoices.every((i) => i.paid_cents === 0 && i.status === "unpaid")).toBe(true);
  }, 60_000);

  it("the run touched only this school: the other school's invoices are unchanged", async () => {
    expect(await countOf(kijaniAdmin, "fee_invoices", (q) => q.eq("tenant_id", kijaniTenantId))).toBe(kijaniBefore);
    expect(kijaniBefore).toBeGreaterThan(0);
  });

  it("running it again creates nothing: no duplicates, no changed totals", async () => {
    const before = await invoicesOfTerm(term);
    const { plan, rows } = await runBilling(term);
    expect(rows).toEqual([]);
    expect(plan.alreadyBilled).toBe(active);
    const after = await invoicesOfTerm(term);
    expect(after).toEqual(before);
  }, 60_000);

  it("a stale plan re-sent in full (two admins, or a double click) creates nothing either", async () => {
    const before = await invoicesOfTerm(term);
    const stale = before.map((i) => ({ student_id: i.student_id, total_cents: 7, tenant_id: tenantId, term_id: term, due_on: "2033-01-05" }));
    const { error } = await sb().from("fee_invoices").upsert(stale, { onConflict: "student_id,term_id", ignoreDuplicates: true });
    expect(error).toBeNull();
    expect(await invoicesOfTerm(term)).toEqual(before);
  }, 60_000);

  it("editing a fee item afterwards does not change invoices already made", async () => {
    const up = await sb().from("fee_items").update({ amount_cents: 1_200_000 }).eq("term_id", term).eq("name", "QA05 Tuition").select("id");
    expect(up.error).toBeNull();
    const { rows } = await runBilling(term);
    expect(rows).toEqual([]);
    const of = new Map((await invoicesOfTerm(term)).map((i) => [i.student_id, i.total_cents]));
    expect(of.get(dayId)).toBe(1_000_000);
    expect(of.get(boarderId)).toBe(1_500_000);
  }, 60_000);

  it("a learner added after the first run is billed on the next, at today's items, and only that learner", async () => {
    lateId = await addLearner("LATE", false);
    const { plan, rows } = await runBilling(term);
    expect(rows.map((r) => [r.student_id, r.total_cents])).toEqual([[lateId, 1_200_000]]);
    expect(plan.alreadyBilled).toBe(active);
    const invoices = await invoicesOfTerm(term);
    expect(invoices).toHaveLength(active + 1);
    expect(invoices.find((i) => i.student_id === dayId)?.total_cents).toBe(1_000_000);
  }, 60_000);

  it("a billed invoice can be paid in full through record_payment, end to end", async () => {
    const inv = await sb().from("fee_invoices").select("id").eq("term_id", term).eq("student_id", boarderId).single();
    expect((await pay(inv.data!.id as string, 500_000, "cash")).error).toBeNull();
    expect((await pay(inv.data!.id as string, 1_000_000, "bank", `BILL-${RUN}`)).error).toBeNull();
    expect(await state(inv.data!.id as string)).toEqual({ total_cents: 1_500_000, paid_cents: 1_500_000, status: "paid" });
  });

  it("the run's audit entry is accepted for a school admin and refused for a teacher", async () => {
    const entry = { p_tenant_id: tenantId, p_event: `QA05 ${run} billed`, p_category: "financial", p_metadata: { invoices: active } };
    expect((await sb().rpc("log_admin_event", entry)).error).toBeNull();
    expect((await teacher.client.rpc("log_admin_event", entry)).error?.code).toBe("42501");
  });
});

describe("billing run: two admins press 'Bill learners' at the same moment", () => {
  it("both runs plan the same learners; the database keeps one invoice each", async () => {
    const term = await makeTerm("race", 3);
    await addFeeItems(term);
    const active = await countOf(sb(), "students", (q) => q.eq("tenant_id", tenantId).eq("active", true));
    const [a, b] = await Promise.all([runBilling(term), runBilling(term)]);
    expect(a.rows.length + b.rows.length, "both planned from an empty term").toBeGreaterThanOrEqual(active);
    const invoices = await invoicesOfTerm(term);
    expect(invoices).toHaveLength(active);
    expect(new Set(invoices.map((i) => i.student_id)).size).toBe(active);
  }, 60_000);
});

// ---------------------------------------------------------------- known defects (QA 05)
// Each of these asserts the CORRECT behaviour and currently fails, so it.fails passes. When a fix lands the test starts failing:
// then change it.fails to it.
describe("known defects (QA 05)", () => {
  it.fails("FIG-1319: deleting an invoice that has payments is refused, or at least leaves an audit event", async () => {
    const id = await makeInvoice(1_000_000);
    await pay(id, 250_000);
    const before = await auditCount();
    const del = await sb().from("fee_invoices").delete().eq("id", id).select();
    const after = await auditCount();
    expect(del.error !== null || after > before).toBe(true);
  });

  it.fails("FIG-1315: after total_cents is lowered to what is paid, the status follows the balance (paid)", async () => {
    const id = await makeInvoice(1_000_000);
    await pay(id, 400_000);
    const edit = await sb().from("fee_invoices").update({ total_cents: 400_000 }).eq("id", id).select();
    expect(edit.error).toBeNull();
    expect((await state(id)).status).toBe("paid");
  });

  it.fails("FIG-1315: a hand edit of total_cents leaves an audit event", async () => {
    const id = await makeInvoice(1_000_000);
    await pay(id, 400_000);
    const before = await auditCount();
    await sb().from("fee_invoices").update({ total_cents: 400_000 }).eq("id", id).select();
    expect(await auditCount()).toBeGreaterThan(before);
  });
});
