import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestApp, type FixtureIds } from "./support.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

function walkTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("password_hash access justification", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    adminToken = login.json().token as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("is required only on the identity authentication path and never returned by public APIs", async () => {
    const srcRoot = join(process.cwd(), "src");
    const hits = walkTs(srcRoot)
      .map((f) => ({ file: f, text: readFileSync(f, "utf8") }))
      .filter((f) => f.text.includes("password_hash"));
    const relative = hits.map((h) => h.file.split(/[/\\]src[/\\]/)[1]?.split("\\").join("/"));
    // Login / password-change only. loadUser deliberately omits the column.
    expect(relative).toEqual(["modules/auth/service.ts"]);

    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    expect(JSON.stringify(login.json())).not.toMatch(/password_hash|scrypt\$/);

    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(JSON.stringify(me.json())).not.toMatch(/password_hash|scrypt\$/);

    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": ids.tenantA,
      },
      payload: { admission_no: "PW-HASH", full_name: "No Hash", gender: "female" },
    });
    expect(learner.statusCode).toBe(201);
    expect(JSON.stringify(learner.json())).not.toMatch(/password_hash|scrypt\$/);
  });

  it("cannot be read by any statement; reachable only through exact-key functions; cannot be bulk-read; no INSERT", async () => {
    // F-C2 (migration 011): the runtime role has no SELECT on the column, however it is phrased.
    for (const sql of [
      `SELECT password_hash FROM users WHERE id = $1`,
      `SELECT * FROM users WHERE id = $1`,
      `SELECT u.* FROM users u WHERE u.id = $1`,
      `SELECT count(*) FROM users WHERE password_hash LIKE 'scrypt$%' AND id = $1`,
      `UPDATE users SET full_name = 'x' WHERE id = $1`,
    ]) {
      await expect(
        withIdentityAccess(ctx.runtimePool, (db) => db.query(sql, [ids.adminA])),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
    // Non-secret columns remain readable.
    const ok = await withIdentityAccess(ctx.runtimePool, (db) =>
      db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1`, [ids.adminA]),
    );
    expect(ok.rows[0]?.id).toBe(ids.adminA);

    // The exact-key functions are the only path, and they return one account per key.
    const byEmail = await withIdentityAccess(ctx.runtimePool, (db) =>
      db.query<{ password_hash: string }>(`SELECT password_hash FROM public.auth_credential_by_email($1)`, [
        "admin-a@example.com",
      ]),
    );
    expect(byEmail.rows).toHaveLength(1);
    expect(byEmail.rows[0]!.password_hash.startsWith("$argon2id$")).toBe(true);
    // Nothing enumerates: no key means no rows.
    const none = await withIdentityAccess(ctx.runtimePool, (db) =>
      db.query(`SELECT * FROM public.auth_credential_by_email($1)`, ["nobody@example.com"]),
    );
    expect(none.rows).toEqual([]);

    // Runtime cannot INSERT a new user (no INSERT grant on users).
    await expect(
      withIdentityAccess(ctx.runtimePool, (db) =>
        db.query(
          `INSERT INTO users (id, password_hash, full_name) VALUES (gen_random_uuid(), 'x', 'nope')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    // Tenant business path must not surface hashes via learner APIs (covered above).
    // Audit denial rows must not include the hash value.
    const before = await ctx.pool.query<{ detail: unknown }>(
      `SELECT detail FROM security_audit_events
       WHERE event_type = 'auth.login.failure'
       ORDER BY occurred_at DESC LIMIT 1`,
    );
    await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "wrong-password" },
    });
    const after = await ctx.pool.query<{ detail: unknown }>(
      `SELECT detail FROM security_audit_events
       WHERE event_type = 'auth.login.failure'
       ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(JSON.stringify(after.rows[0]?.detail ?? {})).not.toMatch(/scrypt\$|password_hash/);
    expect(after.rows[0]).not.toEqual(before.rows[0]);
  });
});
