import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestApp, type FixtureIds } from "./support.js";
import { buildApp } from "../src/app.js";

/**
 * Regression tests for the Phase 3 final independent audit (FIG-1699), findings
 * P3-AUDIT-001 … 007 plus the RLS WITH CHECK proof for review item T-1.
 * Each test is written so that it fails if the corresponding fix is removed.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function loginEmail(app: Ctx["app"], email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/email",
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function bearer(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Phase 3 final audit remediation (P3-AUDIT-001 … 007)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let orgToken: string;
  let learnerId: string;
  let learner2Id: string;
  let guardianId: string;

  const A = () => ids.tenantA;
  const B = () => ids.tenantB;

  async function req(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", token: string, url: string, payload?: unknown) {
    return ctx.app.inject({ method, url, headers: bearer(token, A()), payload: payload as never });
  }
  async function delegate(method: "POST" | "DELETE", codes: string[], expected = 200) {
    const res = await req(method, adminToken, "/v1/rbac/org-delegations", {
      delegateUserId: ids.orgAdmin,
      permissionCodes: codes,
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(expected);
  }
  async function newGuardian(name: string, learner = learnerId): Promise<string> {
    const r = await req("POST", adminToken, `/v1/tenants/${A()}/guardians`, {
      full_name: name,
      phone: "0711000111",
      email: `${name.replace(/\s+/g, ".").toLowerCase()}@example.com`,
      learners: [{ learner_id: learner, relationship: "mother" }],
    });
    expect(r.statusCode).toBe(201);
    return r.json().guardian.id as string;
  }
  async function deniedCount(userId: string): Promise<number> {
    const r = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events
        WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1`,
      [userId],
    );
    return r.rows[0]?.n ?? 0;
  }
  /** figbloom_app connection with tenant context, in a transaction that is always rolled back. */
  async function asRuntime<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  async function sqlCode(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? "no-code";
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    orgToken = await loginEmail(ctx.app, "orgadmin@example.com");

    const l1 = await req("POST", adminToken, `/v1/tenants/${A()}/learners`, {
      admission_no: "FA-1",
      full_name: "Final Audit One",
      gender: "female",
    });
    expect(l1.statusCode).toBe(201);
    learnerId = l1.json().learner.id;
    const l2 = await req("POST", adminToken, `/v1/tenants/${A()}/learners`, {
      admission_no: "FA-2",
      full_name: "Final Audit Two",
      gender: "male",
    });
    expect(l2.statusCode).toBe(201);
    learner2Id = l2.json().learner.id;
    guardianId = await newGuardian("Audit Guardian");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ------------------------------------------------------------ P3-AUDIT-001
  describe("P3-AUDIT-001 guardian write does not return contact details to a write-only caller", () => {
    it("guardian codes cannot be delegated to an org admin at all (owner decision, FIG-1609 / FIG-1614 M-2)", async () => {
      // The write-only response shape is now exercised through the explicit per-person grant
      // (fig1614.guardianAccess.test.ts): only a school administrator can grant guardian access.
      await delegate("POST", ["resource.guardian.write"], 400);
      await delegate("POST", ["resource.guardian.read"], 400);
      await delegate("POST", ["resource.guardian.read", "resource.guardian.write"], 400);
      const denied = await req("PATCH", orgToken, `/v1/tenants/${A()}/guardians/${guardianId}`, { full_name: "Nope" });
      expect(denied.statusCode).toBe(403);
      // The school administrator holds both permissions and still gets the full record.
      const admin = await req("PATCH", adminToken, `/v1/tenants/${A()}/guardians/${guardianId}`, {
        alt_phone: "0711000113",
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.json().guardian.alt_phone).toBe("0711000113");
    });
  });

  // ------------------------------------------------------------ P3-AUDIT-003
  describe("P3-AUDIT-003 CORS allows the PATCH routes Phase 3 added", () => {
    it("a browser preflight for PATCH from an allowed origin is answered with PATCH allowed", async () => {
      const app = await buildApp(
        { ...ctx.config, corsAllowedOrigins: ["https://app.example.com"], corsMaxAgeSeconds: 600 },
        ctx.runtimePool,
      );
      try {
        const pre = await app.inject({
          method: "OPTIONS",
          url: `/v1/tenants/${A()}/learners/${learnerId}`,
          headers: {
            origin: "https://app.example.com",
            "access-control-request-method": "PATCH",
            "access-control-request-headers": "authorization,content-type,x-tenant-id",
          },
        });
        expect(pre.statusCode).toBeLessThan(300);
        expect(String(pre.headers["access-control-allow-methods"])).toMatch(/\bPATCH\b/);
      } finally {
        await app.close();
      }
    });
  });

  // ------------------------------------------------------------ P3-AUDIT-002
  describe("P3-AUDIT-002 school name and timezone stay full-administrator-only", () => {
    it("school_profile.write cannot be delegated to an org admin; only the school administrator changes the profile", async () => {
      await delegate("POST", ["resource.school_profile.write"], 400);
      await delegate("POST", ["resource.school_profile.read"], 400);
      const deniedBefore = await deniedCount(ids.orgAdmin);
      for (const payload of [{ name: "Hijacked School" }, { timezone: "Africa/Lagos" }, { county: "Mombasa" }]) {
        const denied = await req("PATCH", orgToken, `/v1/tenants/${A()}/school-profile`, payload);
        expect(denied.statusCode, JSON.stringify(payload)).toBe(403);
      }
      expect(await deniedCount(ids.orgAdmin)).toBe(deniedBefore + 3);
      const admin = await req("PATCH", adminToken, `/v1/tenants/${A()}/school-profile`, {
        name: "School A (renamed by admin)",
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.json().schoolProfile.name).toBe("School A (renamed by admin)");
    });
  });

  // ------------------------------------------------------------ P3-AUDIT-004
  describe("P3-AUDIT-004 timezone must be a real time zone", () => {
    it("the API refuses an unknown zone and stores a known one in canonical form", async () => {
      const bad = await req("PATCH", adminToken, `/v1/tenants/${A()}/school-profile`, { timezone: "Mars/Base" });
      expect(bad.statusCode).toBe(400);
      const good = await req("PATCH", adminToken, `/v1/tenants/${A()}/school-profile`, { timezone: "africa/nairobi" });
      expect(good.statusCode).toBe(200);
      expect(good.json().schoolProfile.timezone).toBe("Africa/Nairobi");
    });

    it("the database refuses it independently of the API (identity function as figbloom_app)", async () => {
      await asRuntime(A(), async (c) => {
        expect(await sqlCode(c.query(`SELECT * FROM directory_update_tenant_identity('X', 'Mars/Base')`))).toBe("22023");
      });
      await asRuntime(A(), async (c) => {
        const r = await c.query<{ timezone: string }>(
          `SELECT timezone FROM directory_update_tenant_identity('X', 'europe/london')`,
        );
        expect(r.rows[0]!.timezone).toBe("Europe/London");
      });
    });
  });

  // ------------------------------------------------------------ P3-AUDIT-005
  describe("P3-AUDIT-005 no client-chosen logo storage key", () => {
    it("the API rejects logo_object_key and never returns it", async () => {
      const r = await req("PATCH", adminToken, `/v1/tenants/${A()}/school-profile`, {
        logo_object_key: `obj/${B()}/${"a".repeat(64)}`,
      });
      expect(r.statusCode).toBe(400);
      const g = await req("GET", adminToken, `/v1/tenants/${A()}/school-profile`);
      expect(g.body).not.toContain("logo_object_key");
    });

    it("the runtime role cannot write the logo key at all (migration 027 column grants)", async () => {
      // Stronger than the CHECK: P3-AUDIT-009 removed UPDATE on logo_object_key from
      // figbloom_app, so a well-shaped key is refused as well as a malformed one. The column
      // becomes writable only when the storage integration grants it deliberately.
      const eff = await ctx.pool.query<{ upd: boolean }>(
        `SELECT has_column_privilege('figbloom_app', 'public.school_profiles', 'logo_object_key', 'UPDATE') AS upd`,
      );
      expect(eff.rows[0]?.upd).toBe(false);

      await asRuntime(A(), async (c) => {
        const code = await sqlCode(
          c.query(
            `INSERT INTO school_profiles (tenant_id, logo_object_key) VALUES ($1, $2)
             ON CONFLICT (tenant_id) DO UPDATE SET logo_object_key = EXCLUDED.logo_object_key`,
            [A(), `obj/${A()}/${"b".repeat(64)}`],
          ),
        );
        expect(code).toBe("42501");
      });
    });

    it("the database only accepts a server-shaped key under the row's own tenant", async () => {
      // Three layers now guard this column and they must be proved separately, or one can hide
      // the failure of another:
      //   * the runtime role has no UPDATE privilege on it   -> the test above;
      //   * `school_profiles_before_insert` discards any client value on INSERT (migration 028,
      //     audit finding A-04)                              -> `stage8.audit.test.ts`;
      //   * the CHECK constrains the shape and the tenant    -> this test.
      //
      // The trigger runs first and nulls the proposed value, so with it active the CHECK can
      // never fire and this test would pass without the constraint existing at all. It is
      // therefore disabled inside a transaction that is always rolled back — the same technique
      // the T-1 RLS proof uses — leaving the CHECK as the only thing that can refuse the write.
      // The CHECK still matters: when object storage arrives and the trigger is replaced by one
      // that ASSIGNS a key, this is what keeps that key in its own tenant's prefix.
      const own = `obj/${A()}/${"b".repeat(64)}`;
      const owner = await ctx.pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query(`ALTER TABLE school_profiles DISABLE TRIGGER school_profiles_before_insert`);
        const upsert = async (key: string): Promise<string | null> =>
          sqlCode(
            owner.query(
              `INSERT INTO school_profiles (tenant_id, logo_object_key) VALUES ($1, $2)
               ON CONFLICT (tenant_id) DO UPDATE SET logo_object_key = EXCLUDED.logo_object_key`,
              [A(), key],
            ),
          );
        for (const bad of [
          "http://evil.example/logo.png",
          "../../etc/passwd",
          `obj/${B()}/${"c".repeat(64)}`,
          "obj/x",
        ]) {
          // Each refusal aborts the transaction, so each attempt gets its own savepoint.
          await owner.query("SAVEPOINT probe");
          expect(await upsert(bad), bad).toBe("23514");
          await owner.query("ROLLBACK TO SAVEPOINT probe");
        }
        expect(await upsert(own)).toBeNull();
      } finally {
        // Everything above, including the ALTER TABLE, is discarded: DDL is transactional.
        await owner.query("ROLLBACK").catch(() => undefined);
        owner.release();
      }
      // The trigger is back on and still enforcing, and no key survived the rolled-back work.
      const after = await ctx.pool.query<{ logo_object_key: string | null }>(
        `SELECT logo_object_key FROM school_profiles WHERE tenant_id = $1`,
        [A()],
      );
      expect(after.rows[0]?.logo_object_key ?? null).toBeNull();
    });
  });

  // ------------------------------------------------------------ P3-AUDIT-006
  describe("P3-AUDIT-006 restoring a staff record", () => {
    async function newStaff(name: string, userId: string | null): Promise<string> {
      const r = await req("POST", adminToken, `/v1/tenants/${A()}/staff`, {
        full_name: name,
        classification: "staff",
        ...(userId ? { userId } : {}),
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().staff.id as string;
    }

    it("is a 409, not a 500, when another active record took the same user", async () => {
      const x = await newStaff("Restore Conflict X", ids.teacherA);
      expect((await req("POST", adminToken, `/v1/tenants/${A()}/staff/${x}/archive`)).statusCode).toBe(200);
      await newStaff("Restore Conflict Y", ids.teacherA);
      const restore = await req("POST", adminToken, `/v1/tenants/${A()}/staff/${x}/restore`);
      expect(restore.statusCode).toBe(409);
      expect(restore.body).not.toMatch(/staff_members_tenant_user_uidx|duplicate key/i);
    });

    it("clears a link whose user left the school while the record was archived", async () => {
      const z = await newStaff("Restore Stale Link", ids.parentA);
      expect((await req("POST", adminToken, `/v1/tenants/${A()}/staff/${z}/archive`)).statusCode).toBe(200);
      await ctx.pool.query(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        [ids.parentA, A()],
      );
      try {
        const restore = await req("POST", adminToken, `/v1/tenants/${A()}/staff/${z}/restore`);
        expect(restore.statusCode, restore.body).toBe(200);
        expect(restore.json().staff.active).toBe(true);
        expect(restore.json().staff.userId).toBeNull();
        const ev = await ctx.pool.query<{ detail: { userLinkCleared?: boolean } }>(
          `SELECT detail FROM security_audit_events
            WHERE event_type = 'directory.staff.restored' AND tenant_id = $1
            ORDER BY occurred_at DESC LIMIT 1`,
          [A()],
        );
        expect(ev.rows[0]!.detail.userLinkCleared).toBe(true);
      } finally {
        await ctx.pool.query(
          `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
          [ids.parentA, A()],
        );
      }
    });

    it("keeps a link whose user is still an active member", async () => {
      const k = await newStaff("Restore Keeps Link", ids.adminA);
      expect((await req("POST", adminToken, `/v1/tenants/${A()}/staff/${k}/archive`)).statusCode).toBe(200);
      const restore = await req("POST", adminToken, `/v1/tenants/${A()}/staff/${k}/restore`);
      expect(restore.statusCode).toBe(200);
      expect(restore.json().staff.userId).toBe(ids.adminA);
    });
  });

  // ------------------------------------------------------------ P3-AUDIT-007
  describe("P3-AUDIT-007 a guardian cannot be archived underneath a link being added", () => {
    it("adding a link waits for a concurrent archive of that guardian and then refuses (404), leaving no link", async () => {
      const gid = await newGuardian("Race Guardian");
      const owner = await ctx.pool.connect();
      try {
        // Same lock an archive takes: an uncommitted UPDATE of the guardian row.
        await owner.query("BEGIN");
        await owner.query(`UPDATE guardians SET active = false, archived_at = now(), updated_at = now() WHERE id = $1`, [gid]);

        const link = req("POST", adminToken, `/v1/tenants/${A()}/guardians/${gid}/links`, {
          learner_id: learner2Id,
          relationship: "father",
        });
        const raced = await Promise.race([link.then(() => "settled"), sleep(900).then(() => "waiting")]);
        // Without the row lock the request would have inserted the link and returned already.
        expect(raced).toBe("waiting");

        await owner.query("COMMIT");
        const res = await link;
        expect(res.statusCode).toBe(404);
      } finally {
        await owner.query("ROLLBACK").catch(() => undefined);
        owner.release();
      }
      const links = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guardian_links WHERE guardian_id = $1`,
        [gid],
      );
      expect(links.rows[0]!.n).toBe(1); // only the creation link
    });
  });

  // ------------------------------------------------------------ FIG-1605 criterion 6
  describe("FIG-1605 criterion 6: the runtime role cannot remove its own guard rails", () => {
    it("cannot drop the append-only audit trigger, disable triggers, add a bypass policy or assume another role", async () => {
      const statements: Array<[string, string]> = [
        ["drop the append-only trigger", `DROP TRIGGER security_audit_events_append_only ON security_audit_events`],
        ["disable audit triggers", `ALTER TABLE security_audit_events DISABLE TRIGGER USER`],
        ["disable triggers on a PII table", `ALTER TABLE learners DISABLE TRIGGER USER`],
        ["disable RLS", `ALTER TABLE learners DISABLE ROW LEVEL SECURITY`],
        ["stop forcing RLS", `ALTER TABLE learners NO FORCE ROW LEVEL SECURITY`],
        ["create a bypass policy", `CREATE POLICY runtime_bypass_probe ON learners FOR SELECT TO PUBLIC USING (true)`],
        ["take ownership", `ALTER TABLE learners OWNER TO figbloom_app`],
        ["assume the superuser role", `SET ROLE postgres`],
        ["assume another identity", `SET SESSION AUTHORIZATION postgres`],
        ["create a role", `CREATE ROLE runtime_probe_role`],
      ];
      for (const [label, sql] of statements) {
        await asRuntime(A(), async (c) => {
          const code = await sqlCode(c.query(sql));
          expect(code, label).not.toBeNull();
          // 42501 insufficient_privilege (or 42704 for a role that does not exist for SET ROLE).
          expect(["42501", "42704"], `${label}: ${code}`).toContain(code);
        });
      }
    });
  });

  describe("FIG-1605 criterion 6 (grants)", () => {
    it("a GRANT issued by the runtime role changes nothing (PostgreSQL only warns when there is no grant option)", async () => {
      await asRuntime(A(), async (c) => {
        await c.query("GRANT DELETE, TRUNCATE ON learners TO figbloom_app");
        const r = await c.query<{ d: boolean; t: boolean }>(
          `SELECT has_table_privilege('figbloom_app', 'learners', 'DELETE') AS d,
                  has_table_privilege('figbloom_app', 'learners', 'TRUNCATE') AS t`,
        );
        expect(r.rows[0]).toEqual({ d: false, t: false });
      });
    });
  });

  // ------------------------------------------------------------ review item T-1
  describe("T-1 the tenant WITH CHECK itself refuses a cross-tenant move (user triggers disabled)", () => {
    const TABLES = ["learners", "guardians", "guardian_links", "staff_members", "school_profiles", "directory_documents"];

    it("seeds a row in every table for tenant A", async () => {
      const staff = await req("POST", adminToken, `/v1/tenants/${A()}/staff`, { full_name: "T1 Staff", classification: "staff" });
      expect(staff.statusCode).toBe(201);
      const doc = await req("POST", adminToken, `/v1/tenants/${A()}/documents`, {
        subject_type: "learner",
        subject_id: learnerId,
        doc_type: "id_copy",
        file_name: "t1.pdf",
      });
      expect(doc.statusCode).toBe(201);
      await req("PATCH", adminToken, `/v1/tenants/${A()}/school-profile`, { county: "T1 County" });
      for (const t of TABLES) {
        const n = await ctx.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A()]);
        expect(n.rows[0]!.n, t).toBeGreaterThan(0);
      }
    });

    for (const table of TABLES) {
      it(`${table}: UPDATE ... SET tenant_id = <other tenant> is refused by RLS (42501), not by a trigger`, async () => {
        const owner = await ctx.pool.connect();
        try {
          await owner.query("BEGIN");
          // Remove every user trigger first, so only RLS (and constraints) can stop the write.
          await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
          // Migration 027's column grants would otherwise refuse `SET tenant_id` on their own
          // (also 42501), which would make this test pass without RLS doing anything. Granting
          // the column inside this transaction — rolled back with everything else — leaves RLS
          // as the only thing that can refuse the write, which is what T-1 exists to prove.
          await owner.query(`GRANT UPDATE (tenant_id) ON ${table} TO figbloom_app`);
          await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [A()]);
          await owner.query(`SET LOCAL ROLE figbloom_app`);
          const code = await sqlCode(owner.query(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id = $2`, [B(), A()]));
          expect(code).toBe("42501");
        } finally {
          await owner.query("ROLLBACK").catch(() => undefined);
          owner.release();
        }
      });
    }
  });
});
