import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { LOOKUP_SCHOOL_STATUSES, SCHOOL_SLUG_PATTERN } from "../src/modules/tenancy/publicSchoolLookup.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp } from "./support.js";

/**
 * Public school lookup by exact address (docs/PUBLIC-SCHOOL-LOOKUP.md), through the real figbloom_app login. Negative first:
 * a malformed address is a 400 that touches nothing; an unknown address and a school that is not open for sign-in are the
 * same 404, byte for byte, with the same audit trail; nothing a caller sends (a session, another school, a tenant header)
 * changes the answer; SQL metacharacters and wildcards are refused or harmless; the per-address limiter trips (hits and
 * misses alike, IPv6 per /64) and bounds the audit trail; the answer holds the school id and name and nothing else.
 */
const PASSWORD = "correct-horse-battery";
const PATH = "/v1/public/schools/{slug}";
const EVENT = "auth.school_lookup.missed";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type App = Ctx["app"];

describe("public school lookup", () => {
  let ctx: Ctx;
  const spec = loadSpec();
  const owner = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;
  const lookup = (slug: string, opts: { app?: App; headers?: Record<string, string>; ip?: string } = {}) =>
    (opts.app ?? ctx.app).inject({
      method: "GET",
      url: `/v1/public/schools/${slug}`,
      headers: opts.headers ?? {},
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
    });
  /** The raw body with this request's own id taken out: what must be byte-identical between two answers. */
  const rawBody = (r: LightMyRequestResponse) => r.body.split(String(r.headers["x-request-id"])).join("<request-id>");
  const sameAnswer = (r: LightMyRequestResponse) => ({
    status: r.statusCode,
    body: rawBody(r),
    "content-type": r.headers["content-type"],
    "content-length": r.headers["content-length"],
    "cache-control": r.headers["cache-control"],
    "retry-after": r.headers["retry-after"],
    "set-cookie": r.headers["set-cookie"],
  });
  // security_audit_events is append-only (even for the owner), so each test reads the events written after its own mark.
  let trailMark = "-infinity";
  const missEvents = async () =>
    (await owner(
      `SELECT tenant_id, actor_user_id, detail, host(ip) AS ip FROM security_audit_events
        WHERE event_type = $1 AND occurred_at > $2::timestamptz ORDER BY occurred_at, id`,
      [EVENT, trailMark],
    )) as Array<{ tenant_id: string | null; actor_user_id: string | null; detail: Record<string, unknown>; ip: string | null }>;
  /** Empties the lookup buckets and starts a new audit mark. */
  const clearTrail = async () => {
    await owner(`DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'school_lookup:%'`);
    trailMark = (await owner(`SELECT clock_timestamp()::text AS t`))[0].t as string;
  };
  function conforms(status: number, body: unknown) {
    let schema = responseSchema(spec, "GET", PATH, status);
    if (typeof schema === "string") {
      // 4xx answers are shared components ($ref): resolve them to their JSON schema
      const ref = spec.paths[PATH].get.responses[String(status)]?.$ref as string | undefined;
      schema = ref ? spec.components.responses[ref.split("/").pop()!]?.content?.["application/json"]?.schema : schema;
    }
    expect(typeof schema, `GET ${PATH} ${status}`).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, `${PATH} ${status}: ${errs.join("; ")}`).toEqual([]);
  }

  /** status -> { id, slug, name } for one school per status (besides the two active fixtures). */
  const byStatus: Record<string, { id: string; slug: string; name: string }> = {};
  const ALL_STATUSES = ["active", "trial", "overdue", "onboarding", "setup_stalled", "suspended"] as const;
  const CLOSED = ALL_STATUSES.filter((s) => !(LOOKUP_SCHOOL_STATUSES as readonly string[]).includes(s));

  beforeAll(async () => {
    ctx = await createTestApp();
    for (const status of ALL_STATUSES) {
      const id = randomUUID();
      const slug = `lookup-${status.replace("_", "-")}`;
      const name = `Lookup ${status} School`;
      await owner(`INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, $3, $4, $5)`, [id, ctx.ids.orgB, name, slug, status]);
      byStatus[status] = { id, slug, name };
    }
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("the statuses that are found are exactly the ones a person can sign in to (Supabase SIGN_IN_STATUSES)", () => {
    expect([...LOOKUP_SCHOOL_STATUSES].sort()).toEqual(["active", "overdue", "trial"]);
    expect(CLOSED.sort()).toEqual(["onboarding", "setup_stalled", "suspended"]);
  });

  describe("refused before the database", () => {
    // Each is sent as it stands in the URL path; the router decodes it once.
    const MALFORMED: Array<[string, string]> = [
      ["empty (/v1/public/schools/)", ""],
      ["upper case", "SCHOOL-A"],
      ["mixed case", "School-a"],
      ["too short", "ab"],
      ["too long", "a".repeat(41)],
      ["underscore (a LIKE wildcard)", "school_a"],
      ["percent (a LIKE wildcard)", "school%25"],
      ["star", "school-%2A"],
      ["quote and comment", encodeURIComponent("school-a'--")],
      ["tautology", encodeURIComponent("' OR '1'='1")],
      ["stacked statement", encodeURIComponent("x'; DROP TABLE tenants; --")],
      ["NUL byte", "school-a%00"],
      ["space", "school%20a"],
      ["dot", "school.a"],
      ["non-ASCII", encodeURIComponent("\u00e9col\u00e9")],
      ["right-to-left override", encodeURIComponent("school\u202ea")],
      ["regex metacharacters", encodeURIComponent("school-.*")],
      ["JSON", encodeURIComponent('{"$ne":1}')],
    ];

    it("a malformed address is the standard 400 validation_error, and takes no rate-limit token and writes no audit row", async () => {
      await clearTrail();
      const tenantsBefore = await owner(`SELECT id, name, slug, status FROM tenants ORDER BY id`);
      for (const [what, slug] of MALFORMED) {
        const r = await lookup(slug);
        expect(r.statusCode, `${what}: ${r.body}`).toBe(400);
        const err = r.json().error;
        expect(err.code, what).toBe("validation_error");
        expect(err.request_id, what).toBe(r.headers["x-request-id"]);
        // the submitted value is never echoed back
        expect(r.body.toLowerCase(), what).not.toContain("drop table");
        expect(r.body, what).not.toContain("1'='1");
      }
      expect(await owner(`SELECT bucket_key FROM auth_rate_buckets WHERE bucket_key LIKE 'school_lookup:%'`)).toEqual([]);
      expect(await missEvents()).toEqual([]);
      // SQL metacharacters were harmless: the schools are as they were, and the lookup still works
      expect(await owner(`SELECT id, name, slug, status FROM tenants ORDER BY id`)).toEqual(tenantsBefore);
      expect((await lookup("school-a")).statusCode).toBe(200);
    });

    it("a path that is not one address segment is an unknown route (the same 404 as any)", async () => {
      for (const url of ["/v1/public/schools", "/v1/public/schools/school-a/members", "/v1/public/schools/school-a/", "/v1/public/school/school-a"]) {
        const r = await ctx.app.inject({ method: "GET", url });
        expect(r.statusCode, url).toBe(404);
        expect(r.json().error.code, url).toBe("not_found");
      }
      // there is no list or search: other methods are not routes either
      const post = await ctx.app.inject({ method: "POST", url: "/v1/public/schools/school-a", payload: {} });
      expect(post.statusCode).toBe(404);
    });
  });

  describe("unknown and not open for sign-in are one answer", () => {
    it("an unknown address is the standard not-found body, byte for byte the answer of an unknown route", async () => {
      const r = await lookup("no-such-school-anywhere");
      expect(r.statusCode).toBe(404);
      expect(rawBody(r)).toBe(`{"error":{"code":"not_found","message":"Not found","request_id":"<request-id>"}}`);
      const route = await ctx.app.inject({ method: "GET", url: "/v1/no-such-route" });
      expect(rawBody(route)).toBe(rawBody(r));
    });

    it("onboarding, stalled-in-setup and suspended schools answer exactly like an address nobody has (status, body, headers)", async () => {
      const unknown = sameAnswer(await lookup("lookup-nobody-has-this"));
      expect(unknown.status).toBe(404);
      for (const status of CLOSED) {
        const r = await lookup(byStatus[status]!.slug);
        expect(sameAnswer(r), status).toEqual(unknown);
        expect(r.body, status).not.toContain(byStatus[status]!.id);
        expect(r.body, status).not.toContain(byStatus[status]!.name);
        expect(r.body.toLowerCase(), status).not.toMatch(/suspend|onboard|stall|status|inactive/);
      }
    });

    it("both leave the same operator-only trail (no school id, no status, no hint which); a hit leaves none", async () => {
      await clearTrail();
      expect((await lookup("school-a")).statusCode).toBe(200);
      expect(await missEvents()).toEqual([]);
      await lookup("lookup-nobody-has-this");
      await lookup(byStatus.suspended!.slug);
      const events = await missEvents();
      expect(events).toEqual([
        { tenant_id: null, actor_user_id: null, detail: { slug: "lookup-nobody-has-this" }, ip: "127.0.0.1" },
        { tenant_id: null, actor_user_id: null, detail: { slug: byStatus.suspended!.slug }, ip: "127.0.0.1" },
      ]);
      // a school never sees it: the event has no school, and its kind is hidden from the school audit log
      const shown = await owner(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = $1 AND tenant_id IS NOT NULL`, [EVENT]);
      expect(shown[0].n).toBe(0);
    });

    it("exact match only: a prefix, a suffix or a near miss is not found", async () => {
      for (const slug of ["school", "school-", "chool-a", "school-a-", "school-aa", "school-b-1", "---"]) {
        const r = await lookup(slug);
        expect(r.statusCode, slug).toBe(404);
      }
    });
  });

  describe("a school open for sign-in", () => {
    it("active, on trial and overdue schools answer 200 with the school id and name and nothing else", async () => {
      for (const status of LOOKUP_SCHOOL_STATUSES) {
        const s = byStatus[status]!;
        const r = await lookup(s.slug);
        expect(r.statusCode, `${status}: ${r.body}`).toBe(200);
        expect(r.json()).toEqual({ tenant_id: s.id, name: s.name });
        expect(Object.keys(r.json()).sort()).toEqual(["name", "tenant_id"]);
        conforms(200, r.json());
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(r.headers["set-cookie"]).toBeUndefined();
      }
      const a = await lookup("school-a");
      expect(a.json()).toEqual({ tenant_id: ctx.ids.tenantA, name: "School A" });
      // nothing else about the school or its organisation
      for (const word of ["org", "status", "timezone", "slug", "created", "county", "crest", "count"]) expect(a.body).not.toContain(`"${word}`);
      conforms(404, (await lookup("lookup-nobody-has-this")).json());
      conforms(400, (await lookup("NOPE")).json());
    });

    it("the answer is the school id login-id sign-in takes", async () => {
      const id = (await lookup("school-b")).json().tenant_id as string;
      expect(id).toBe(ctx.ids.tenantB);
      const signIn = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: id, loginId: "TC-0001", password: PASSWORD } });
      expect(signIn.statusCode, signIn.body).toBe(200);
      expect(signIn.json().activeTenantId).toBe(ctx.ids.tenantB);
    });
  });

  describe("no authentication, and nothing a caller sends changes the answer", () => {
    it("anonymous, a forged token, an administrator, another school's teacher and a learner (each with their own tenant header) get the same answer", async () => {
      const login = async (payload: Record<string, unknown>) => {
        const r = await ctx.app.inject({ method: "POST", url: payload.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload });
        expect(r.statusCode, r.body).toBe(200);
        return r.json().token as string;
      };
      const admin = await login({ email: "admin-a@example.com", password: PASSWORD });
      const teacherB = await login({ tenantId: ctx.ids.tenantB, loginId: "TC-0001", password: PASSWORD });
      // a learner of school A with a login made by the office (the one-time password is enough to be a session)
      const learnerId = (await owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Lookup Learner', 'female') RETURNING id`, [ctx.ids.tenantA, "S" + randomUUID().slice(0, 8)]))[0].id as string;
      const made = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ctx.ids.tenantA}/learners/${learnerId}/student-account`,
        headers: { authorization: `Bearer ${admin}`, "x-tenant-id": ctx.ids.tenantA },
      });
      expect(made.statusCode, made.body).toBe(201);
      const learner = await login({ tenantId: ctx.ids.tenantA, loginId: made.json().account.login_id, password: made.json().account.one_time_password });

      const callers: Array<[string, Record<string, string>]> = [
        ["anonymous", {}],
        ["forged token", { authorization: "Bearer " + "x".repeat(43) }],
        ["forged token, other school header", { authorization: `Bearer ${randomUUID()}`, "x-tenant-id": ctx.ids.tenantB }],
        ["administrator of A", { authorization: `Bearer ${admin}`, "x-tenant-id": ctx.ids.tenantA }],
        ["teacher of B", { authorization: `Bearer ${teacherB}`, "x-tenant-id": ctx.ids.tenantB }],
        ["learner of A", { authorization: `Bearer ${learner}`, "x-tenant-id": ctx.ids.tenantA }],
        ["learner of A, B's header", { authorization: `Bearer ${learner}`, "x-tenant-id": ctx.ids.tenantB }],
      ];
      for (const slug of ["school-a", "school-b", byStatus.suspended!.slug, "lookup-nobody-has-this"]) {
        const expected = sameAnswer(await lookup(slug));
        for (const [who, headers] of callers) {
          const r = await lookup(slug, { headers });
          expect(sameAnswer(r), `${who} -> ${slug}`).toEqual(expected);
        }
      }
      // the misses of signed-in callers are recorded without the caller either (the route never reads the session)
      const withActor = await owner(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = $1 AND actor_user_id IS NOT NULL`, [EVENT]);
      expect(withActor[0].n).toBe(0);
    }, 60_000);
  });

  describe("rate limit (per caller address, the login limiter's numbers)", () => {
    let limited: App;
    beforeAll(async () => {
      // The production numbers (AUTH_RATE_* defaults: 5 at once, +2 every 5 s), with a slow refill so the test is not racy.
      limited = await buildApp({ ...ctx.config, authRateCapacity: 5, authRateRefill: 2, authRateIntervalMs: 60_000 }, ctx.runtimePool);
      await limited.ready();
      await clearTrail();
    });
    afterAll(async () => {
      await limited.close();
      await clearTrail(); // buckets are shared persistent state: leave none behind
    });

    it("5 lookups at once from one address (hits and misses alike), then 429 with Retry-After, even for a real school", async () => {
      const ip = "203.0.113.41";
      const first = [
        await lookup("school-a", { app: limited, ip }),
        await lookup("lookup-nobody-has-this", { app: limited, ip }),
        await lookup(byStatus.suspended!.slug, { app: limited, ip }),
        await lookup("school-b", { app: limited, ip }),
        await lookup("another-miss", { app: limited, ip }),
      ];
      expect(first.map((r) => r.statusCode)).toEqual([200, 404, 404, 200, 404]);
      for (const slug of ["school-a", "lookup-nobody-has-this", byStatus.suspended!.slug]) {
        const r = await lookup(slug, { app: limited, ip });
        expect(r.statusCode, slug).toBe(429);
        expect(r.json().error.code).toBe("rate_limited");
        expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(r.body).not.toContain(ctx.ids.tenantA);
        conforms(429, r.json());
      }
      // the shape check still comes first, and costs nothing
      expect((await lookup("NOT-A-SLUG", { app: limited, ip })).statusCode).toBe(400);
      // another address has its own bucket
      expect((await lookup("school-a", { app: limited, ip: "203.0.113.42" })).statusCode).toBe(200);
    });

    it("an IPv6 caller is counted per /64, so new addresses in one network do not mint new buckets", async () => {
      for (let i = 1; i <= 5; i++) expect((await lookup("school-a", { app: limited, ip: `2001:db8:41:1::${i}` })).statusCode).toBe(200);
      expect((await lookup("school-a", { app: limited, ip: "2001:db8:41:1:ffff:ffff:ffff:ffff" })).statusCode).toBe(429);
      expect((await lookup("school-a", { app: limited, ip: "2001:db8:41:2::1" })).statusCode).toBe(200);
    });

    it("a scan is slow and leaves a trail: 30 guesses from one address get 5 answers, and the trail holds exactly the misses that were answered", async () => {
      await clearTrail();
      const ip = "198.51.100.77";
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) statuses.push((await lookup(`guess-${i}`, { app: limited, ip })).statusCode);
      expect(statuses.filter((s) => s === 404)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(25);
      const events = await missEvents();
      expect(events.map((e) => e.detail.slug)).toEqual(["guess-0", "guess-1", "guess-2", "guess-3", "guess-4"]);
      expect(new Set(events.map((e) => e.ip))).toEqual(new Set([ip]));
    });
  });

  describe("the contract", () => {
    it("is documented as public with no tenant, the slug shape of the code, and an answer of exactly tenant_id and name", () => {
      const op = spec.paths[PATH]?.get;
      expect(op, "documented").toBeTruthy();
      expect(op["x-figbloom-authz"]).toBe("public");
      expect(op["x-figbloom-tenantScope"]).toBe("none");
      expect(op.security).toBeUndefined();
      expect(Object.keys(spec.paths[PATH]).sort()).toEqual(["get"]);
      const slug = op.parameters.find((p: { name: string }) => p.name === "slug");
      expect(slug).toMatchObject({ in: "path", required: true, schema: { type: "string", pattern: SCHOOL_SLUG_PATTERN, minLength: 3, maxLength: 40 } });
      const ok = op.responses["200"].content["application/json"].schema;
      expect(ok.additionalProperties).toBe(false);
      expect([...ok.required].sort()).toEqual(["name", "tenant_id"]);
      expect(Object.keys(ok.properties).sort()).toEqual(["name", "tenant_id"]);
      expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "404", "429"]);
      // no other public operation under /v1/public lists or searches schools
      expect(Object.keys(spec.paths).filter((p) => p.startsWith("/v1/public/"))).toEqual([PATH]);
    });
  });
});
