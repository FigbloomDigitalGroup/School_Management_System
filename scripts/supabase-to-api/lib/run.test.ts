import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "./api.mjs";
import { openLedger } from "./ledger.mjs";
import { buildPlan } from "./mapping.mjs";
import { applySchool } from "./run.mjs";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-23T09:00:00Z");

const snapshot = {
  organizations: [{ id: "org-src", name: "Alliance Group" }],
  tenants: [{ id: T, slug: "alliance", name: "Alliance High School", status: "active", organization_id: "org-src", county: "Kiambu", level: "secondary", institution_type: "k12", timezone: "Africa/Nairobi" }],
  terms: [{ id: "t1", tenant_id: T, name: "Term 1", year: 2026, index: 1, starts_on: "2026-01-05", ends_on: "2026-04-03", is_current: true }],
  classes: [{ id: "c1", tenant_id: T, name: "Form 1", form_level: 1, level: "secondary", class_teacher_id: "p-teacher" }],
  profiles: [
    { id: "p-admin", tenant_id: T, role: "school_admin", full_name: "Amina Principal", email: "head@alliance.test" },
    { id: "p-teacher", tenant_id: T, role: "teacher", full_name: "Tom Teacher" },
    { id: "p-parent", tenant_id: T, role: "parent", full_name: "Mary Parent", email: "mary@example.com" },
  ],
  students: [
    { id: "s1", tenant_id: T, admission_no: "A-001", full_name: "Ann One", gender: "female", boarding: false, active: true, class_id: "c1" },
    { id: "s2", tenant_id: T, admission_no: "A-002", full_name: "Ben Two", gender: "male", boarding: false, active: false, class_id: "c1" },
  ],
  guardians: [
    { id: "g1", tenant_id: T, profile_id: "p-parent", student_id: "s1", relationship: "mother", is_primary_payer: true },
    { id: "g2", tenant_id: T, profile_id: "p-parent", student_id: "s2", relationship: "mother", is_primary_payer: false },
  ],
};
const planFor = () => buildPlan(snapshot, { now: NOW }).schools[0];

type Sent = { method: string; path: string; body: any; headers: Record<string, string> };

/** A stand-in for apps/api: answers each endpoint the loader calls and remembers every request. */
function fakeApi(opts: { existing?: Record<string, unknown[]>; failLearner?: string; schoolConflict?: boolean } = {}) {
  const sent: Sent[] = [];
  let n = 0;
  const id = () => `id-${(n += 1)}`;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    const path = new URL(url).pathname.replace(/^\/v1\/tenants\/[^/]+/, "/T");
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, path, body, headers: init.headers });
    if (path === "/v1/auth/login/email") return reply(200, { token: "tok", user: {} });
    if (path === "/v1/auth/mfa/status") return reply(200, { required: false });
    if (path === "/v1/auth/reauth") return reply(200, { ok: true });
    if (path === "/v1/platform/schools") {
      if (opts.schoolConflict) return reply(409, { error: { code: "conflict", message: "slug taken" } });
      return reply(201, { school: { tenant_id: "tenant-1", organization_id: "org-1" }, invitation: { token: "SECRET-TOKEN", expires_at: "2026-11-26T00:00:00Z" } });
    }
    if (init.method === "GET") {
      const key = Object.keys(opts.existing ?? {}).find((k) => path.endsWith(`/${k}`) || path.endsWith(`/${k.replace("_", "-")}`));
      const rows = key ? opts.existing![key] : [];
      return reply(200, { [key ?? "items"]: rows, page: { next_cursor: null } });
    }
    if (init.method === "PATCH") return reply(200, {});
    if (path.endsWith("/archive")) return reply(200, {});
    if (path === "/T/academic-years") return reply(201, { academic_year: { id: id() } });
    if (path === "/T/academic-terms") return reply(201, { term: { id: id() } });
    if (path === "/T/staff") return reply(201, { staff: { id: id() } });
    if (path === "/T/classes") return reply(201, { school_class: { id: id() } });
    if (path === "/T/learners") {
      if (body.admission_no === opts.failLearner) return reply(409, { error: { code: "conflict", message: "taken" } });
      return reply(201, { learner: { id: id() } });
    }
    if (path === "/T/class-memberships") return reply(201, { membership: { id: id() } });
    if (path === "/T/guardians") return reply(201, { guardian: { id: id(), links: [{ id: id() }] } });
    if (/^\/T\/guardians\/[^/]+\/links$/.test(path)) return reply(201, { link: { id: id() } });
    return reply(404, { error: { code: "not_found", message: path } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "supabase-to-api-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(fake: ReturnType<typeof fakeApi>, extra: Record<string, unknown> = {}) {
  const api = createApi({ baseUrl: "http://x", fetchImpl: fake.fetchImpl, sleep: async () => {} });
  await api.signIn({ email: "root@x.co", password: "pw" });
  const ledger = openLedger(join(dir, "ledger.jsonl"));
  const logs: string[] = [];
  const result = await applySchool({ api, ledger, secretsFile: join(dir, "invitations.jsonl"), log: (m: string) => logs.push(m), ...extra }, planFor());
  return { result, ledger, logs };
}

const posts = (fake: ReturnType<typeof fakeApi>) => fake.sent.filter((s) => s.method === "POST" && s.path !== "/v1/auth/login/email" && s.path !== "/v1/auth/reauth");

describe("applySchool", () => {
  it("goes in the order the API needs, archiving only at the very end", async () => {
    const fake = fakeApi();
    const { result } = await run(fake);
    expect(result.failures).toEqual([]);
    const order: string[] = [];
    for (const s of fake.sent) {
      const p = s.path.replace(/\/id-\d+/g, "/:id");
      if (!order.includes(`${s.method} ${p}`) && !p.startsWith("/v1/auth")) order.push(`${s.method} ${p}`);
    }
    const nonGet = order.filter((o) => !o.startsWith("GET "));
    expect(nonGet).toEqual([
      "POST /v1/platform/schools",
      "PATCH /T/school-profile",
      "POST /T/academic-years",
      "POST /T/academic-terms",
      "POST /T/staff",
      "POST /T/classes",
      "POST /T/learners",
      "POST /T/class-memberships",
      "POST /T/guardians",
      "POST /T/guardians/:id/links",
      "POST /T/learners/:id/archive",
    ]);
  });

  it("puts the class teacher's staff id and the year on the class, and the learner and class on the placement", async () => {
    const fake = fakeApi();
    await run(fake);
    const klass = fake.sent.find((s) => s.method === "POST" && s.path === "/T/classes")!;
    expect(klass.body).toMatchObject({ name: "Form 1", education_level: "secondary" });
    expect(klass.body.class_teacher_staff_id).toMatch(/^id-/);
    expect(klass.body.academic_year_id).toMatch(/^id-/);
    const placement = fake.sent.find((s) => s.method === "POST" && s.path === "/T/class-memberships")!;
    expect(placement.body.learner_id).toMatch(/^id-/);
    expect(placement.body.class_id).toMatch(/^id-/);
  });

  it("sends a deterministic idempotency key with every create", async () => {
    const fake = fakeApi();
    await run(fake);
    const learner = fake.sent.find((s) => s.method === "POST" && s.path === "/T/learners")!;
    expect(learner.headers["idempotency-key"]).toBe("mig:learner:s1");
    for (const s of posts(fake).filter((p) => p.path !== "/v1/platform/schools" && !p.path.endsWith("/archive"))) {
      expect(s.headers["idempotency-key"], s.path).toMatch(/^mig:/);
    }
  });

  it("makes no create at all the second time, because the ledger remembers", async () => {
    const first = fakeApi();
    await run(first);
    const second = fakeApi();
    const { result } = await run(second);
    expect(posts(second)).toEqual([]);
    expect(result.stats.learners).toMatchObject({ created: 0, skipped: 2 });
    expect(result.failures).toEqual([]);
  });

  it("writes the first administrator's invitation token to the secrets file and never to the log", async () => {
    const fake = fakeApi();
    const { logs } = await run(fake);
    const line = JSON.parse(readFileSync(join(dir, "invitations.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ slug: "alliance", email: "head@alliance.test", token: "SECRET-TOKEN" });
    expect(logs.join("\n")).not.toContain("SECRET-TOKEN");
  });

  it("keeps going when one learner is refused, and links only the learners that exist", async () => {
    const fake = fakeApi({ failLearner: "A-002" });
    const { result } = await run(fake);
    expect(result.stats.learners).toMatchObject({ created: 1, failed: 1 });
    expect(result.stats.class_placements).toMatchObject({ created: 1, parentFailed: 1 });
    expect(result.stats.guardians.created).toBe(1);
    expect(result.stats.guardian_links.created).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: "learners", status: 409, code: "conflict" });
  });

  it("stops with a way forward when the school is already in the API", async () => {
    const fake = fakeApi({ schoolConflict: true });
    await expect(run(fake)).rejects.toThrow(/--adopt alliance=/);
  });

  it("copies into an adopted school, and matches learners already there instead of creating them again", async () => {
    const fake = fakeApi({ existing: { learners: [{ id: "L1", admission_no: "A-001" }, { id: "L2", admission_no: "a-002 " }] } });
    const { result } = await run(fake, { adopt: { alliance: "tenant-9" } });
    expect(fake.sent.some((s) => s.path === "/v1/platform/schools")).toBe(false);
    expect(fake.sent.some((s) => s.method === "POST" && s.path === "/T/learners")).toBe(false);
    expect(result.stats.learners).toMatchObject({ created: 0, adopted: 2 });
    expect(fake.sent.filter((s) => s.path === "/T/class-memberships").map((s) => s.body.learner_id).sort()).toEqual(["L1", "L2"]);
  });

  it("refuses to run on when the API already holds staff the ledger does not know, rather than copy them", async () => {
    const fake = fakeApi({ existing: { staff: [{ id: "someone" }] } });
    await expect(run(fake, { adopt: { alliance: "tenant-9" } })).rejects.toThrow(/already holds 1 staff/);
    expect(fake.sent.some((s) => s.path === "/T/staff" && s.method === "POST")).toBe(false);
  });

  it("does nothing for a school whose own record is blocked", async () => {
    const blocked = buildPlan({ ...snapshot, profiles: snapshot.profiles.filter((p) => p.role !== "school_admin") }, { now: NOW }).schools[0];
    const fake = fakeApi();
    const api = createApi({ baseUrl: "http://x", fetchImpl: fake.fetchImpl, sleep: async () => {} });
    const out = await applySchool({ api, ledger: openLedger(join(dir, "l2.jsonl")) }, blocked);
    expect(out.stopped).toMatch(/blocked/);
    expect(fake.sent).toEqual([]);
  });
});
