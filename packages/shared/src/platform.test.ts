import { afterEach, describe, expect, it, vi } from "vitest";
import * as session from "./session";
import * as client from "./supabase";
import {
  activateOrgSchool, activateTenant, approveOrganization, assignTenantOrganization, checkServices, createMyOrganization, createOrganization,
  createPlatformInvoice, createTenant, createTenantSelfService, declarePlatformIncident, deleteAccount, fetchAllTenants, fetchImpersonationLog,
  fetchOrganizationAdminProfiles, fetchOrganizationMemberSchools, fetchOrganizations, fetchPlatformAudit, fetchPlatformIncidents,
  fetchPlatformInvoices, fetchPlatformNavCounts, fetchPlatformSubscriptions, fetchPlatformTenantOverview, fetchPlatformTenantSummary,
  fetchPlatformUsage, fetchSchoolAdmins, fetchServiceHistory, fetchTakenSlugs, fetchTenantSlug, giveSchoolOwnOrganization, inviteAdmin,
  inviteOrgAdmin, inviteStaff, markPlatformInvoicePaid, provisionGuardian, provisionStudent, resolvePlatformIncident, saveNewSchoolLogo,
  signupOrganization, type NewSchoolInput,
} from "./platform";

/** One request the code made: the table (or function) and every builder call chained on it, in order. */
interface Call {
  table?: string;
  rpc?: string;
  rpcArgs?: unknown;
  ops: [string, unknown[]][];
}

interface Answer { data?: unknown; error?: unknown; count?: number | null }

/** Every `.eq("column", value)` filter on a call, as one object. */
const eqs = (call: Call) => Object.fromEntries(call.ops.filter(([op]) => op === "eq").map(([, args]) => [args[0] as string, args[1]]));
const op = (call: Call, name: string) => call.ops.find(([o]) => o === name)?.[1];
/** The builder calls on a request as plain names, in order: ["select", "eq", "order"]. */
const names = (call: Call) => call.ops.map(([o]) => o);

type Invoke = (name: string, options?: unknown) => Promise<{ data: unknown; error: unknown }>;

/**
 * A stand-in Supabase client. Any chain (`from(t).select(...).eq(...).order(...)`, `.single()`, a bare await) is
 * recorded and answered by `answer`; a request nobody answers reads as no rows and no error. Edge functions go to `invoke`.
 */
function fake(answer: (call: Call) => Answer | undefined = () => undefined, invoke: Invoke = async () => ({ data: null, error: null })) {
  const calls: Call[] = [];
  const invoked = vi.fn(invoke);

  function chain(call: Call): unknown {
    return new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: (a: Answer) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(answer(call) ?? { data: null, error: null }).then(resolve, reject);
        }
        return (...args: unknown[]) => { call.ops.push([prop, args]); return chain(call); };
      },
    });
  }

  const sb = {
    from: (table: string) => { const call: Call = { table, ops: [] }; calls.push(call); return chain(call); },
    rpc: (fn: string, args: unknown) => { const call: Call = { rpc: fn, rpcArgs: args, ops: [] }; calls.push(call); return chain(call); },
    functions: { invoke: invoked },
  };
  vi.spyOn(client, "supabase").mockReturnValue(sb as unknown as ReturnType<typeof client.supabase>);
  return { calls, invoked, on: (table: string) => calls.filter((c) => c.table === table) };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const REFUSED = Object.assign(new Error("new row violates row-level security policy"), { code: "42501" });

const SCHOOL: NewSchoolInput = {
  name: "Alliance High", slug: "alliance", county: "Kiambu", country: "KE", level: "secondary", institution_type: "k12",
  higher_ed_subtype: null, delivery_mode: "in_person", organization_id: "o1", moe_registration: "MOE-1", plan: "institution",
  accent: "#1B4D2E", licensed_seats: 1200,
};

// ---------------------------------------------------------------- edge functions

/** Every wrapper around an edge function: its name in the app, the function it calls, and the input it sends. */
const EDGE_CALLS: [string, string, (input: never) => Promise<unknown>, unknown][] = [
  ["inviteAdmin", "invite-admin", inviteAdmin, { tenant_id: "t1", full_name: "Jane", staff_title: "Principal", email: "j@x.ke" }],
  ["inviteStaff", "invite-admin", inviteStaff, { tenant_id: "t1", full_name: "Joe", role: "teacher" }],
  ["provisionGuardian", "provision-guardian", provisionGuardian, { tenant_id: "t1", full_name: "Mum", students: [{ student_id: "s1" }] }],
  ["provisionStudent", "provision-student", provisionStudent, { tenant_id: "t1", student_id: "s1" }],
  ["deleteAccount", "delete-account", deleteAccount, { tenant_id: "t1", profile_id: "p1" }],
  ["inviteOrgAdmin", "invite-org-admin", inviteOrgAdmin, { organization_id: "o1", full_name: "Grace", email: "g@x.ke" }],
  ["createMyOrganization", "create-organization", createMyOrganization, { name: "North", slug: "north", kind: "county" }],
  ["signupOrganization", "signup-organization", signupOrganization, {
    name: "North", slug: "north", kind: "county", admin_full_name: "Grace", admin_email: "g@x.ke", admin_password: "secret-123",
  }],
];

/** A non-2xx answer the way supabase-js hands it over: a generic message, and the real response on `context`. */
const nonTwoXX = (context: unknown, message = "Edge Function returned a non-2xx status code") =>
  ({ data: null, error: Object.assign(new Error(message), { context }) });

describe.each(EDGE_CALLS)("%s", (_name, fn, call, input) => {
  it(`calls ${fn} with the input as the request body and returns its answer`, async () => {
    const answer = { ok: true, login_id: "TC-0001", password: "pw" };
    const sb = fake(undefined, async () => ({ data: answer, error: null }));
    expect(await call(input as never)).toBe(answer);
    expect(sb.invoked).toHaveBeenCalledTimes(1);
    expect(sb.invoked).toHaveBeenCalledWith(fn, { body: input });
  });

  it("throws the function's own sentence when it refused with one", async () => {
    fake(undefined, async () => nonTwoXX({ json: async () => ({ error: "That email is already in use." }), status: 409 }));
    const err = await call(input as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("That email is already in use.");
    expect((err as Error).name).toBe("Error");
  });

  it("falls back to supabase-js's message when the refusal has no sentence or there is no response to read", async () => {
    const unreadable = [{ json: async () => ({}) }, { json: async () => null }, {}, undefined, { json: async () => { throw new Error(""); } }, { json: () => Promise.reject("no body") }];
    for (const context of unreadable) {
      fake(undefined, async () => nonTwoXX(context));
      await expect(call(input as never)).rejects.toThrow(new Error("Edge Function returned a non-2xx status code"));
    }
  });

  it("throws a body that is not JSON as the parse error itself (a bare gateway error): as it always did, not supabase-js's message", async () => {
    const parseError = new SyntaxError("Unexpected token <");
    fake(undefined, async () => nonTwoXX({ json: async () => { throw parseError; } }));
    await expect(call(input as never)).rejects.toBe(parseError);
  });

  it("throws the `error` an answer carries even on a 2xx", async () => {
    fake(undefined, async () => ({ data: { error: "School not found." }, error: null }));
    await expect(call(input as never)).rejects.toThrow(new Error("School not found."));
  });
});

describe("checkServices", () => {
  it("calls check-services with no request body at all and returns the results", async () => {
    const results = [{ service: "supabase", status: "ok", latency_ms: 40, detail: null }];
    const sb = fake(undefined, async () => ({ data: { results }, error: null }));
    expect(await checkServices()).toBe(results);
    expect(sb.invoked.mock.calls[0]).toEqual(["check-services"]);
  });

  it("throws the function's own sentence, as the other edge calls do", async () => {
    fake(undefined, async () => nonTwoXX({ json: async () => ({ error: "Not allowed." }) }));
    await expect(checkServices()).rejects.toThrow(new Error("Not allowed."));
  });
});

// ---------------------------------------------------------------- schools

describe("activateTenant", () => {
  it("sets that school's status to active, filtered by its id", async () => {
    const sb = fake();
    await activateTenant("t1");
    expect(sb.on("tenants")[0]!.ops).toEqual([["update", [{ status: "active" }]], ["eq", ["id", "t1"]]]);
  });

  it("throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(activateTenant("t1")).rejects.toBe(REFUSED);
  });
});

describe("createTenant", () => {
  it("inserts the school live ('active'), asks for the whole row back and returns it", async () => {
    const row = { id: "t1", ...SCHOOL, status: "active" };
    const sb = fake(() => ({ data: row }));
    expect(await createTenant(SCHOOL)).toBe(row);
    expect(sb.on("tenants")[0]!.ops).toEqual([["insert", [{ ...SCHOOL, status: "active" }]], ["select", ["*"]], ["single", []]]);
  });

  it("a status in the input never wins over 'active'", async () => {
    const sb = fake();
    await createTenant({ ...SCHOOL, status: "suspended" } as NewSchoolInput);
    expect((op(sb.on("tenants")[0]!, "insert")![0] as { status: string }).status).toBe("active");
  });

  it("throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(createTenant(SCHOOL)).rejects.toBe(REFUSED);
  });
});

describe("createTenantSelfService", () => {
  it("builds the school row itself (an organization's admin cannot read it back) and inserts it without a select", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T09:30:00.000Z"));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-2222-3333-4444-555555555555");
    const sb = fake();
    const { organization_id: _kept, ...withoutOrg } = SCHOOL;
    const row = await createTenantSelfService({ ...withoutOrg });
    expect(row).toEqual({
      id: "11111111-2222-3333-4444-555555555555", created_at: "2026-11-23T09:30:00.000Z", status: "active", logo_url: null,
      payment_paybill: null, payment_till: null, payment_bank_details: null, payment_notes: null, price_cents_override: null,
      trial_ends_at: null, renews_on: null, role_labels: {}, ...withoutOrg, organization_id: null,
    });
    expect(sb.on("tenants")[0]!.ops).toEqual([["insert", [row]]]);
  });

  it("keeps the organization it was given", async () => {
    fake();
    expect((await createTenantSelfService(SCHOOL)).organization_id).toBe("o1");
  });

  it("throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(createTenantSelfService(SCHOOL)).rejects.toBe(REFUSED);
  });
});

describe("activateOrgSchool", () => {
  it("asks org_activate_school to open that school", async () => {
    const sb = fake();
    await activateOrgSchool("t1");
    expect(sb.calls[0]).toMatchObject({ rpc: "org_activate_school", rpcArgs: { p_tenant_id: "t1" } });
  });

  it("throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(activateOrgSchool("t1")).rejects.toBe(REFUSED);
  });
});

describe("saveNewSchoolLogo", () => {
  it("saves the crest's address on that school and returns the school", async () => {
    const row = { id: "t1", logo_url: "https://x/logo.png" };
    const sb = fake(() => ({ data: row }));
    expect(await saveNewSchoolLogo("t1", "https://x/logo.png")).toBe(row);
    expect(sb.on("tenants")[0]!.ops).toEqual([
      ["update", [{ logo_url: "https://x/logo.png" }]], ["eq", ["id", "t1"]], ["select", ["*"]], ["single", []],
    ]);
  });

  it("answers null, and does not throw, when the save fails: the school exists either way", async () => {
    fake(() => ({ data: { id: "t1" }, error: REFUSED }));
    expect(await saveNewSchoolLogo("t1", "u")).toBeNull();
    fake(() => ({ data: null, error: null }));
    expect(await saveNewSchoolLogo("t1", "u")).toBeNull();
  });
});

describe("fetchTenantSlug", () => {
  it("reads the slug of that school", async () => {
    const sb = fake(() => ({ data: { slug: "alliance" } }));
    expect(await fetchTenantSlug("t1")).toBe("alliance");
    expect(sb.on("tenants")[0]!.ops).toEqual([["select", ["slug"]], ["eq", ["id", "t1"]], ["maybeSingle", []]]);
  });

  it("throws the database's own error when the read fails", async () => {
    fake(() => ({ data: null, error: REFUSED }));
    await expect(fetchTenantSlug("t1")).rejects.toBe(REFUSED);
  });

  it("throws a sentence when there is no such school", async () => {
    fake(() => ({ data: null, error: null }));
    await expect(fetchTenantSlug("t1")).rejects.toThrow(new Error("This school's address could not be found."));
  });
});

// ---------------------------------------------------------------- administrators and organizations

describe("fetchSchoolAdmins", () => {
  it("reads that school's school_admin profiles by name", async () => {
    const rows = [{ id: "p1", full_name: "Jane", email: null, staff_title: "Principal" }];
    const sb = fake(() => ({ data: rows }));
    expect(await fetchSchoolAdmins("t1")).toBe(rows);
    const call = sb.on("profiles")[0]!;
    expect(op(call, "select")).toEqual(["id, full_name, email, staff_title"]);
    expect(eqs(call)).toEqual({ tenant_id: "t1", role: "school_admin" });
    expect(op(call, "order")).toEqual(["full_name"]);
  });

  it("answers an empty list when there is nothing, and throws the database's own error", async () => {
    fake();
    expect(await fetchSchoolAdmins("t1")).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchSchoolAdmins("t1")).rejects.toBe(REFUSED);
  });
});

describe("createOrganization", () => {
  const NEW = { name: "Nakuru County", slug: "nakuru", kind: "county" as const, county: "Nakuru", contact_name: null, contact_email: null, contact_phone: null };

  it("inserts the organization with the signed-in user as its creator and returns the row", async () => {
    vi.spyOn(session, "currentUserId").mockResolvedValue("u1");
    const row = { id: "o1", ...NEW };
    const sb = fake(() => ({ data: row }));
    expect(await createOrganization(NEW)).toBe(row);
    expect(sb.on("organizations")[0]!.ops).toEqual([["insert", [{ ...NEW, created_by: "u1" }]], ["select", ["*"]], ["single", []]]);
  });

  it("records no creator when nobody is signed in", async () => {
    vi.spyOn(session, "currentUserId").mockResolvedValue(null);
    const sb = fake();
    await createOrganization(NEW);
    expect((op(sb.on("organizations")[0]!, "insert")![0] as { created_by: unknown }).created_by).toBeNull();
  });

  it("throws the database's own error", async () => {
    vi.spyOn(session, "currentUserId").mockResolvedValue("u1");
    fake(() => ({ error: REFUSED }));
    await expect(createOrganization(NEW)).rejects.toBe(REFUSED);
  });
});

describe("organizations", () => {
  it("fetchOrganizations reads them all by name, [] when none, and throws the database's own error", async () => {
    const sb = fake(() => ({ data: [{ id: "o1" }] }));
    expect(await fetchOrganizations()).toEqual([{ id: "o1" }]);
    expect(sb.on("organizations")[0]!.ops).toEqual([["select", ["*"]], ["order", ["name"]], ["returns", []]]);
    fake();
    expect(await fetchOrganizations()).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchOrganizations()).rejects.toBe(REFUSED);
  });

  it("assignTenantOrganization moves that school to that organization", async () => {
    const sb = fake();
    await assignTenantOrganization("t1", "o2");
    expect(sb.on("tenants")[0]!.ops).toEqual([["update", [{ organization_id: "o2" }]], ["eq", ["id", "t1"]]]);
    fake(() => ({ error: REFUSED }));
    await expect(assignTenantOrganization("t1", "o2")).rejects.toBe(REFUSED);
  });

  it("giveSchoolOwnOrganization asks give_school_own_organization and returns the new organization's id", async () => {
    const sb = fake(() => ({ data: "o9" }));
    expect(await giveSchoolOwnOrganization("t1")).toBe("o9");
    expect(sb.calls[0]).toMatchObject({ rpc: "give_school_own_organization", rpcArgs: { p_tenant_id: "t1" } });
    fake(() => ({ error: REFUSED }));
    await expect(giveSchoolOwnOrganization("t1")).rejects.toBe(REFUSED);
  });

  it("approveOrganization makes that organization active", async () => {
    const sb = fake();
    await approveOrganization("o1");
    expect(sb.on("organizations")[0]!.ops).toEqual([["update", [{ status: "active" }]], ["eq", ["id", "o1"]]]);
    fake(() => ({ error: REFUSED }));
    await expect(approveOrganization("o1")).rejects.toBe(REFUSED);
  });

  it("fetchOrganizationMemberSchools reads that organization's schools by name", async () => {
    const sb = fake(() => ({ data: [{ id: "t1" }] }));
    expect(await fetchOrganizationMemberSchools("o1")).toEqual([{ id: "t1" }]);
    const call = sb.on("tenants")[0]!;
    expect(eqs(call)).toEqual({ organization_id: "o1" });
    expect(names(call)).toEqual(["select", "eq", "order", "returns"]);
    expect(op(call, "order")).toEqual(["name"]);
    fake();
    expect(await fetchOrganizationMemberSchools("o1")).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchOrganizationMemberSchools("o1")).rejects.toBe(REFUSED);
  });

  it("fetchOrganizationAdminProfiles names the profile_id foreign key (two lead to profiles) and keeps only real profiles", async () => {
    const jane = { id: "p1", full_name: "Jane", email: "j@x.ke" };
    const sb = fake(() => ({ data: [{ profiles: jane }, { profiles: null }, { profiles: { id: "p2", full_name: "Grace", email: null } }] }));
    expect(await fetchOrganizationAdminProfiles("o1")).toEqual([jane, { id: "p2", full_name: "Grace", email: null }]);
    const call = sb.on("organization_admins")[0]!;
    expect(op(call, "select")).toEqual(["profiles!organization_admins_profile_id_fkey(id, full_name, email)"]);
    expect(eqs(call)).toEqual({ organization_id: "o1" });
  });

  it("fetchOrganizationAdminProfiles answers [] for nothing, and throws the database's own error (never an empty list)", async () => {
    fake();
    expect(await fetchOrganizationAdminProfiles("o1")).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchOrganizationAdminProfiles("o1")).rejects.toBe(REFUSED);
  });
});

// ---------------------------------------------------------------- web addresses

describe("fetchTakenSlugs", () => {
  it("asks tenant_slugs_taken for schools and organization_slugs_taken for organizations, and answers a set", async () => {
    const sb = fake(() => ({ data: ["alliance"] }));
    expect(await fetchTakenSlugs("school", ["alliance", "alliance-kiambu"])).toEqual(new Set(["alliance"]));
    expect(sb.calls[0]).toMatchObject({ rpc: "tenant_slugs_taken", rpcArgs: { p_slugs: ["alliance", "alliance-kiambu"] } });
    await fetchTakenSlugs("organization", ["nakuru"]);
    expect(sb.calls[1]).toMatchObject({ rpc: "organization_slugs_taken", rpcArgs: { p_slugs: ["nakuru"] } });
  });

  it("answers an empty set for no rows, and throws the database's own error", async () => {
    fake();
    expect(await fetchTakenSlugs("school", ["x"])).toEqual(new Set());
    fake(() => ({ error: REFUSED }));
    await expect(fetchTakenSlugs("school", ["x"])).rejects.toBe(REFUSED);
  });
});

// ---------------------------------------------------------------- the console's schools and figures

describe("fetchAllTenants", () => {
  it("reads every school, A to Z, and answers [] for none", async () => {
    const sb = fake(() => ({ data: [{ id: "t1" }] }));
    expect(await fetchAllTenants()).toEqual([{ id: "t1" }]);
    expect(sb.on("tenants")[0]!.ops).toEqual([["select", ["*"]], ["order", ["name", { ascending: true }]]]);
    fake();
    expect(await fetchAllTenants()).toEqual([]);
  });

  it("throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(fetchAllTenants()).rejects.toBe(REFUSED);
  });
});

describe("fetchPlatformTenantSummary", () => {
  it("reads the price list, and counts active learners across every school (no school filter)", async () => {
    const sb = fake((c) => c.table === "plan_pricing" ? { data: [{ plan: "institution", price_cents: 500000 }] } : c.table === "students" ? { count: 812 } : undefined);
    const s = await fetchPlatformTenantSummary();
    expect(s.listPrice).toEqual(new Map([["institution", 500000]]));
    expect(s.activeStudents).toBe(812);
    expect(op(sb.on("plan_pricing")[0]!, "select")).toEqual(["plan,price_cents"]);
    const students = sb.on("students")[0]!;
    expect(op(students, "select")).toEqual(["id", { count: "exact", head: true }]);
    expect(eqs(students)).toEqual({ active: true });
  });

  it("reads no count as 0 learners and no prices as an empty list", async () => {
    fake();
    expect(await fetchPlatformTenantSummary()).toEqual({ listPrice: new Map(), activeStudents: 0 });
  });

  it("throws the database's own error from either read", async () => {
    fake((c) => c.table === "plan_pricing" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformTenantSummary()).rejects.toBe(REFUSED);
    fake((c) => c.table === "students" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformTenantSummary()).rejects.toBe(REFUSED);
  });
});

describe("fetchPlatformTenantOverview", () => {
  it("counts the school's active learners, its admins and teachers, its parents, and sums what it owes", async () => {
    const sb = fake((c) => {
      if (c.table === "students") return { count: 120 };
      if (c.table === "profiles") return { count: eqs(c).role === "parent" ? 300 : 14 };
      if (c.table === "platform_invoices") return { data: [{ amount_cents: 100000, due_date: "2026-12-01" }, { amount_cents: 50000, due_date: "2027-01-10" }] };
      return undefined;
    });
    expect(await fetchPlatformTenantOverview("t1")).toEqual({ learners: 120, staff: 14, parents: 300, outstandingCents: 150000, nextDueOn: "2026-12-01" });

    for (const c of sb.calls) expect(eqs(c).tenant_id).toBe("t1");
    expect(eqs(sb.on("students")[0]!)).toMatchObject({ active: true });
    const [staff, parents] = sb.on("profiles");
    expect(op(staff!, "in")).toEqual(["role", ["school_admin", "teacher"]]);
    expect(eqs(parents!)).toMatchObject({ role: "parent" });
    const due = sb.on("platform_invoices")[0]!;
    expect(eqs(due)).toEqual({ tenant_id: "t1", status: "due" });
    expect(op(due, "order")).toEqual(["due_date"]);
    expect(op(due, "select")).toEqual(["amount_cents,due_date"]);
  });

  it("reads a school with nothing as zeros and no next due date, and never throws on a failed read", async () => {
    fake();
    expect(await fetchPlatformTenantOverview("t1")).toEqual({ learners: 0, staff: 0, parents: 0, outstandingCents: 0, nextDueOn: null });
    fake(() => ({ data: null, count: null, error: REFUSED }));
    expect(await fetchPlatformTenantOverview("t1")).toEqual({ learners: 0, staff: 0, parents: 0, outstandingCents: 0, nextDueOn: null });
  });
});

describe("fetchPlatformNavCounts", () => {
  it("counts every school, the incidents not resolved, and the invoices due", async () => {
    const sb = fake((c) => ({ count: c.table === "tenants" ? 9 : c.table === "platform_incidents" ? 2 : 5 }));
    expect(await fetchPlatformNavCounts()).toEqual({ tenants: 9, openIncidents: 2, dueInvoices: 5 });
    expect(op(sb.on("tenants")[0]!, "select")).toEqual(["id", { count: "exact", head: true }]);
    expect(names(sb.on("tenants")[0]!)).toEqual(["select"]);
    expect(op(sb.on("platform_incidents")[0]!, "neq")).toEqual(["status", "resolved"]);
    expect(eqs(sb.on("platform_invoices")[0]!)).toEqual({ status: "due" });
  });

  it("reads a missing or failed count as 0 (so no badge) and does not throw", async () => {
    fake();
    expect(await fetchPlatformNavCounts()).toEqual({ tenants: 0, openIncidents: 0, dueInvoices: 0 });
    fake(() => ({ count: null, error: REFUSED }));
    expect(await fetchPlatformNavCounts()).toEqual({ tenants: 0, openIncidents: 0, dueInvoices: 0 });
  });
});

// ---------------------------------------------------------------- health, usage, incidents

describe("fetchServiceHistory", () => {
  it("reads the last 200 checks, newest first", async () => {
    const rows = [{ id: "c1" }];
    const sb = fake(() => ({ data: rows }));
    expect(await fetchServiceHistory()).toBe(rows);
    expect(sb.on("service_status")[0]!.ops.slice(0, 3)).toEqual([["select", ["*"]], ["order", ["checked_at", { ascending: false }]], ["limit", [200]]]);
  });

  it("answers [] for none and throws the database's own error", async () => {
    fake();
    expect(await fetchServiceHistory()).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchServiceHistory()).rejects.toBe(REFUSED);
  });
});

describe("fetchPlatformUsage", () => {
  const tenants = [{ id: "t1", name: "Alliance", slug: "alliance", licensed_seats: 1000, status: "active" }, { id: "t2", name: "Mwea", slug: "mwea", licensed_seats: 50, status: "trial" }];

  it("reads each school with the learners plus staff the database counted for it", async () => {
    const sb = fake((c) => c.table === "tenants" ? { data: tenants } : c.rpc === "platform_usage_counts" ? { data: [{ tenant_id: "t1", learners: 800, staff: 60 }] } : undefined);
    expect(await fetchPlatformUsage()).toEqual([{ tenant: tenants[0], inUse: 860 }, { tenant: tenants[1], inUse: 0 }]);
    expect(op(sb.on("tenants")[0]!, "select")).toEqual(["id,name,slug,licensed_seats,status"]);
    expect(op(sb.on("tenants")[0]!, "order")).toEqual(["name"]);
    expect(sb.calls.find((c) => c.rpc)!.rpc).toBe("platform_usage_counts");
  });

  it("answers [] for no schools and throws the database's own error from either read", async () => {
    fake();
    expect(await fetchPlatformUsage()).toEqual([]);
    fake((c) => c.table === "tenants" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformUsage()).rejects.toBe(REFUSED);
    fake((c) => c.rpc ? { error: REFUSED } : undefined);
    await expect(fetchPlatformUsage()).rejects.toBe(REFUSED);
  });
});

describe("incidents", () => {
  it("fetchPlatformIncidents reads them newest first, [] for none, and throws the database's own error", async () => {
    const sb = fake(() => ({ data: [{ id: "i1" }] }));
    expect(await fetchPlatformIncidents()).toEqual([{ id: "i1" }]);
    expect(sb.on("platform_incidents")[0]!.ops.slice(0, 2)).toEqual([["select", ["*"]], ["order", ["opened_at", { ascending: false }]]]);
    fake();
    expect(await fetchPlatformIncidents()).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchPlatformIncidents()).rejects.toBe(REFUSED);
  });

  it("resolvePlatformIncident marks that incident resolved, now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
    const sb = fake();
    await resolvePlatformIncident("i1");
    expect(sb.on("platform_incidents")[0]!.ops).toEqual([["update", [{ status: "resolved", resolved_at: "2026-11-23T10:00:00.000Z" }]], ["eq", ["id", "i1"]]]);
  });

  it("resolvePlatformIncident throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(resolvePlatformIncident("i1")).rejects.toBe(REFUSED);
  });

  it("declarePlatformIncident inserts exactly the four fields it was given", async () => {
    const sb = fake();
    await declarePlatformIncident({ severity: "SEV-2", title: "Sync backlog", summary: "Rosters stale", affected_schools: 3 });
    expect(sb.on("platform_incidents")[0]!.ops).toEqual([["insert", [{ severity: "SEV-2", title: "Sync backlog", summary: "Rosters stale", affected_schools: 3 }]]]);
  });

  it("declarePlatformIncident throws the database's own error", async () => {
    fake(() => ({ error: REFUSED }));
    await expect(declarePlatformIncident({ severity: "SEV-1", title: "t", summary: "s", affected_schools: 0 })).rejects.toBe(REFUSED);
  });
});

// ---------------------------------------------------------------- subscriptions and invoices

describe("fetchPlatformSubscriptions", () => {
  const base = { slug: "s", status: "active", trial_ends_at: null, renews_on: null };

  it("prices each school at its own override, else its plan's list price, else nothing", async () => {
    const sb = fake((c) => c.table === "tenants"
      ? { data: [
        { id: "t1", name: "A", plan: "institution", price_cents_override: 300000, ...base },
        { id: "t2", name: "B", plan: "institution", price_cents_override: null, ...base },
        { id: "t3", name: "C", plan: "unknown", price_cents_override: null, ...base },
      ] }
      : c.table === "plan_pricing" ? { data: [{ plan: "institution", price_cents: 500000 }] } : undefined);
    const rows = await fetchPlatformSubscriptions();
    expect(rows.map((r) => [r.tenant.id, r.priceCents])).toEqual([["t1", 300000], ["t2", 500000], ["t3", 0]]);
    expect(op(sb.on("tenants")[0]!, "select")).toEqual(["id,name,slug,plan,status,price_cents_override,trial_ends_at,renews_on"]);
    expect(op(sb.on("tenants")[0]!, "order")).toEqual(["name"]);
    expect(op(sb.on("plan_pricing")[0]!, "select")).toEqual(["plan,price_cents"]);
  });

  it("answers [] for no schools and throws the database's own error from either read", async () => {
    fake();
    expect(await fetchPlatformSubscriptions()).toEqual([]);
    fake((c) => c.table === "tenants" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformSubscriptions()).rejects.toBe(REFUSED);
    fake((c) => c.table === "plan_pricing" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformSubscriptions()).rejects.toBe(REFUSED);
  });
});

describe("fetchPlatformInvoices", () => {
  it("reads every invoice by due date with its school's name, and the school list by name", async () => {
    const sb = fake((c) => c.table === "platform_invoices"
      ? { data: [{ id: "v1", tenant_id: "t1", amount_cents: 1000, tenants: { name: "Alliance" } }, { id: "v2", tenant_id: "t9", amount_cents: 5, tenants: null }] }
      : c.table === "tenants" ? { data: [{ id: "t1", name: "Alliance" }] } : undefined);
    const d = await fetchPlatformInvoices();
    expect(d.invoices.map((i) => [i.id, i.tenant_name])).toEqual([["v1", "Alliance"], ["v2", null]]);
    expect(d.tenants).toEqual([{ id: "t1", name: "Alliance" }]);
    expect(op(sb.on("platform_invoices")[0]!, "select")).toEqual(["*,tenants(name)"]);
    expect(op(sb.on("platform_invoices")[0]!, "order")).toEqual(["due_date"]);
    expect(op(sb.on("tenants")[0]!, "select")).toEqual(["id,name"]);
    expect(op(sb.on("tenants")[0]!, "order")).toEqual(["name"]);
  });

  it("answers empty lists for nothing and throws the database's own error from either read", async () => {
    fake();
    expect(await fetchPlatformInvoices()).toEqual({ invoices: [], tenants: [] });
    fake((c) => c.table === "platform_invoices" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformInvoices()).rejects.toBe(REFUSED);
    fake((c) => c.table === "tenants" ? { error: REFUSED } : undefined);
    await expect(fetchPlatformInvoices()).rejects.toBe(REFUSED);
  });

  it("markPlatformInvoicePaid marks that invoice paid, now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T11:00:00.000Z"));
    const sb = fake();
    await markPlatformInvoicePaid("v1");
    expect(sb.on("platform_invoices")[0]!.ops).toEqual([["update", [{ status: "paid", paid_at: "2026-11-23T11:00:00.000Z" }]], ["eq", ["id", "v1"]]]);
    fake(() => ({ error: REFUSED }));
    await expect(markPlatformInvoicePaid("v1")).rejects.toBe(REFUSED);
  });

  it("createPlatformInvoice inserts the school, amount and due date", async () => {
    const sb = fake();
    await createPlatformInvoice({ tenant_id: "t1", amount_cents: 12000000, due_date: "2026-12-31" });
    expect(sb.on("platform_invoices")[0]!.ops).toEqual([["insert", [{ tenant_id: "t1", amount_cents: 12000000, due_date: "2026-12-31" }]]]);
    fake(() => ({ error: REFUSED }));
    await expect(createPlatformInvoice({ tenant_id: "t1", amount_cents: 1, due_date: "2026-12-31" })).rejects.toBe(REFUSED);
  });
});

// ---------------------------------------------------------------- impersonation and audit

describe("fetchImpersonationLog", () => {
  it("reads the last 100 sessions, newest first, with the school and staff names", async () => {
    const sb = fake(() => ({ data: [
      { id: "m1", started_at: "2026-11-20T08:00:00Z", ended_at: null, reason: "Support", scope: "read", tenants: { name: "Alliance" }, profiles: { full_name: "Ann" } },
      { id: "m2", started_at: "2026-11-19T08:00:00Z", ended_at: "2026-11-19T08:30:00Z", reason: "Fix", scope: "write", tenants: null, profiles: null },
    ] }));
    expect(await fetchImpersonationLog()).toEqual([
      { id: "m1", started_at: "2026-11-20T08:00:00Z", ended_at: null, reason: "Support", scope: "read", tenant_name: "Alliance", staff_name: "Ann" },
      { id: "m2", started_at: "2026-11-19T08:00:00Z", ended_at: "2026-11-19T08:30:00Z", reason: "Fix", scope: "write", tenant_name: null, staff_name: null },
    ]);
    const call = sb.on("impersonation_sessions")[0]!;
    expect(op(call, "select")).toEqual(["id,started_at,ended_at,reason,scope,tenants(name),profiles(full_name)"]);
    expect(op(call, "order")).toEqual(["started_at", { ascending: false }]);
    expect(op(call, "limit")).toEqual([100]);
  });

  it("answers [] for none and throws the database's own error", async () => {
    fake();
    expect(await fetchImpersonationLog()).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchImpersonationLog()).rejects.toBe(REFUSED);
  });
});

describe("fetchPlatformAudit", () => {
  it("reads the last 200 events, newest first, with each school's name", async () => {
    const sb = fake(() => ({ data: [
      { id: "a1", created_at: "2026-11-23T07:00:00Z", actor_label: "Ann", event: "Created a school", category: "provisioning", tenants: { name: "Alliance" } },
      { id: "a2", created_at: "2026-11-23T06:00:00Z", actor_label: "System", event: "Backup", category: "operations", tenants: null },
    ] }));
    expect(await fetchPlatformAudit()).toEqual([
      { id: "a1", created_at: "2026-11-23T07:00:00Z", actor_label: "Ann", event: "Created a school", category: "provisioning", tenant_name: "Alliance" },
      { id: "a2", created_at: "2026-11-23T06:00:00Z", actor_label: "System", event: "Backup", category: "operations", tenant_name: null },
    ]);
    const call = sb.on("audit_events")[0]!;
    expect(op(call, "select")).toEqual(["id,created_at,actor_label,event,category,tenants(name)"]);
    expect(op(call, "order")).toEqual(["created_at", { ascending: false }]);
    expect(op(call, "limit")).toEqual([200]);
  });

  it("answers [] for none and throws the database's own error", async () => {
    fake();
    expect(await fetchPlatformAudit()).toEqual([]);
    fake(() => ({ error: REFUSED }));
    await expect(fetchPlatformAudit()).rejects.toBe(REFUSED);
  });
});
