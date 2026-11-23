import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "./supabase";
import {
  changeMyPassword, currentAccessToken, currentUserId, fetchHomeDestination, fetchSignInProfile, hasSession, loadMyWorkspaces,
  loadOrgSession, loadSchoolSession, onSessionChange, sendPasswordResetEmail, sessionEventOf, signInWithEmail, signOutHere,
  storedSessionUserId,
} from "./session";
import { isBannedAuthError } from "./suspended";

/** One table read: which table, which columns, which filters, and how it ended. */
interface Read {
  table: string;
  select: string;
  eq: Record<string, unknown>;
  end: "single" | "maybeSingle" | "list";
}

interface Answer { data: unknown; error?: unknown }

interface FakeOptions {
  user?: { id: string } | null;
  session?: { user: { id: string }; access_token: string } | null;
  /** Answers a table read; anything not answered reads as no row. */
  tables?: (read: Read) => Answer | undefined;
  rpc?: Record<string, Answer>;
  signIn?: Answer;
  authError?: unknown;
}

/** A stand-in Supabase client that answers as told and remembers what it was asked. */
function fake(options: FakeOptions = {}) {
  const reads: Read[] = [];
  const listeners: ((event: string, session: { user: { id: string } } | null) => void)[] = [];
  const unsubscribe = vi.fn();
  const answer = (read: Read): Answer => options.tables?.(read) ?? { data: read.end === "list" ? [] : null, error: null };

  function from(table: string) {
    const read: Read = { table, select: "", eq: {}, end: "list" };
    reads.push(read);
    const builder = {
      select(columns: string) { read.select = columns; return builder; },
      eq(column: string, value: unknown) { read.eq[column] = value; return builder; },
      order() { return builder; },
      returns() { return builder; },
      single() { read.end = "single"; return Promise.resolve(answer(read)); },
      maybeSingle() { read.end = "maybeSingle"; return Promise.resolve(answer(read)); },
      then(resolve: (a: Answer) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(answer(read)).then(resolve, reject);
      },
    };
    return builder;
  }

  const auth = {
    getUser: vi.fn(async () => ({ data: { user: options.user ?? null }, error: null })),
    getSession: vi.fn(async () => ({ data: { session: options.session ?? null }, error: null })),
    onAuthStateChange: vi.fn((listener: (typeof listeners)[number]) => {
      listeners.push(listener);
      return { data: { subscription: { unsubscribe } } };
    }),
    signOut: vi.fn(async () => ({ error: null })),
    signInWithPassword: vi.fn(async () => options.signIn ?? { data: { user: null }, error: null }),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: options.authError ?? null })),
    updateUser: vi.fn(async () => ({ data: {}, error: options.authError ?? null })),
  };
  const rpc = vi.fn(async (fn: string) => options.rpc?.[fn] ?? { data: null, error: null });

  vi.spyOn(client, "supabase").mockReturnValue({ auth, from, rpc } as unknown as ReturnType<typeof client.supabase>);
  return { auth, rpc, reads, listeners, unsubscribe, emit: (event: string, userId: string | null) => listeners.forEach((l) => l(event, userId ? { user: { id: userId } } : null)) };
}

afterEach(() => vi.restoreAllMocks());

const PROFILE = { id: "u1", role: "teacher", tenant_id: "t1", full_name: "Asha Wanjiru" };
const TENANT = { id: "t1", slug: "kijani-ridge", organization_id: null, institution_type: "k12" };

describe("sessionEventOf", () => {
  it("names the login library's events in this module's words", () => {
    expect(sessionEventOf("INITIAL_SESSION")).toBe("initial");
    expect(sessionEventOf("SIGNED_IN")).toBe("signed-in");
    expect(sessionEventOf("SIGNED_OUT")).toBe("signed-out");
    expect(sessionEventOf("TOKEN_REFRESHED")).toBe("refreshed");
    expect(sessionEventOf("USER_UPDATED")).toBe("updated");
    expect(sessionEventOf("PASSWORD_RECOVERY")).toBe("password-recovery");
  });
  it("calls anything else other", () => {
    expect(sessionEventOf("MFA_CHALLENGE_VERIFIED")).toBe("other");
    expect(sessionEventOf("")).toBe("other");
  });
});

describe("who is signed in", () => {
  it("currentUserId asks the server and answers the id, or null when nobody is signed in", async () => {
    const { auth } = fake({ user: { id: "u1" } });
    expect(await currentUserId()).toBe("u1");
    expect(auth.getUser).toHaveBeenCalledOnce();
    fake({ user: null });
    expect(await currentUserId()).toBeNull();
  });

  it("reads the login kept in the browser: its owner, its token, whether there is one", async () => {
    fake({ session: { user: { id: "u2" }, access_token: "tok" } });
    expect(await storedSessionUserId()).toBe("u2");
    expect(await currentAccessToken()).toBe("tok");
    expect(await hasSession()).toBe(true);

    fake({ session: null });
    expect(await storedSessionUserId()).toBeNull();
    expect(await currentAccessToken()).toBeNull();
    expect(await hasSession()).toBe(false);
  });
});

describe("onSessionChange", () => {
  it("reports each change with who is signed in after it", () => {
    const login = fake();
    const seen: unknown[] = [];
    onSessionChange((change) => seen.push(change));
    login.emit("SIGNED_IN", "u1");
    login.emit("PASSWORD_RECOVERY", "u1");
    login.emit("SIGNED_OUT", null);
    expect(seen).toEqual([
      { event: "signed-in", userId: "u1" },
      { event: "password-recovery", userId: "u1" },
      { event: "signed-out", userId: null },
    ]);
  });

  it("stops listening when the returned function is called", () => {
    const login = fake();
    const stop = onSessionChange(() => {});
    expect(login.unsubscribe).not.toHaveBeenCalled();
    stop();
    expect(login.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("signing in and out", () => {
  it("signInWithEmail sends the email and password and answers the person's id", async () => {
    const { auth } = fake({ signIn: { data: { user: { id: "u1" } }, error: null } });
    expect(await signInWithEmail("head@school.sc.ke", "secret-pw")).toBe("u1");
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "head@school.sc.ke", password: "secret-pw" });
  });

  it("throws the service's own answer, so a suspended account is still told apart from a wrong password", async () => {
    const banned = { name: "AuthApiError", code: "user_banned", status: 400, message: "User is banned" };
    fake({ signIn: { data: { user: null }, error: banned } });
    const thrown = await signInWithEmail("a@b.c", "x").catch((err: unknown) => err);
    expect(thrown).toBe(banned);
    expect(isBannedAuthError(thrown)).toBe(true);
  });

  it("answers null when the service sends no user and no error", async () => {
    fake({ signIn: { data: { user: null }, error: null } });
    expect(await signInWithEmail("a@b.c", "x")).toBeNull();
  });

  it("signOutHere ends this browser's login only (FIG-1340)", async () => {
    const { auth } = fake();
    await signOutHere();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("passwords", () => {
  it("sendPasswordResetEmail asks for a link that opens the given page", async () => {
    const { auth } = fake();
    await sendPasswordResetEmail("head@school.sc.ke", "https://app.example/reset-password");
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("head@school.sc.ke", { redirectTo: "https://app.example/reset-password" });
  });

  it("changeMyPassword sets the new password", async () => {
    const { auth } = fake();
    await changeMyPassword("a-new-password");
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "a-new-password" });
  });

  it("both throw when the service refuses", async () => {
    const weak = new Error("Password should be at least 8 characters.");
    fake({ authError: weak });
    await expect(sendPasswordResetEmail("a@b.c", "/r")).rejects.toBe(weak);
    await expect(changeMyPassword("short")).rejects.toBe(weak);
  });
});

describe("loadSchoolSession", () => {
  it("is null when nobody is signed in, and reads nothing", async () => {
    const login = fake({ user: null });
    expect(await loadSchoolSession("kijani-ridge")).toBeNull();
    expect(login.reads).toEqual([]);
  });

  it("reads the profile and the school at that address, and a teacher's admin areas", async () => {
    const login = fake({
      user: { id: "u1" },
      tables: (r) => r.table === "profiles" ? { data: PROFILE } : r.table === "tenants" ? { data: TENANT } : undefined,
      rpc: { my_admin_areas: { data: ["fees", "attendance"] } },
    });
    const s = await loadSchoolSession("kijani-ridge");
    expect(s).toMatchObject({ profile: PROFILE, tenant: TENANT, actingForTenant: false, actingOrganization: null, schoolSuspended: false });
    expect(s?.adminAreas.slice().sort()).toEqual(["attendance", "fees"]);
    expect(login.reads.map((r) => [r.table, r.eq, r.end])).toEqual([
      ["profiles", { id: "u1" }, "single"],
      ["tenants", { slug: "kijani-ridge" }, "maybeSingle"],
    ]);
    // the school could be read, so nobody asks whether it is suspended
    expect(login.rpc).not.toHaveBeenCalledWith("my_school_suspended");
  });

  it("gives no admin areas when that lookup fails, never more", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake({
      user: { id: "u1" },
      tables: (r) => r.table === "profiles" ? { data: PROFILE } : r.table === "tenants" ? { data: TENANT } : undefined,
      rpc: { my_admin_areas: { data: null, error: { message: "boom" } } },
    });
    expect((await loadSchoolSession("kijani-ridge"))?.adminAreas).toEqual([]);
  });

  it("asks for no admin areas for a role that cannot hold them", async () => {
    const login = fake({
      user: { id: "u1" },
      tables: (r) => r.table === "profiles" ? { data: { ...PROFILE, role: "parent" } } : r.table === "tenants" ? { data: TENANT } : undefined,
    });
    expect((await loadSchoolSession("kijani-ridge"))?.adminAreas).toEqual([]);
    expect(login.rpc).not.toHaveBeenCalledWith("my_admin_areas");
  });

  it("marks an org_admin inside one of their organization's schools, with the organization", async () => {
    const org = { id: "o1", name: "Kijani Group", slug: "kijani-group" };
    const login = fake({
      user: { id: "u9" },
      tables: (r) =>
        r.table === "profiles" ? { data: { id: "u9", role: "org_admin", tenant_id: null } }
        : r.table === "tenants" ? { data: { ...TENANT, organization_id: "o1" } }
        : r.table === "organizations" ? { data: org }
        : undefined,
    });
    const s = await loadSchoolSession("kijani-ridge");
    expect(s?.actingForTenant).toBe(true);
    expect(s?.actingOrganization).toEqual(org);
    expect(login.reads.at(-1)).toMatchObject({ table: "organizations", select: "id, name, slug", eq: { id: "o1" } });
  });

  it("says the person's own school is suspended when it cannot be read", async () => {
    fake({
      user: { id: "u1" },
      tables: (r) => r.table === "profiles" ? { data: PROFILE } : undefined,
      rpc: { my_school_suspended: { data: true } },
    });
    expect(await loadSchoolSession("kijani-ridge")).toMatchObject({ tenant: null, schoolSuspended: true });
  });

  it("reads no school outside a school's address", async () => {
    const login = fake({ user: { id: "u1" }, tables: (r) => r.table === "profiles" ? { data: { ...PROFILE, role: "super_admin", tenant_id: null } } : undefined });
    expect(await loadSchoolSession(null)).toMatchObject({ tenant: null, schoolSuspended: false, adminAreas: [] });
    expect(login.reads.map((r) => r.table)).toEqual(["profiles"]);
  });
});

describe("loadOrgSession", () => {
  it("is null when nobody is signed in", async () => {
    fake({ user: null });
    expect(await loadOrgSession("kijani-group")).toBeNull();
  });

  it("reads the profile and the organization at that address", async () => {
    const org = { id: "o1", slug: "kijani-group" };
    const login = fake({ user: { id: "u9" }, tables: (r) => r.table === "profiles" ? { data: { id: "u9" } } : r.table === "organizations" ? { data: org } : undefined });
    expect(await loadOrgSession("kijani-group")).toEqual({ profile: { id: "u9" }, organization: org });
    expect(login.reads.at(-1)).toMatchObject({ table: "organizations", eq: { slug: "kijani-group" }, end: "maybeSingle" });
  });

  it("answers no organization for one this person does not run", async () => {
    fake({ user: { id: "u9" }, tables: (r) => r.table === "profiles" ? { data: { id: "u9" } } : undefined });
    expect(await loadOrgSession("someone-else")).toEqual({ profile: { id: "u9" }, organization: null });
  });
});

describe("loadMyWorkspaces", () => {
  it("is null for anyone who is not an org_admin", async () => {
    fake({ user: { id: "u1" }, tables: (r) => r.table === "profiles" ? { data: { id: "u1", full_name: "A", role: "school_admin" } } : undefined });
    expect(await loadMyWorkspaces()).toBeNull();
    fake({ user: null });
    expect(await loadMyWorkspaces()).toBeNull();
  });

  it("gives an org_admin's name, organizations and schools", async () => {
    const orgs = [{ id: "o1", slug: "a" }, { id: "o2", slug: "b" }];
    const schools = [{ tenant_id: "t1", active_students: 10, fees_collected_cents: 500 }];
    fake({
      user: { id: "u9" },
      tables: (r) =>
        r.table === "profiles" ? { data: { id: "u9", full_name: "Grace Muthoni", role: "org_admin" } }
        : r.table === "organization_admins" ? { data: orgs.map((o) => ({ organizations: o })) }
        : r.table === "organization_tenant_summary" ? { data: schools }
        : undefined,
    });
    expect(await loadMyWorkspaces()).toEqual({ name: "Grace Muthoni", orgs, schools });
  });
});

describe("after signing in", () => {
  it("fetchSignInProfile reads the role and school, or null for an account with no profile", async () => {
    fake({ tables: (r) => r.table === "profiles" ? { data: { role: "teacher", tenant_id: "t1" } } : undefined });
    expect(await fetchSignInProfile("u1")).toEqual({ role: "teacher", tenant_id: "t1" });
    fake();
    expect(await fetchSignInProfile("u1")).toBeNull();
  });

  it("sends someone with a school to that school", async () => {
    fake({ tables: (r) => r.table === "tenants" ? { data: { slug: "kijani-ridge", institution_type: "higher_ed" } } : undefined });
    expect(await fetchHomeDestination("u1", { role: "teacher", tenant_id: "t1" }))
      .toEqual({ slug: "kijani-ridge", institutionType: "higher_ed", pickOrganization: false });
  });

  it("finds no slug for a school that cannot be read", async () => {
    fake();
    expect(await fetchHomeDestination("u1", { role: "teacher", tenant_id: "t1" })).toMatchObject({ slug: null, pickOrganization: false });
  });

  it("sends an org_admin with one organization there, and one with several to the picker", async () => {
    fake({ tables: (r) => r.table === "organization_admins" ? { data: [{ organizations: { slug: "kijani-group" } }] } : undefined });
    expect(await fetchHomeDestination("u9", { role: "org_admin", tenant_id: null })).toEqual({ slug: "kijani-group", pickOrganization: false });

    fake({ tables: (r) => r.table === "organization_admins" ? { data: [{ organizations: { slug: "a" } }, { organizations: null }, { organizations: { slug: "b" } }] } : undefined });
    expect(await fetchHomeDestination("u9", { role: "org_admin", tenant_id: null })).toEqual({ slug: null, pickOrganization: true });
  });

  it("finds nothing for someone with neither (a super_admin)", async () => {
    const login = fake();
    expect(await fetchHomeDestination("u0", { role: "super_admin", tenant_id: null })).toEqual({ slug: null, pickOrganization: false });
    expect(login.reads).toEqual([]);
  });
});
