import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client with a few tables in memory. `eq`, `in` and `ilike` filter, `or` takes
 * PostgREST's "column.ilike.%text%,column.ilike.%text%" and keeps a row matching either, `order` and `limit` really
 * order and cut, so what a search asks for (this school, active learners, staff roles, what was typed) decides what it finds.
 */
type Row = Record<string, unknown>;
const db: { tables: Record<string, Row[]>; error: Record<string, string> } = { tables: {}, error: {} };
const asked: { table: string; select: string }[] = [];

const likes = (value: unknown, pattern: string) => String(value ?? "").toLowerCase().includes(pattern.replace(/%/g, "").toLowerCase());

function builder(table: string) {
  const tests: ((r: Row) => boolean)[] = [];
  let sortBy: string | null = null;
  let cut: number | null = null;
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") {
        return (resolve: (v: unknown) => unknown) => {
          if (db.error[table]) return resolve({ data: null, error: { message: db.error[table] } });
          let rows = (db.tables[table] ?? []).filter((r) => tests.every((t) => t(r)));
          if (sortBy) { const col = sortBy; rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col]))); }
          return resolve({ data: cut === null ? rows : rows.slice(0, cut), error: null });
        };
      }
      return (...args: unknown[]) => {
        if (method === "select") asked.push({ table, select: String(args[0]) });
        if (method === "eq") tests.push((r) => r[String(args[0])] === args[1]);
        if (method === "in") tests.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (method === "ilike") tests.push((r) => likes(r[String(args[0])], String(args[1])));
        if (method === "or") {
          const parts = String(args[0]).split(",").map((p) => p.split(".ilike."));
          tests.push((r) => parts.some(([col, pattern]) => likes(r[col!], pattern!)));
        }
        if (method === "order") sortBy = String(args[0]);
        if (method === "limit") cut = Number(args[0]);
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({ supabase: () => ({ from: (table: string) => builder(table) }) }));

import { callUrl, guardianCalls, learnerLine, MIN_SEARCH_LENGTH, RELATIONSHIP_WORD, SEARCH_LIMIT, searchLearners, searchStaff, searchText, staffLine } from "./adminPeople";

const learner = (id: string, name: string, admission: string, over: Row = {}): Row => ({
  id, tenant_id: "school-1", active: true, full_name: name, admission_no: admission, boarding: false, classes: { name: "Form 1A" }, ...over,
});
const person = (id: string, name: string, role: string, over: Row = {}): Row => ({ id, tenant_id: "school-1", full_name: name, role, staff_title: null, phone: null, email: null, ...over });

beforeEach(() => {
  asked.length = 0;
  db.error = {};
  db.tables = {
    students: [
      learner("s1", "Ann Wanjiru", "1042"), learner("s2", "Annette Mwangi", "1043", { boarding: true, classes: { name: "Form 2B" } }),
      learner("s3", "Dan Otieno", "2042", { classes: null }), learner("s4", "Ann Left", "1044", { active: false }),
      learner("s5", "Ann Elsewhere", "1045", { tenant_id: "school-2" }),
    ],
    profiles: [
      person("p1", "Grace Njeri", "school_admin", { staff_title: "Principal", phone: "0712 345 678", email: "grace@school.example" }),
      person("p2", "Joan Anne", "teacher"), person("p3", "Mary Anne", "parent", { phone: "0700 000 000" }), person("p4", "Leo Anne", "student"),
      person("p5", "Sam Anne", "driver"), person("p6", "Ivy Anne", "staff", { staff_title: "  " }), person("p7", "Zed Anne", "teacher", { tenant_id: "school-2" }),
    ],
  };
});

describe("what was typed", () => {
  it("loses the characters that would cut the filter short, and the spaces around it", () => {
    expect(searchText("  Ann,(Wan)%jiru ")).toBe("Ann  Wan  jiru");
    expect(searchText("Ann")).toBe("Ann");
  });
});

describe("finding a learner", () => {
  it("asks nothing until there are two letters", async () => {
    expect(await searchLearners("school-1", "A")).toEqual([]);
    expect(await searchLearners("school-1", "  ,  ")).toEqual([]);
    expect(MIN_SEARCH_LENGTH).toBe(2);
    expect(asked).toHaveLength(0);
  });

  it("finds this school's active learners whose name or admission number contains it, by name, whatever the case", async () => {
    const byName = await searchLearners("school-1", "ann");
    expect(byName.map((l) => l.name)).toEqual(["Ann Wanjiru", "Annette Mwangi"]);
    const byNumber = await searchLearners("school-1", "042");
    expect(byNumber.map((l) => l.name)).toEqual(["Ann Wanjiru", "Dan Otieno"]);
  });

  it("gives the admission number, the class (none for a learner with no class) and whether they board", async () => {
    const found = await searchLearners("school-1", "ann");
    expect(found[1]).toEqual({ id: "s2", name: "Annette Mwangi", admissionNo: "1043", className: "Form 2B", boarding: true });
    expect((await searchLearners("school-1", "Dan"))[0]).toMatchObject({ className: null, boarding: false });
  });

  it("lists no more than twenty-five", async () => {
    db.tables.students = Array.from({ length: 40 }, (_, i) => learner(`s${i}`, `Ann ${String(i).padStart(2, "0")}`, `9${i}`));
    expect(await searchLearners("school-1", "Ann")).toHaveLength(SEARCH_LIMIT);
  });

  it("says what the database said when it cannot search", async () => {
    db.error.students = "boom";
    await expect(searchLearners("school-1", "Ann")).rejects.toThrow("boom");
  });
});

describe("finding a member of staff", () => {
  it("finds this school's admins, teachers, drivers and other staff by name, and nobody else (not a parent, not a learner, not another school's)", async () => {
    const found = await searchStaff("school-1", "anne");
    expect(found.map((p) => p.name)).toEqual(["Ivy Anne", "Joan Anne", "Sam Anne"]);
  });

  it("gives their role, title, phone and email as the school has them", async () => {
    expect(await searchStaff("school-1", "Grace")).toEqual([
      { id: "p1", name: "Grace Njeri", role: "school_admin", title: "Principal", phone: "0712 345 678", email: "grace@school.example" },
    ]);
  });

  it("asks nothing for one letter, and says what the database said when it cannot search", async () => {
    expect(await searchStaff("school-1", "G")).toEqual([]);
    db.error.profiles = "denied";
    await expect(searchStaff("school-1", "Grace")).rejects.toThrow("denied");
  });
});

describe("the lines under a name", () => {
  it("says admission number, class and whether they board", () => {
    expect(learnerLine({ admissionNo: "1042", className: "Form 1A", boarding: true })).toBe("ADM 1042 · Form 1A · Boarder");
    expect(learnerLine({ admissionNo: "1042", className: "Form 1A", boarding: false })).toBe("ADM 1042 · Form 1A · Day scholar");
    expect(learnerLine({ admissionNo: "2042", className: null, boarding: false })).toBe("ADM 2042 · Day scholar");
  });

  it("gives a member of staff's own title, else what they are", () => {
    expect(staffLine({ role: "school_admin", title: "Principal" })).toBe("Principal");
    expect(staffLine({ role: "teacher", title: null })).toBe("Teacher");
    expect(staffLine({ role: "staff", title: "   " })).toBe("Staff");
    expect(staffLine({ role: "driver", title: null })).toBe("Driver");
    expect(staffLine({ role: "school_admin", title: null })).toBe("Admin");
  });

  it("names a guardian's relationship", () => {
    expect(RELATIONSHIP_WORD).toEqual({ mother: "Mother", father: "Father", guardian: "Guardian" });
  });
});

describe("calling a number", () => {
  it("is the dialer's link in international form, from a local number, a spaced one or one already international", () => {
    expect(callUrl("0712 345 678", "KE")).toBe("tel:+254712345678");
    expect(callUrl("+254 712 345 678", "KE")).toBe("tel:+254712345678");
    expect(callUrl("254712345678", "KE")).toBe("tel:+254712345678");
    expect(callUrl("0772 123 456", "UG")).toBe("tel:+256772123456");
  });

  it("is nothing when there is no number, or too little of one to dial", () => {
    expect(callUrl(null, "KE")).toBeNull();
    expect(callUrl(undefined, "KE")).toBeNull();
    expect(callUrl("", "KE")).toBeNull();
    expect(callUrl("  n/a ", "KE")).toBeNull();
    expect(callUrl("0712", "KE")).toBeNull();
  });
});

describe("the numbers a guardian can be called on", () => {
  it("lists the main number and then the other, as the school has them written", () => {
    expect(guardianCalls({ phone: "0712 345 678", alt_phone: "0733 111 222" }, "KE")).toEqual([
      { which: "phone", number: "0712 345 678", url: "tel:+254712345678" },
      { which: "alt", number: "0733 111 222", url: "tel:+254733111222" },
    ]);
  });

  it("lists one number once, even when it is written two ways", () => {
    expect(guardianCalls({ phone: "0712 345 678", alt_phone: "+254712345678" }, "KE")).toHaveLength(1);
  });

  it("lists the other number when it is the only one, and nothing when there is none", () => {
    expect(guardianCalls({ phone: null, alt_phone: "0733 111 222" }, "KE")).toEqual([{ which: "alt", number: "0733 111 222", url: "tel:+254733111222" }]);
    expect(guardianCalls({ phone: "", alt_phone: null }, "KE")).toEqual([]);
  });
});
