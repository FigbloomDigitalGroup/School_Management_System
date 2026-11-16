/**
 * C-1 independent verification: a wide malformed-cursor matrix over all four paginated
 * endpoints, at HTTP level against PostgreSQL. Every case must be HTTP 400 with the
 * established `{ error: { code, message } }` envelope and no SQL/driver internals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import { CURSOR_VERSION, pageFingerprint } from "../src/http/pagination.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");

describe("C-1 malformed cursor matrix (all four paginated endpoints)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let orgToken: string;
  let adminToken: string;
  let learnerId: string;

  const login = async (email: string) => {
    const r = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email, password: "correct-horse-battery" },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    orgToken = await login("orgadmin@example.com");
    adminToken = await login("admin-a@example.com");
    const l = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: { admission_no: "MTX-01", full_name: "Matrix Learner", gender: "male" },
    });
    expect(l.statusCode).toBe(201);
    learnerId = l.json().learner.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.runtimePool.end();
    await ctx.pool.end();
  });

  interface Endpoint {
    name: string;
    url: () => string;
    headers: () => Record<string, string>;
    sort: string;
    filter: () => Record<string, unknown>;
    /** A well-formed key tuple for this endpoint. */
    goodKeys: () => string[];
    keyCount: number;
  }

  const endpoints: Endpoint[] = [
    {
      name: "org schools",
      url: () => "/v1/org/schools",
      headers: () => ({ authorization: `Bearer ${orgToken}` }),
      sort: "org_name_school_name",
      filter: () => ({ scopeUserId: ids.orgAdmin }),
      goodKeys: () => [ids.tenantA], keyCount: 1,
    },
    {
      name: "org delegations",
      url: () => "/v1/rbac/org-delegations?status=all",
      headers: () => ({ authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA }),
      sort: "created_at_desc",
      filter: () => ({ status: "all", tenantId: ids.tenantA }),
      goodKeys: () => ["2026-01-15T12:00:00.000100Z", randomUUID()], keyCount: 2,
    },
    {
      name: "learner guardians",
      url: () => `/v1/tenants/${ids.tenantA}/learners/${learnerId}/guardians`,
      headers: () => ({ authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA }),
      sort: "link_created_at",
      filter: () => ({ tenantId: ids.tenantA, learnerId }),
      goodKeys: () => ["2026-01-15T12:00:00.000100Z", randomUUID()], keyCount: 2,
    },
    {
      name: "permissions",
      url: () => "/v1/rbac/permissions",
      headers: () => ({ authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA }),
      sort: "code",
      filter: () => ({ tenantId: ids.tenantA, userId: ids.adminA }),
      goodKeys: () => ["tenant.read"], keyCount: 1,
    },
  ];

  const SQLISH = "'; DROP TABLE sessions; --";

  /** Raw (pre-encoded) cursors that do not depend on the endpoint. */
  const rawBad: Array<[string, string]> = [
    ["not base64 / garbage", "!!!!!!!!!!"],
    ["too short", "abc"],
    ["valid base64, not JSON", b64("this is not json at all")],
    ["JSON null", b64("null")],
    ["JSON number", b64("12345678")],
    ["JSON array", b64("[1,2,3,4,5,6,7,8]")],
    ["JSON string", b64('"a long enough string"')],
    ["over 2048 chars", "A".repeat(2049)],
    ["empty object", b64("{}")],
  ];

  for (const ep of endpoints) {
    describe(ep.name, () => {
      const get = (cursor: string) => {
        const sep = ep.url().includes("?") ? "&" : "?";
        return ctx.app.inject({
          method: "GET",
          url: `${ep.url()}${sep}cursor=${encodeURIComponent(cursor)}`,
          headers: ep.headers(),
        });
      };

      const expect400 = (res: Awaited<ReturnType<typeof get>>, label: string) => {
        expect(res.statusCode, label).toBe(400);
        const body = res.json();
        expect(body.error?.code, label).toBe("validation_error");
        expect(typeof body.error?.message, label).toBe("string");
        expect(Object.keys(body), label).toEqual(["error"]);
        const text = res.body.toLowerCase();
        for (const leak of ["sqlstate", "syntax error", "invalid input syntax", "pg_", "select ", "stack", "at node:", "drop table"]) {
          expect(text.includes(leak), `${label}: leaked "${leak}"`).toBe(false);
        }
      };

      const envelope = (over: Record<string, unknown>) => ({
        v: CURSOR_VERSION,
        k: ep.goodKeys(),
        f: pageFingerprint(ep.sort, ep.filter()),
        s: ep.sort,
        ...over,
      });

      for (const [label, cursor] of rawBad) {
        it(`400: ${label}`, async () => {
          expect400(await get(cursor), label);
        });
      }

      // Built lazily: fixture ids only exist once beforeAll has run.
      const structuralCases = (): Array<[string, Record<string, unknown>]> => [
        ["unsupported version 1", { v: 1 }],
        ["unsupported version 3", { v: 3 }],
        ["version as string", { v: "2" }],
        ["extra field", { extra: "x" }],
        ["keys empty", { k: [] }],
        ["keys too many", { k: [...ep.goodKeys(), "extra"] }],
        ["key is number", { k: [123, ...ep.goodKeys().slice(1)] }],
        ["key is null", { k: [null, ...ep.goodKeys().slice(1)] }],
        ["key is object", { k: [{ a: 1 }, ...ep.goodKeys().slice(1)] }],
        ["keys not array", { k: "tenant.read" }],
        ["fingerprint wrong", { f: pageFingerprint(ep.sort, { tenantId: randomUUID() }) }],
        ["fingerprint non-string", { f: 1 }],
        ["fingerprint too long", { f: "f".repeat(200) }],
        ["sort wrong", { s: "other_sort" }],
        ["sort empty", { s: "" }],
        ["sort NUL", { s: "co\0de" }],
      ];
      const structuralLabels = [
        "unsupported version 1", "unsupported version 3", "version as string", "extra field", "keys empty",
        "keys too many", "key is number", "key is null", "key is object", "keys not array",
        "fingerprint wrong", "fingerprint non-string", "fingerprint too long", "sort wrong", "sort empty", "sort NUL",
      ];
      for (const label of structuralLabels) {
        it(`400: ${label}`, async () => {
          const over = structuralCases().find(([l]) => l === label)![1];
          expect400(await get(b64(envelope(over))), label);
        });
      }

      // Per-position content checks, driven by the endpoint's own good tuple.
      const good = () => ep.goodKeys();
      const poisons = ["", SQLISH, "x\0y", " ", "2026-13-01T00:00:00.000000Z", "2026-02-30T00:00:00.000000Z",
        "2026-01-15T12:00:00Z", "2026-01-15T12:00:00.000Z", "2026-01-15T12:00:00.000000+03:00", "infinity", "-infinity",
        "0000-01-01T00:00:00.000000Z", "2026-01-15 12:00:00.000000Z", "not-a-uuid", "00000000-0000-0000-0000-00000000000g",
        "UPPER.CASE", "1leading.digit", "has space", "a".repeat(300), "tenant.read'--"];
      for (let pos = 0; pos < ep.keyCount; pos++) {
        it(`400: poisoned key at position ${pos} never reaches SQL as a 500`, async () => {
          let rejected = 0;
          for (const poison of poisons) {
            const k = good();
            k[pos] = poison;
            const res = await get(b64(envelope({ k })));
            // Content that happens to be valid for this slot (e.g. free text) may be accepted: 200 is fine.
            // What must never happen is a 5xx.
            expect(res.statusCode, `pos ${pos} poison ${JSON.stringify(poison).slice(0, 40)}`).toBeLessThan(500);
            if (res.statusCode === 400) {
              rejected++;
              expect400(res, `pos ${pos}`);
            } else {
              expect(res.statusCode).toBe(200);
            }
          }
          expect(rejected).toBeGreaterThan(0);
        });
      }

      it("a well-formed cursor is accepted (200)", async () => {
        const res = await get(b64(envelope({})));
        expect(res.statusCode).toBe(200);
      });
    });
  }

  it("every permission code in the catalogue satisfies the cursor key pattern (page 2 of /v1/rbac/permissions cannot 400 for a real code)", async () => {
    const bad = await ctx.pool.query<{ code: string }>(
      `SELECT code FROM permissions WHERE code !~ '^[a-z][a-z0-9_.]{0,63}$'`,
    );
    expect(bad.rows).toEqual([]);
  });

  it("cross-endpoint cursor reuse is rejected", async () => {
    // A valid permissions cursor replayed against org-delegations must be 400.
    const permCursor = b64({
      v: CURSOR_VERSION,
      k: ["tenant.read"],
      f: pageFingerprint("code", { tenantId: ids.tenantA, userId: ids.adminA }),
      s: "code",
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/rbac/org-delegations?status=all&cursor=${encodeURIComponent(permCursor)}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(res.statusCode).toBe(400);
  });

  it("SQLSTATE class 22 from any other source maps to a safe 400 envelope", async () => {
    const { toClientError } = await import("../src/http/errors.js");
    for (const code of ["22P02", "22007", "22008", "22003", "22001", "22021"]) {
      const err = Object.assign(new Error('invalid input syntax for type uuid: "x" at SELECT secret'), {
        code,
      });
      const out = toClientError(err);
      expect(out.statusCode).toBe(400);
      expect(out.body).toEqual({ error: { code: "validation_error", message: "Invalid request" } });
    }
    // Non-22 stays a generic server error with no internals.
    const out = toClientError(Object.assign(new Error("boom SELECT"), { code: "23505" }));
    expect(out.statusCode).not.toBe(400);
    expect(JSON.stringify(out.body)).not.toContain("SELECT");
  });
});
