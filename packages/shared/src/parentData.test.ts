import { describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client that records every query the loader
 * builds. Any chain resolves to no rows, except the parent's one child and
 * the current term, so the loader gets as far as asking for invoices.
 */
type Call = { table: string; method: string; args: unknown[] };
const calls: Call[] = [];

function builder(table: string) {
  const answer = table === "guardians"
    ? { data: [{ students: { id: "s1", full_name: "Faith Achieng", admission_no: "A1", class_id: "c1", boarding: false, classes: { name: "Form 2", form_level: 2, level: "secondary" } } }], error: null }
    : { data: [], error: null };
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => resolve(answer);
      if (method === "maybeSingle" || method === "single") {
        return () => Promise.resolve(table === "terms" ? { data: { id: "term-now", name: "Term 3, 2026" }, error: null } : { data: null, error: null });
      }
      return (...args: unknown[]) => { calls.push({ table, method, args }); return proxy; };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  }),
}));

import { loadParentData } from "./parentData";

describe("loadParentData's invoices (FIG-1327)", () => {
  it("asks for the current term's invoice only, so an older term can never stand in for this one", async () => {
    calls.length = 0;
    await loadParentData("parent-1");
    const invoiceQuery = calls.filter((c) => c.table === "fee_invoices");
    // the select joins the term, and the filter keeps the current one: without it, once a second term is
    // billed, whichever invoice the database returns last becomes "this term" and the Pay button's target
    expect(invoiceQuery.some((c) => c.method === "select" && String(c.args[0]).includes("terms!inner"))).toBe(true);
    expect(invoiceQuery).toContainEqual({ table: "fee_invoices", method: "eq", args: ["terms.is_current", true] });
  });
});
