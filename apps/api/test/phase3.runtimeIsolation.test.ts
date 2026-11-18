import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * F-03 — runtime database isolation for every Phase 3 personal-data table.
 *
 * Everything below runs as the real non-owner runtime role (figbloom_app) on a pooled connection.
 * Application query filters are deliberately absent: these tests prove what PostgreSQL itself
 * enforces when the application forgets a tenant filter, sets no tenant, or reuses a connection.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

interface Seeded {
  /** Row count the owner sees for each tenant (the ground truth). */
  a: number;
  b: number;
}

interface InventoryEntry {
  table: string;
  /** Seeds one row for the tenant as the OWNER and returns whatever later seeds need. */
  seed: (ctx: Ctx, tenantId: string, n: number, refs: Refs) => Promise<void>;
  /** A statement that tries to create a row for `tenantId` (used from the other tenant's context). */
  foreignInsert: (tenantId: string, refs: Refs) => { sql: string; params: unknown[] };
  /**
   * A no-op assignment on a column the runtime role may update. Default `tenant_id = tenant_id`; tables
   * with column-level UPDATE grants (migration 025) name an updatable column instead. The attempt to
   * move a row to another tenant must still fail, now with a permission error or WITH CHECK.
   */
  noopUpdate?: string;
}

interface Refs {
  learner: Record<string, string>;
  guardian: Record<string, string>;
  staff: Record<string, string>;
  /** The eligible teacher seeded for staff_resource_grants, per tenant. */
  teacher: Record<string, string>;
}

/**
 * The runtime-isolation inventory. Every tenant-owned personal-data table that Phase 3 introduced
 * or started writing must appear here (see the completeness tests below). Add a table to the
 * migrations without adding it here and `catalogue completeness` fails.
 */
const INVENTORY: InventoryEntry[] = [
  {
    table: "learners",
    noopUpdate: "updated_at = updated_at",
    seed: async (ctx, tenantId, n, refs) => {
      const r = await ctx.pool.query<{ id: string }>(
        `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
         VALUES ($1, $2, 'Iso Learner', 'female') RETURNING id`,
        [tenantId, `ISO-${n}-${tenantId.slice(0, 4)}`],
      );
      refs.learner[tenantId] = r.rows[0]!.id;
    },
    foreignInsert: (tenantId) => ({
      sql: `INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'ISO-X', 'X', 'male')`,
      params: [tenantId],
    }),
  },
  {
    table: "guardians",
    noopUpdate: "updated_at = updated_at",
    seed: async (ctx, tenantId, _n, refs) => {
      const r = await ctx.pool.query<{ id: string }>(
        `INSERT INTO guardians (tenant_id, full_name, phone) VALUES ($1, 'Iso Guardian', '0700000000') RETURNING id`,
        [tenantId],
      );
      refs.guardian[tenantId] = r.rows[0]!.id;
    },
    foreignInsert: (tenantId) => ({
      sql: `INSERT INTO guardians (tenant_id, full_name) VALUES ($1, 'X')`,
      params: [tenantId],
    }),
  },
  {
    table: "guardian_links",
    noopUpdate: "archived_at = archived_at",
    seed: async (ctx, tenantId, _n, refs) => {
      await ctx.pool.query(
        `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
         VALUES ($1, $2, $3, 'mother')`,
        [tenantId, refs.guardian[tenantId], refs.learner[tenantId]],
      );
    },
    foreignInsert: (tenantId, refs) => ({
      sql: `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
            VALUES ($1, $2, $3, 'father')`,
      params: [tenantId, refs.guardian[tenantId], refs.learner[tenantId]],
    }),
  },
  {
    table: "school_profiles",
    noopUpdate: "updated_at = updated_at",
    seed: async (ctx, tenantId) => {
      await ctx.pool.query(`INSERT INTO school_profiles (tenant_id, county) VALUES ($1, 'Iso County')`, [
        tenantId,
      ]);
    },
    foreignInsert: (tenantId) => ({
      sql: `INSERT INTO school_profiles (tenant_id, county) VALUES ($1, 'X') ON CONFLICT DO NOTHING`,
      params: [tenantId],
    }),
  },
  {
    table: "staff_members",
    noopUpdate: "updated_at = updated_at",
    seed: async (ctx, tenantId, _n, refs) => {
      const r = await ctx.pool.query<{ id: string }>(
        `INSERT INTO staff_members (tenant_id, full_name, phone) VALUES ($1, 'Iso Staff', '0700000001') RETURNING id`,
        [tenantId],
      );
      refs.staff[tenantId] = r.rows[0]!.id;
    },
    foreignInsert: (tenantId) => ({
      sql: `INSERT INTO staff_members (tenant_id, full_name) VALUES ($1, 'X')`,
      params: [tenantId],
    }),
  },
  {
    // Migration 025 (FIG-1614 Option D). The guard trigger needs an eligible teacher in the school.
    table: "staff_resource_grants",
    noopUpdate: "revoked_by = revoked_by",
    seed: async (ctx, tenantId, _n, refs) => {
      const teacher = tenantId === ctx.ids.tenantA ? ctx.ids.teacherA : ctx.ids.teacherB;
      refs.teacher[tenantId] = teacher;
      await ctx.pool.query(
        `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by)
         VALUES ($1, $2, 'resource.guardian.read', $3)`,
        [tenantId, teacher, ctx.ids.adminA],
      );
    },
    foreignInsert: (tenantId, refs) => ({
      // The foreign tenant's own teacher passes the guard trigger, so RLS WITH CHECK is what refuses it.
      sql: `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by)
            VALUES ($1, $2, 'resource.guardian.write', $2)`,
      params: [tenantId, refs.teacher[tenantId]],
    }),
  },
  {
    table: "directory_documents",
    noopUpdate: "updated_at = updated_at",
    seed: async (ctx, tenantId, _n, refs) => {
      await ctx.pool.query(
        `INSERT INTO directory_documents (tenant_id, subject_type, subject_id, doc_type, file_name)
         VALUES ($1, 'staff', $2, 'id_copy', 'iso.pdf')`,
        [tenantId, refs.staff[tenantId]],
      );
    },
    foreignInsert: (tenantId, refs) => ({
      sql: `INSERT INTO directory_documents (tenant_id, subject_type, subject_id, doc_type, file_name)
            VALUES ($1, 'staff', $2, 'x', 'x.pdf')`,
      params: [tenantId, refs.staff[tenantId]],
    }),
  },
];

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Tables created by migrations numbered `fromNumber` or higher (the Phase 3 range starts at 016). */
export function tablesCreatedFrom(fromNumber: number, dir = MIGRATIONS_DIR): string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f))) {
    if (Number(file.split("_")[0]) < fromNumber) continue;
    const sql = readFileSync(`${dir}${file}`, "utf8");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      tables.add(m[1]!.toLowerCase());
    }
  }
  return [...tables].sort();
}

/** Pure detector, exported so a negative control can prove it fires. */
export function missingFromInventory(created: string[], inventory: string[]): string[] {
  const have = new Set(inventory);
  return created.filter((t) => !have.has(t));
}

describe("F-03 runtime isolation of Phase 3 personal-data tables", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const refs: Refs = { learner: {}, guardian: {}, staff: {}, teacher: {} };
  const seeded = new Map<string, Seeded>();

  /** Run `fn` on a figbloom_app connection inside a rolled-back transaction with the given GUCs. */
  async function asRuntime<T>(
    gucs: Record<string, string | null>,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      for (const [name, value] of Object.entries(gucs)) {
        if (value !== null) await client.query(`SELECT set_config($1, $2, true)`, [name, value]);
      }
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  async function count(client: pg.PoolClient, table: string, where = ""): Promise<number> {
    const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`);
    return r.rows[0]!.n;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    for (const tenant of [ids.tenantA, ids.tenantB]) {
      for (const entry of INVENTORY) await entry.seed(ctx, tenant, 1, refs);
    }
    // Tenant A gets a second row everywhere it is cheap, so "own rows" is not a single-row fluke.
    await ctx.pool.query(
      `INSERT INTO staff_members (tenant_id, full_name) VALUES ($1, 'Iso Staff Two')`,
      [ids.tenantA],
    );
    for (const entry of INVENTORY) {
      const a = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${entry.table} WHERE tenant_id = $1`,
        [ids.tenantA],
      );
      const b = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${entry.table} WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      seeded.set(entry.table, { a: a.rows[0]!.n, b: b.rows[0]!.n });
    }
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("the fixture really has rows in both tenants for every inventoried table", () => {
    for (const entry of INVENTORY) {
      const s = seeded.get(entry.table)!;
      expect(s.a, `${entry.table} tenant A`).toBeGreaterThan(0);
      expect(s.b, `${entry.table} tenant B`).toBeGreaterThan(0);
    }
  });

  describe.each(INVENTORY.map((e) => [e.table, e] as const))("%s", (table, entry) => {
    it("an unfiltered SELECT returns only the current tenant's rows (omitted tenant filter)", async () => {
      const s = seeded.get(table)!;
      await asRuntime({ "app.tenant_id": ids.tenantA }, async (c) => {
        expect(await count(c, table)).toBe(s.a);
        expect(await count(c, table, `WHERE tenant_id = '${ids.tenantB}'`)).toBe(0);
        const tenants = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`);
        expect(tenants.rows.map((r) => r.tenant_id)).toEqual([ids.tenantA]);
      });
      await asRuntime({ "app.tenant_id": ids.tenantB }, async (c) => {
        expect(await count(c, table)).toBe(s.b);
        expect(await count(c, table, `WHERE tenant_id = '${ids.tenantA}'`)).toBe(0);
      });
    });

    it("missing, empty and malformed tenant context see nothing", async () => {
      await asRuntime({}, async (c) => expect(await count(c, table)).toBe(0));
      await asRuntime({ "app.tenant_id": "" }, async (c) => expect(await count(c, table)).toBe(0));
      await asRuntime({ "app.tenant_id": "not-a-uuid" }, async (c) => expect(await count(c, table)).toBe(0));
      await asRuntime({ "app.tenant_id": "00000000-0000-0000-0000-000000000000" }, async (c) =>
        expect(await count(c, table)).toBe(0),
      );
    });

    it("a client-controlled mode or user GUC does not widen access", async () => {
      const s = seeded.get(table)!;
      await asRuntime(
        {
          "app.tenant_id": ids.tenantA,
          "app.authz_mode": "bypass",
          "app.user_id": ids.superAdmin,
        },
        async (c) => expect(await count(c, table)).toBe(s.a),
      );
      // Turning row security off is not a way around it: PostgreSQL refuses the query outright.
      await asRuntime({ "app.tenant_id": ids.tenantA, row_security: "off" }, async (c) => {
        await expect(count(c, table)).rejects.toThrow(/row-level security policy/);
      });
      await asRuntime({ "app.authz_mode": "owner", "app.user_id": ids.superAdmin }, async (c) =>
        expect(await count(c, table)).toBe(0),
      );
    });

    it("cannot update another tenant's rows, even by naming them", async () => {
      await asRuntime({ "app.tenant_id": ids.tenantA }, async (c) => {
        const res = await c.query(`UPDATE ${table} SET ${entry.noopUpdate ?? "tenant_id = tenant_id"} WHERE tenant_id = $1`, [
          ids.tenantB,
        ]);
        expect(res.rowCount).toBe(0);
        // Moving an own row into the other tenant is refused by WITH CHECK.
        await expect(
          c.query(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id = $2`, [ids.tenantB, ids.tenantA]),
        ).rejects.toThrow();
      });
    });

    it("cannot create a row for another tenant", async () => {
      await asRuntime({ "app.tenant_id": ids.tenantA }, async (c) => {
        const { sql, params } = entry.foreignInsert(ids.tenantB, refs);
        let failed = false;
        try {
          await c.query(sql, params);
        } catch (err) {
          failed = true;
          // 42501 = RLS WITH CHECK; 23503 = the directory_documents subject guard fires first.
          expect(["42501", "23503"]).toContain((err as { code?: string }).code);
        }
        expect(failed, `${table} accepted a row for another tenant`).toBe(true);
      });
      // ...and nothing leaked in for the other tenant.
      const after = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(after.rows[0]!.n).toBe(seeded.get(table)!.b);
    });

    it("the runtime role holds no DELETE, TRUNCATE or ownership", async () => {
      await asRuntime({ "app.tenant_id": ids.tenantA }, async (c) => {
        await expect(c.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
      });
      const client = await ctx.runtimePool.connect();
      try {
        await expect(client.query(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: "42501" });
        await expect(client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(
          /must be owner|permission denied/i,
        );
        await expect(client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`)).rejects.toThrow(
          /must be owner|permission denied/i,
        );
      } finally {
        client.release();
      }
    });

    it("negative control: with RLS disabled the other tenant becomes visible (rolled back)", async () => {
      // Proves this suite can fail: remove the protection inside a transaction and the leak appears.
      const s = seeded.get(table)!;
      const client = await ctx.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        await client.query("SET LOCAL ROLE figbloom_app");
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
        expect(await count(client, table)).toBe(s.a + s.b);
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      await asRuntime({ "app.tenant_id": ids.tenantA }, async (c) => expect(await count(c, table)).toBe(s.a));
    });

    it("RLS is enabled and forced, with a tenant policy for the runtime role", async () => {
      const t = await ctx.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await ctx.pool.query<{ policyname: string; roles: string[]; qual: string; with_check: string }>(
        `SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      const tenantPolicy = policies.rows.find(
        (p) => p.roles.includes("figbloom_app") && /app_current_tenant_id/.test(p.qual ?? ""),
      );
      expect(tenantPolicy, `${table} has no figbloom_app tenant policy`).toBeTruthy();
      expect(tenantPolicy!.with_check).toMatch(/app_current_tenant_id/);
      // No policy may grant the runtime role access without the tenant predicate.
      for (const p of policies.rows) {
        if (p.roles.includes("figbloom_app")) expect(p.qual).toMatch(/app_current_tenant_id/);
      }
    });
  });

  describe("connection-pool context isolation", () => {
    function singleConnectionPool(): pg.Pool {
      return new pg.Pool({ connectionString: ctx.runtimeUrl, max: 1, application_name: "figbloom-iso-test" });
    }

    it("tenant context does not survive COMMIT or ROLLBACK on a reused connection", async () => {
      const pool = singleConnectionPool();
      try {
        const pids = new Set<number>();
        // Transaction 1 (tenant A) — committed.
        let c = await pool.connect();
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
        pids.add((await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        expect(await count(c, "staff_members")).toBeGreaterThan(0);
        await c.query("COMMIT");
        c.release();

        // Transaction 2, same connection, no context — must see nothing in ANY inventoried table.
        c = await pool.connect();
        pids.add((await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        await c.query("BEGIN");
        const leaked = await c.query<{ v: string | null }>(`SELECT current_setting('app.tenant_id', true) AS v`);
        expect(leaked.rows[0]!.v ?? "").toBe("");
        for (const entry of INVENTORY) expect(await count(c, entry.table), entry.table).toBe(0);
        await c.query("ROLLBACK");
        c.release();

        // Transaction 3 (tenant B) — rolled back; transaction 4 sees nothing again.
        c = await pool.connect();
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantB]);
        const only = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM staff_members`);
        expect(only.rows.map((r) => r.tenant_id)).toEqual([ids.tenantB]);
        await c.query("ROLLBACK");
        c.release();
        c = await pool.connect();
        expect(await count(c, "staff_members")).toBe(0);
        c.release();

        expect(pids.size).toBe(1); // proves the same backend connection was reused throughout
      } finally {
        await pool.end();
      }
    });

    it("interleaved transactions on a small shared pool never see each other's tenant", async () => {
      const pool = new pg.Pool({ connectionString: ctx.runtimeUrl, max: 3, application_name: "figbloom-iso-test" });
      try {
        const jobs = Array.from({ length: 40 }, (_, i) => async () => {
          const tenant = i % 2 === 0 ? ids.tenantA : ids.tenantB;
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
            await c.query(`SELECT pg_sleep($1)`, [Math.random() * 0.02]);
            const seen = new Set<string>();
            for (const entry of INVENTORY) {
              const r = await c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${entry.table}`);
              for (const row of r.rows) seen.add(row.tenant_id);
            }
            await c.query(i % 3 === 0 ? "ROLLBACK" : "COMMIT");
            return { tenant, seen: [...seen] };
          } finally {
            c.release();
          }
        });
        const results = await Promise.all(jobs.map((j) => j()));
        for (const r of results) expect(r.seen, `tenant ${r.tenant}`).toEqual([r.tenant]);
      } finally {
        await pool.end();
      }
    });
  });

  describe("catalogue completeness", () => {
    const PHASE3_FIRST_MIGRATION = 16;

    it("every table created from migration 016 on is in the runtime-isolation inventory", () => {
      const created = tablesCreatedFrom(PHASE3_FIRST_MIGRATION);
      expect(created.length).toBeGreaterThanOrEqual(3);
      expect(missingFromInventory(created, INVENTORY.map((e) => e.table))).toEqual([]);
    });

    it("the detector fires: a new table that is not inventoried is reported", () => {
      expect(missingFromInventory(["school_profiles", "phase3_new_table"], INVENTORY.map((e) => e.table))).toEqual([
        "phase3_new_table",
      ]);
    });

    it("the inventory also covers the pre-existing personal-data tables Phase 3 started writing", () => {
      const names = INVENTORY.map((e) => e.table);
      for (const t of ["learners", "guardians", "guardian_links"]) expect(names).toContain(t);
    });

    it("every tenant-owned table in the catalogue has ENABLE + FORCE RLS and a tenant policy", async () => {
      const rows = await ctx.pool.query<{ table_name: string }>(
        `SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          ORDER BY c.table_name`,
      );
      expect(rows.rowCount).toBeGreaterThan(10);
      const bad: string[] = [];
      // security_audit_events carries tenant_id for attribution but is an append-only log: the runtime
      // role has INSERT only (no SELECT/UPDATE/DELETE), which is stricter than RLS. Assert that instead.
      const EXEMPT_INSERT_ONLY = new Set(["security_audit_events"]);
      for (const table of EXEMPT_INSERT_ONLY) {
        const grants = await ctx.pool.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'figbloom_app'`,
          [table],
        );
        expect(grants.rows.map((r) => r.privilege_type)).toEqual(["INSERT"]);
      }
      for (const { table_name } of rows.rows) {
        if (EXEMPT_INSERT_ONLY.has(table_name)) continue;
        const flags = await ctx.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
            WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table_name],
        );
        const f = flags.rows[0];
        if (!f?.relrowsecurity || !f.relforcerowsecurity) bad.push(`${table_name}: RLS not enabled+forced`);
      }
      expect(bad).toEqual([]);
    });
  });
});
