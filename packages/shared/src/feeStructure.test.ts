import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client: tables in memory, `eq` filters, `order` and `range` really applied, inserts,
 * updates and deletes recorded, and a 1,000-row cap per request like PostgREST's, so paging is tested for real.
 */
type Row = Record<string, unknown>;
const MAX_ROWS = 1000;
const db: { tables: Record<string, Row[]>; error: Record<string, string>; rpc: { data: unknown; error: string | null } } = {
  tables: {}, error: {}, rpc: { data: null, error: null },
};
const calls: { inserts: { table: string; row: Row }[]; updates: { table: string; patch: Row; filters: [string, unknown][] }[]; deletes: { table: string; filters: [string, unknown][] }[]; rpc: { name: string; args: Row }[] } = {
  inserts: [], updates: [], deletes: [], rpc: [],
};

function builder(table: string) {
  const filters: [string, unknown][] = [];
  let sortCol: string | null = null;
  let window: [number, number] | null = null;
  let op: { kind: "select" } | { kind: "insert"; row: Row } | { kind: "update"; patch: Row } | { kind: "delete" } = { kind: "select" };
  const rows = () => {
    let out = (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    if (sortCol) { const c = sortCol; out = [...out].sort((a, b) => String(a[c]).localeCompare(String(b[c]))); }
    if (window) out = out.slice(window[0], window[1] + 1);
    return out.slice(0, MAX_ROWS);
  };
  const settle = () => {
    if (db.error[table]) return { data: null, error: { message: db.error[table] } };
    if (op.kind === "insert") { calls.inserts.push({ table, row: op.row }); return { data: null, error: null }; }
    if (op.kind === "update") { calls.updates.push({ table, patch: op.patch, filters: [...filters] }); return { data: null, error: null }; }
    if (op.kind === "delete") { calls.deletes.push({ table, filters: [...filters] }); return { data: null, error: null }; }
    return { data: rows(), error: null };
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => resolve(settle());
      if (method === "maybeSingle") return () => {
        const a = settle();
        return Promise.resolve(a.error ? a : { data: (a.data as Row[])[0] ?? null, error: null });
      };
      return (...args: unknown[]) => {
        if (method === "eq") filters.push([String(args[0]), args[1]]);
        if (method === "order") sortCol = String(args[0]);
        if (method === "range") window = [Number(args[0]), Number(args[1])];
        if (method === "insert") op = { kind: "insert", row: args[0] as Row };
        if (method === "update") op = { kind: "update", patch: args[0] as Row };
        if (method === "delete") op = { kind: "delete" };
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => builder(table),
    rpc: (name: string, args: Row) => {
      calls.rpc.push({ name, args });
      return Promise.resolve(db.rpc.error ? { data: null, error: { message: db.rpc.error } } : { data: db.rpc.data, error: null });
    },
  }),
}));

import {
  billTerm, createFeeItem, deleteFeeItem, fetchBillingInputs, fetchCurrentInvoiceId, fetchSchoolYearGroups, fetchTermFeeItems, updateFeeItem,
} from "./feeStructure";

beforeEach(() => {
  db.tables = {}; db.error = {}; db.rpc = { data: null, error: null };
  calls.inserts.length = 0; calls.updates.length = 0; calls.deletes.length = 0; calls.rpc.length = 0;
});

describe("reading the fee structure", () => {
  it("gives the school's distinct year groups, not one per class", async () => {
    db.tables.classes = [
      { tenant_id: "s1", level: "secondary", form_level: 2 },
      { tenant_id: "s1", level: "secondary", form_level: 2 },
      { tenant_id: "s1", level: "secondary", form_level: 1 },
      { tenant_id: "other", level: "secondary", form_level: 4 },
    ];
    const groups = await fetchSchoolYearGroups("s1");
    expect(groups.map((g) => g.year)).toEqual([1, 2]);
  });

  it("gives the term's fee items by name", async () => {
    db.tables.fee_items = [
      { id: "b", term_id: "t1", name: "Tuition" }, { id: "a", term_id: "t1", name: "Boarding" }, { id: "x", term_id: "t2", name: "Activity" },
    ];
    expect((await fetchTermFeeItems("t1")).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("throws when a read fails, rather than answering with an empty structure", async () => {
    db.error.fee_items = "permission denied";
    await expect(fetchTermFeeItems("t1")).rejects.toThrow("permission denied");
    db.error.classes = "timeout";
    await expect(fetchSchoolYearGroups("s1")).rejects.toThrow("timeout");
  });
});

describe("changing fee items", () => {
  it("writes a year group's item with its year and level, and a school-wide item with neither", async () => {
    await createFeeItem({ tenantId: "s1", termId: "t1", name: "Trip", amountCents: 50_000, appliesTo: "form_level", yearGroup: { level: "secondary", year: 3 } });
    await createFeeItem({ tenantId: "s1", termId: "t1", name: "Tuition", amountCents: 900_000, appliesTo: "all", yearGroup: { level: "secondary", year: 3 } });
    expect(calls.inserts.map((i) => i.row)).toEqual([
      { tenant_id: "s1", term_id: "t1", name: "Trip", amount_cents: 50_000, applies_to: "form_level", form_level: 3, level: "secondary" },
      { tenant_id: "s1", term_id: "t1", name: "Tuition", amount_cents: 900_000, applies_to: "all", form_level: null, level: null },
    ]);
  });

  it("updates and deletes the one item named", async () => {
    await updateFeeItem("i1", { name: "Lunch", amountCents: 120_000 });
    await deleteFeeItem("i2");
    expect(calls.updates).toEqual([{ table: "fee_items", patch: { name: "Lunch", amount_cents: 120_000 }, filters: [["id", "i1"]] }]);
    expect(calls.deletes).toEqual([{ table: "fee_items", filters: [["id", "i2"]] }]);
  });

  it("throws when a write is refused", async () => {
    db.error.fee_items = "new row violates row-level security policy";
    await expect(deleteFeeItem("i1")).rejects.toThrow("row-level security");
    await expect(updateFeeItem("i1", { name: "x", amountCents: 1 })).rejects.toThrow("row-level security");
  });
});

describe("billing the term", () => {
  it("reads every active learner and every invoice past the first 1,000", async () => {
    db.tables.students = Array.from({ length: 1_512 }, (_, i) => ({
      id: `st${String(i).padStart(5, "0")}`, tenant_id: "s1", active: true, boarding: i % 2 === 0,
      classes: i === 0 ? null : { form_level: 2, level: "secondary" },
    }));
    db.tables.students.push({ id: "gone", tenant_id: "s1", active: false, boarding: false, classes: null });
    db.tables.fee_invoices = Array.from({ length: 1_200 }, (_, i) => ({ id: `inv${String(i).padStart(5, "0")}`, term_id: "t1", student_id: `st${String(i).padStart(5, "0")}` }));

    const { students, invoiced } = await fetchBillingInputs("s1", "t1");
    expect(students).toHaveLength(1_512);
    expect(students[0]).toEqual({ id: "st00000", boarding: true, formLevel: null, classLevel: null });
    expect(students[1]).toEqual({ id: "st00001", boarding: false, formLevel: 2, classLevel: "secondary" });
    expect(invoiced.size).toBe(1_200);
    expect(invoiced.has("st01199")).toBe(true);
  });

  it("sends the plan to bill_term and reports what the database saved", async () => {
    db.rpc.data = { created: 2, total_cents: 300_000, already_billed: 1 };
    const result = await billTerm({ termId: "t1", dueOn: "2026-11-20", invoices: [{ student_id: "a", total_cents: 100_000 }, { student_id: "b", total_cents: 200_000 }] });
    expect(calls.rpc).toEqual([{ name: "bill_term", args: { p_term_id: "t1", p_due_on: "2026-11-20", p_invoices: [{ student_id: "a", total_cents: 100_000 }, { student_id: "b", total_cents: 200_000 }] } }]);
    expect(result).toEqual({ created: 2, totalCents: 300_000, alreadyBilled: 1 });
  });

  it("throws when bill_term fails, so the dialog can offer to try again", async () => {
    db.rpc.error = "term is closed";
    await expect(billTerm({ termId: "t1", dueOn: "2026-11-20", invoices: [] })).rejects.toThrow("term is closed");
  });
});

describe("a learner's invoice for the current term", () => {
  it("finds it through the current term", async () => {
    db.tables.terms = [{ id: "old", is_current: false }, { id: "now", is_current: true }];
    db.tables.fee_invoices = [{ id: "inv-old", student_id: "a", term_id: "old" }, { id: "inv-now", student_id: "a", term_id: "now" }];
    expect(await fetchCurrentInvoiceId("a")).toBe("inv-now");
  });

  it("is null with no current term or no invoice", async () => {
    db.tables.terms = [];
    expect(await fetchCurrentInvoiceId("a")).toBeNull();
    db.tables.terms = [{ id: "now", is_current: true }];
    db.tables.fee_invoices = [];
    expect(await fetchCurrentInvoiceId("a")).toBeNull();
  });
});
