import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { parse as parseYaml } from "yaml";
import { createTestApp, type FixtureIds } from "./support.js";
import { assertErrorShape } from "../src/openapi/contractAssert.js";
import { z } from "zod";
import {
  GUARDIAN_EMAIL_PATTERN,
  GUARDIAN_NAME_PATTERN,
  GUARDIAN_PHONE_PATTERN,
} from "../src/modules/directory/guardians.js";

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

async function loginLoginId(app: Ctx["app"], tenantId: string, loginId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/login-id",
    payload: { tenantId, loginId, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function bearer(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return headers;
}

/** Waits until some backend is blocked on a lock, so a race test knows its request reached the lock. */
async function waitForLockWaiter(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (r.rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no request waited on a lock: the active-learner check does not lock the learner row");
}

/** Error bodies carry a per-request correlation id (FIG-1620); parity checks compare everything else. */
function sansRequestId(body: { error?: Record<string, unknown> } & Record<string, unknown>) {
  if (!body.error) return body;
  const { request_id: _requestId, ...rest } = body.error;
  return { ...body, error: rest };
}

describe("VS-2 guardian directory create/read and learner links", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let adminBToken: string;
  let teacherToken: string;
  let parentToken: string;
  let learnerA1: string;
  let learnerA2: string;
  let learnerB1: string;
  let adminBId: string;

  async function createLearner(
    token: string,
    tenantId: string,
    admission_no: string,
    full_name: string,
  ): Promise<string> {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/learners`,
      headers: bearer(token, tenantId),
      payload: { admission_no, full_name, gender: "female" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().learner.id as string;
  }

  function postGuardian(token: string, tenantId: string, payload: unknown, pathTenant = tenantId) {
    return ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${pathTenant}/guardians`,
      headers: bearer(token, tenantId),
      payload: payload as Record<string, unknown>,
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;

    // A school_admin for tenant B so cross-tenant tests have a real second tenant actor.
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT gen_random_uuid(), 'admin-b@example.com', password_hash, 'Admin B', 'active'
       FROM users WHERE id = $1`,
      [ids.adminA],
    );
    const b = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin-b@example.com'`,
    );
    adminBId = b.rows[0]!.id;
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
       VALUES ($1, $2, 'school_admin', 'AD-0001')`,
      [adminBId, ids.tenantB],
    );

    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    adminBToken = await loginEmail(ctx.app, "admin-b@example.com");
    teacherToken = await loginLoginId(ctx.app, ids.tenantA, "TC-0001");
    parentToken = await loginLoginId(ctx.app, ids.tenantA, "PT-0001");

    learnerA1 = await createLearner(adminToken, ids.tenantA, "7001", "Wanjiku Kamau");
    learnerA2 = await createLearner(adminToken, ids.tenantA, "7002", "Otieno Kamau");
    learnerB1 = await createLearner(adminBToken, ids.tenantB, "7001", "Achieng Odhiambo");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("school_admin creates a guardian with an initial link and reads it back", async () => {
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Jane Kamau",
      phone: "0712 345 678",
      email: "jane.kamau@example.com",
      learners: [{ learner_id: learnerA1, relationship: "mother", is_primary_payer: true }],
    });
    expect(created.statusCode).toBe(201);
    const g = created.json().guardian;
    expect(g.tenantId).toBe(ids.tenantA);
    expect(g.links).toHaveLength(1);
    expect(g.links[0]).toMatchObject({
      learnerId: learnerA1,
      relationship: "mother",
      is_primary_payer: true,
      guardianId: g.id,
    });
    // F-2 / F-6: create echoes no contact details back to the caller.
    expect(g.full_name).toBeUndefined();
    expect(g.phone).toBeUndefined();
    expect(g.email).toBeUndefined();
    expect(JSON.stringify(g)).not.toMatch(/jane\.kamau|0712 345 678|Jane Kamau/);
    // No auth identity is created or exposed.
    expect(JSON.stringify(g)).not.toMatch(/password|user_id|login/i);

    const fetched = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${g.id}`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().guardian.id).toBe(g.id);
    expect(fetched.json().guardian.full_name).toBe("Jane Kamau");
    expect(fetched.json().guardian.phone).toBe("0712 345 678");
    // F-2: guardian read returns contact fields only — no linked learner ids.
    expect(fetched.json().guardian.links).toBeUndefined();
    expect(JSON.stringify(fetched.json())).not.toMatch(new RegExp(learnerA1, "i"));

    const users = await ctx.pool.query(`SELECT count(*)::int AS n FROM users WHERE full_name = 'Jane Kamau'`);
    expect(users.rows[0].n).toBe(0);
  });

  it("one guardian can be linked to multiple learners, on create and later", async () => {
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Peter Kamau",
      learners: [
        { learner_id: learnerA1, relationship: "father" },
        { learner_id: learnerA2, relationship: "father" },
      ],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().guardian.links).toHaveLength(2);
    expect(created.json().guardian.links.every((l: { is_primary_payer: boolean }) => !l.is_primary_payer)).toBe(true);

    const learnerA3 = await createLearner(adminToken, ids.tenantA, "7003", "Third Kamau");
    const link = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${created.json().guardian.id}/links`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: learnerA3, relationship: "guardian" },
    });
    expect(link.statusCode).toBe(201);
    expect(link.json().link.learnerId).toBe(learnerA3);

    const listed = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerA3}/guardians`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().guardians.map((x: { full_name: string }) => x.full_name)).toEqual(["Peter Kamau"]);
  });

  it("lists the guardians of a learner", async () => {
    const learner = await createLearner(adminToken, ids.tenantA, "7010", "Listed Learner");
    for (const [name, rel] of [
      ["Mary Listed", "mother"],
      ["John Listed", "father"],
    ] as const) {
      const res = await postGuardian(adminToken, ids.tenantA, {
        full_name: name,
        learners: [{ learner_id: learner, relationship: rel }],
      });
      expect(res.statusCode).toBe(201);
    }
    const list = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learner}/guardians`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(list.statusCode).toBe(200);
    const guardians = list.json().guardians as Array<{ full_name: string; relationship: string }>;
    expect(guardians.map((x) => x.full_name)).toEqual(["Mary Listed", "John Listed"]);
    expect(guardians.map((x) => x.relationship)).toEqual(["mother", "father"]);

    const empty = await createLearner(adminToken, ids.tenantA, "7011", "No Guardians");
    const none = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${empty}/guardians`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().guardians).toEqual([]);
  });

  it("area.people alone does not grant guardian contact access (F-6)", async () => {
    const grant = await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(adminToken, ids.tenantA),
      payload: { userId: ids.teacherA, areas: ["people"] },
    });
    expect(grant.statusCode).toBe(200);

    // VS-1 learner access still works via area.people.
    const learnerOk = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerA1}`,
      headers: bearer(teacherToken, ids.tenantA),
    });
    expect(learnerOk.statusCode).toBe(200);

    const seeded = await postGuardian(adminToken, ids.tenantA, {
      full_name: "People Area Seed",
      learners: [{ learner_id: learnerA1, relationship: "guardian" }],
    });
    expect(seeded.statusCode).toBe(201);
    const gid = seeded.json().guardian.id as string;

    const deniedCreate = await postGuardian(teacherToken, ids.tenantA, {
      full_name: "Staff Created",
      learners: [{ learner_id: learnerA1, relationship: "guardian" }],
    });
    expect(deniedCreate.statusCode).toBe(403);

    const deniedRead = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}`,
      headers: bearer(teacherToken, ids.tenantA),
    });
    expect(deniedRead.statusCode).toBe(403);

    await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(adminToken, ids.tenantA),
      payload: { userId: ids.teacherA, areas: [] },
    });
  });

  it("refuses unauthorized access on every operation with safe bodies", async () => {
    const seeded = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Protected Guardian",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    const gid = seeded.json().guardian.id as string;

    const attempts = [
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/guardians`,
        headers: bearer(parentToken, ids.tenantA),
        payload: { full_name: "X", learners: [{ learner_id: learnerA1, relationship: "mother" }] },
      }),
      ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/guardians/${gid}`,
        headers: bearer(parentToken, ids.tenantA),
      }),
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
        headers: bearer(parentToken, ids.tenantA),
        payload: { learner_id: learnerA2, relationship: "mother" },
      }),
      ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/learners/${learnerA1}/guardians`,
        headers: bearer(parentToken, ids.tenantA),
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(403);
      expect(assertErrorShape(res.json())).toEqual([]);
      expect(String(res.json().error.message)).not.toMatch(/sql|stack|postgres/i);
    }

    const noAuth = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}`,
    });
    expect(noAuth.statusCode).toBe(401);
    expect(assertErrorShape(noAuth.json())).toEqual([]);

    const forged = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians`,
      headers: bearer(parentToken, ids.tenantA),
      payload: {
        full_name: "Forged",
        learners: [{ learner_id: learnerA1, relationship: "mother" }],
        permissions: ["resource.guardian.write", "area.people"],
      },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.message).toMatch(/permissions/i);

    // No tenant context (super admin without a selected school).
    const superToken = await loginEmail(ctx.app, "super@example.com");
    const noTenant = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(noTenant.statusCode).toBe(403);
  });

  it("rejects creation without a learner and malformed input", async () => {
    const before = await ctx.pool.query(`SELECT count(*)::int AS n FROM guardians WHERE tenant_id = $1`, [ids.tenantA]);

    for (const payload of [
      { full_name: "No Learner" },
      { full_name: "Empty Learners", learners: [] },
      { full_name: "", learners: [{ learner_id: learnerA1, relationship: "mother" }] },
      { full_name: "Bad Rel", learners: [{ learner_id: learnerA1, relationship: "aunt" }] },
      { full_name: "Bad Id", learners: [{ learner_id: "not-a-uuid", relationship: "mother" }] },
      { full_name: "Bad Email", email: "nope", learners: [{ learner_id: learnerA1, relationship: "mother" }] },
      { full_name: "Bad Phone", phone: "abc", learners: [{ learner_id: learnerA1, relationship: "mother" }] },
      { full_name: "Extra Field", tenant_id: ids.tenantB, learners: [{ learner_id: learnerA1, relationship: "mother" }] },
    ]) {
      const res = await postGuardian(adminToken, ids.tenantA, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
      expect(assertErrorShape(res.json())).toEqual([]);
      expect(JSON.stringify(res.json())).not.toMatch(/INSERT|stack|pg_|zod/i);
    }

    // The same learner twice in one request is refused up front.
    const dupInBody = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Twice",
      learners: [
        { learner_id: learnerA1, relationship: "mother" },
        { learner_id: learnerA1, relationship: "father" },
      ],
    });
    expect(dupInBody.statusCode).toBe(400);

    // F-1: case-only duplicate learner ids must also return 400 (not 404).
    const dupCase = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Twice Case",
      learners: [
        { learner_id: learnerA1.toLowerCase(), relationship: "mother" },
        { learner_id: learnerA1.toUpperCase(), relationship: "father" },
      ],
    });
    expect(dupCase.statusCode).toBe(400);
    expect(dupCase.json().error.code).toBe("validation_error");

    const after = await ctx.pool.query(`SELECT count(*)::int AS n FROM guardians WHERE tenant_id = $1`, [ids.tenantA]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("refuses new guardian links to archived learners (F-4)", async () => {
    const archivedId = await createLearner(adminToken, ids.tenantA, "7099", "Archived Learner");
    await ctx.pool.query(
      `UPDATE learners SET active = false, archived_at = now() WHERE id = $1 AND tenant_id = $2`,
      [archivedId, ids.tenantA],
    );

    // F-3: archived and unknown learners produce the same response, so existence cannot be probed.
    const unknownId = "00000000-0000-4000-8000-00000000f003";
    const createOnArchived = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Archive Blocked",
      learners: [{ learner_id: archivedId, relationship: "mother" }],
    });
    const createOnUnknown = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Archive Blocked",
      learners: [{ learner_id: unknownId, relationship: "mother" }],
    });
    expect(createOnArchived.statusCode).toBe(404);
    expect(sansRequestId(createOnArchived.json())).toEqual(sansRequestId(createOnUnknown.json()));
    expect(createOnUnknown.statusCode).toBe(404);

    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Active Then Archive Link",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    expect(created.statusCode).toBe(201);
    const guardianPath = `/v1/tenants/${ids.tenantA}/guardians/${created.json().guardian.id}/links`;
    const linkArchived = await ctx.app.inject({
      method: "POST",
      url: guardianPath,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: archivedId, relationship: "guardian" },
    });
    const linkUnknown = await ctx.app.inject({
      method: "POST",
      url: guardianPath,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: unknownId, relationship: "guardian" },
    });
    expect(linkArchived.statusCode).toBe(404);
    expect(sansRequestId(linkArchived.json())).toEqual(sansRequestId(linkUnknown.json()));
    expect(JSON.stringify(linkArchived.json())).not.toMatch(/archiv/i);
  });

  it("treats learner ids that differ only in letter case as duplicates (F-1)", async () => {
    const before = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM guardians WHERE full_name = 'Case Dup Guardian' AND tenant_id = $1`,
      [ids.tenantA],
    );
    const dup = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Case Dup Guardian",
      learners: [
        { learner_id: learnerA1, relationship: "mother" },
        { learner_id: learnerA1.toUpperCase(), relationship: "father" },
      ],
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe("validation_error");
    const after = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM guardians WHERE full_name = 'Case Dup Guardian' AND tenant_id = $1`,
      [ids.tenantA],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    // The link route normalizes too: an upper-case id for an existing link is a clean conflict.
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Case Link Guardian",
      learners: [{ learner_id: learnerA2, relationship: "mother" }],
    });
    const linkDup = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${created.json().guardian.id}/links`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: learnerA2.toUpperCase(), relationship: "father" },
    });
    expect(linkDup.statusCode).toBe(409);
    expect(linkDup.json().error.code).toBe("conflict");
  });

  it("concurrent guardian creation: each request is all-or-nothing and nothing is duplicated", async () => {
    const [a, b] = await Promise.all([
      postGuardian(adminToken, ids.tenantA, {
        full_name: "Parallel Guardian One",
        learners: [{ learner_id: learnerA2, relationship: "mother" }],
      }),
      postGuardian(adminToken, ids.tenantA, {
        full_name: "Parallel Guardian Two",
        learners: [{ learner_id: learnerA2, relationship: "father" }],
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const idA = a.json().guardian.id as string;
    const idB = b.json().guardian.id as string;
    expect(idA).not.toBe(idB);
    const rows = await ctx.pool.query<{ id: string; n: number }>(
      `SELECT g.id, count(l.id)::int AS n
       FROM guardians g LEFT JOIN guardian_links l ON l.guardian_id = g.id
       WHERE g.id = ANY($1::uuid[])
       GROUP BY g.id`,
      [[idA, idB]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.n === 1)).toBe(true);
  });

  it("an archive that commits during a link request wins the race (F-4)", async () => {
    const target = await createLearner(adminToken, ids.tenantA, "7050", "Race Learner");
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Race Guardian",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    const gid = created.json().guardian.id as string;

    const archiver = await ctx.pool.connect();
    try {
      await archiver.query("BEGIN");
      await archiver.query(
        `UPDATE learners SET active = false, archived_at = now() WHERE id = $1 AND tenant_id = $2`,
        [target, ids.tenantA],
      );
      const linkP = ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
        headers: bearer(adminToken, ids.tenantA),
        payload: { learner_id: target, relationship: "guardian" },
      });
      try {
        await waitForLockWaiter(ctx.pool);
      } finally {
        await archiver.query("COMMIT");
      }
      const res = await linkP;
      expect(res.statusCode).toBe(404);
      const n = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guardian_links WHERE guardian_id = $1 AND learner_id = $2`,
        [gid, target],
      );
      expect(n.rows[0]!.n).toBe(0);
    } finally {
      archiver.release();
    }
  });

  it("the database refuses a link to an archived learner even when the application check is skipped (F-4)", async () => {
    const target = await createLearner(adminToken, ids.tenantA, "7051", "Guard Learner");
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Guard Guardian",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    const gid = created.json().guardian.id as string;
    await ctx.pool.query(
      `UPDATE learners SET active = false, archived_at = now() WHERE id = $1 AND tenant_id = $2`,
      [target, ids.tenantA],
    );
    const insert = `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
                    VALUES ($1, $2, $3, 'guardian')`;

    // Owner path.
    await expect(ctx.pool.query(insert, [ids.tenantA, gid, target])).rejects.toMatchObject({ code: "P0002" });

    // Application role path, with the tenant context the directory transactions set.
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.authz_mode', '', true)`,
        [ids.tenantA, ids.adminA],
      );
      await client.query("SET LOCAL ROLE figbloom_app");
      await expect(client.query(insert, [ids.tenantA, gid, target])).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const n = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM guardian_links WHERE guardian_id = $1 AND learner_id = $2`,
      [gid, target],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("refuses cross-tenant link attempts and leaves no guardian behind", async () => {
    const before = await ctx.pool.query(`SELECT count(*)::int AS n FROM guardians`);

    // Learner of tenant B referenced from tenant A's route: not found, not enumerable.
    const foreignLearner = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Cross Link",
      learners: [{ learner_id: learnerB1, relationship: "mother" }],
    });
    expect(foreignLearner.statusCode).toBe(404);
    const unknownLearner = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Cross Link",
      learners: [{ learner_id: "00000000-0000-4000-8000-000000000000", relationship: "mother" }],
    });
    expect(unknownLearner.statusCode).toBe(404);
    expect(sansRequestId(foreignLearner.json())).toEqual(sansRequestId(unknownLearner.json()));
    expect(assertErrorShape(foreignLearner.json())).toEqual([]);

    // One valid and one foreign learner: whole request refused, nothing persisted.
    const mixed = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Mixed Link",
      learners: [
        { learner_id: learnerA1, relationship: "mother" },
        { learner_id: learnerB1, relationship: "father" },
      ],
    });
    expect(mixed.statusCode).toBe(404);

    // Path tenant differs from the session tenant.
    const pathSwap = await postGuardian(
      adminToken,
      ids.tenantA,
      { full_name: "Path Swap", learners: [{ learner_id: learnerB1, relationship: "mother" }] },
      ids.tenantB,
    );
    expect(pathSwap.statusCode).toBe(403);

    // Linking an A guardian to a B learner via the link route.
    const own = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Own Guardian",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    const gid = own.json().guardian.id as string;
    const linkForeign = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: learnerB1, relationship: "mother" },
    });
    expect(linkForeign.statusCode).toBe(404);

    const after = await ctx.pool.query(`SELECT count(*)::int AS n FROM guardians`);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1); // only "Own Guardian"
    const names = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM guardians WHERE full_name IN ('Cross Link','Mixed Link','Path Swap')`,
    );
    expect(names.rows[0].n).toBe(0);
  });

  it("refuses cross-tenant reads and does not enumerate other tenants' records", async () => {
    const bGuardian = await postGuardian(adminBToken, ids.tenantB, {
      full_name: "Tenant B Guardian",
      learners: [{ learner_id: learnerB1, relationship: "mother" }],
    });
    expect(bGuardian.statusCode).toBe(201);
    const bId = bGuardian.json().guardian.id as string;

    // A admin, A path: B's guardian id is a plain 404.
    const readOther = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${bId}`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(readOther.statusCode).toBe(404);
    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/00000000-0000-4000-8000-000000000000`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(unknown.statusCode).toBe(404);
    expect(sansRequestId(readOther.json())).toEqual(sansRequestId(unknown.json()));

    // A admin pointed at B's path: 403.
    const pathB = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/guardians/${bId}`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(pathB.statusCode).toBe(403);

    // Listing guardians of B's learner from A: 404 (A path) or 403 (B path).
    const listOther = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerB1}/guardians`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(listOther.statusCode).toBe(404);
    const listB = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/learners/${learnerB1}/guardians`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(listB.statusCode).toBe(403);

    // Linking B's guardian from A's route: not found.
    const linkOther = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${bId}/links`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: learnerA1, relationship: "father" },
    });
    expect(linkOther.statusCode).toBe(404);

    // B's own list never contains A's guardians.
    const bList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/learners/${learnerB1}/guardians`,
      headers: bearer(adminBToken, ids.tenantB),
    });
    expect(bList.statusCode).toBe(200);
    expect(bList.json().guardians.map((x: { full_name: string }) => x.full_name)).toEqual(["Tenant B Guardian"]);
  });

  it("refuses duplicate guardian-learner relationships with a clean conflict", async () => {
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Dup Guardian",
      learners: [{ learner_id: learnerA2, relationship: "mother" }],
    });
    const gid = created.json().guardian.id as string;
    const dup = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: learnerA2, relationship: "father" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("conflict");
    expect(assertErrorShape(dup.json())).toEqual([]);
    expect(String(dup.json().error.message)).not.toMatch(/duplicate key|23505|constraint/i);

    const links = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM guardian_links WHERE guardian_id = $1`,
      [gid],
    );
    expect(links.rows[0].n).toBe(1);

    // The database itself also refuses it.
    await expect(
      ctx.pool.query(
        `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
         VALUES ($1, $2, $3, 'mother')`,
        [ids.tenantA, gid, learnerA2],
      ),
    ).rejects.toThrow(/guardian_links_guardian_learner_uniq/);
  });

  it("rolls back the guardian when the relationship insert fails", async () => {
    await ctx.pool.query(`
      CREATE FUNCTION vs2_fail_link() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'forced link failure'; END $$;
      CREATE TRIGGER vs2_fail_link_trg BEFORE INSERT ON guardian_links
        FOR EACH ROW EXECUTE FUNCTION vs2_fail_link();
    `);
    try {
      const res = await postGuardian(adminToken, ids.tenantA, {
        full_name: "Orphan Candidate",
        learners: [{ learner_id: learnerA1, relationship: "mother" }],
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("internal_error");
      expect(assertErrorShape(res.json())).toEqual([]);
      expect(JSON.stringify(res.json())).not.toMatch(/forced link failure|vs2_fail|stack|INSERT/i);
    } finally {
      await ctx.pool.query(`
        DROP TRIGGER vs2_fail_link_trg ON guardian_links;
        DROP FUNCTION vs2_fail_link();
      `);
    }
    const orphan = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM guardians WHERE full_name = 'Orphan Candidate'`,
    );
    expect(orphan.rows[0].n).toBe(0);
    const audit = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM security_audit_events
       WHERE event_type = 'directory.guardian.created' AND tenant_id = $1
         AND detail->>'guardianId' NOT IN (SELECT id::text FROM guardians)`,
      [ids.tenantA],
    );
    expect(audit.rows[0].n).toBe(0);
  });

  it("writes audit events without contact details", async () => {
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Audited Guardian",
      phone: "0799 111 222",
      email: "audited@example.com",
      learners: [{ learner_id: learnerA1, relationship: "guardian" }],
    });
    const gid = created.json().guardian.id as string;
    const link = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { learner_id: learnerA2, relationship: "guardian" },
    });
    expect(link.statusCode).toBe(201);

    const events = await ctx.pool.query<{ event_type: string; actor_user_id: string; detail: Record<string, unknown> }>(
      `SELECT event_type, actor_user_id, detail FROM security_audit_events
       WHERE tenant_id = $1 AND detail->>'guardianId' = $2
       ORDER BY occurred_at, id`,
      [ids.tenantA, gid],
    );
    expect(events.rows.map((e) => e.event_type)).toEqual([
      "directory.guardian.created",
      "directory.guardian.linked",
    ]);
    expect(events.rows[0]!.actor_user_id).toBe(ids.adminA);
    expect(events.rows[0]!.detail.learnerIds).toEqual([learnerA1]);
    expect(events.rows[1]!.detail).toMatchObject({ learnerId: learnerA2, relationship: "guardian" });
    const blob = JSON.stringify(events.rows.map((e) => e.detail));
    expect(blob).not.toMatch(/Audited Guardian|0799|audited@example/);
  });

  it("enforces figbloom_app least privilege and RLS on guardians and links", async () => {
    await ctx.pool.query(
      `INSERT INTO guardians (tenant_id, full_name) VALUES ($1, 'RLS Visible A'), ($2, 'RLS Hidden B')`,
      [ids.tenantA, ids.tenantB],
    );
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      await client.query(`SELECT set_config('app.authz_mode', '', true)`);

      const visible = await client.query(`SELECT full_name FROM guardians`);
      const names = visible.rows.map((r) => r.full_name as string);
      expect(names).toContain("RLS Visible A");
      expect(names).not.toContain("RLS Hidden B");

      const links = await client.query(`SELECT DISTINCT tenant_id FROM guardian_links`);
      expect(links.rows.map((r) => r.tenant_id)).toEqual([ids.tenantA]);

      for (const sql of [
        `DELETE FROM guardians WHERE full_name = 'RLS Visible A'`,
        `UPDATE guardians SET full_name = 'x'`,
        `DELETE FROM guardian_links`,
        `UPDATE guardian_links SET relationship = 'father'`,
        `TRUNCATE guardian_links`,
      ]) {
        await client.query("SAVEPOINT sp");
        await expect(client.query(sql)).rejects.toThrow(/permission denied/i);
        await client.query("ROLLBACK TO SAVEPOINT sp");
      }

      await client.query("SAVEPOINT sp_cross");
      await expect(
        client.query(`INSERT INTO guardians (tenant_id, full_name) VALUES ($1, 'Cross Insert')`, [ids.tenantB]),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT sp_cross");

      // A link may not join a tenant-A guardian to a tenant-B learner even with tenant A's id.
      // The F-4 guard runs before the composite foreign key and refuses it first; either refusal is acceptable.
      const gA = await client.query<{ id: string }>(`SELECT id FROM guardians WHERE full_name = 'RLS Visible A'`);
      await client.query("SAVEPOINT sp_fk");
      await expect(
        client.query(
          `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
           VALUES ($1, $2, $3, 'mother')`,
          [ids.tenantA, gA.rows[0]!.id, learnerB1],
        ),
      ).rejects.toThrow(/guardian_links_learner_fk|not an active learner/);
      await client.query("ROLLBACK TO SAVEPOINT sp_fk");
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      client.release();
    }

    const rls = await ctx.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('guardians','guardian_links')`,
    );
    expect(rls.rows).toHaveLength(2);
    for (const r of rls.rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });

  it("org_admin needs explicit guardian (+ learner read) delegation; area.people is not enough", async () => {
    const orgToken = await loginEmail(ctx.app, "orgadmin@example.com");
    const denied = await postGuardian(orgToken, ids.tenantA, {
      full_name: "Org Denied",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    expect(denied.statusCode).toBe(403);

    // F-6: area.people alone must not unlock guardian contact details.
    const peopleOnly = await ctx.app.inject({
      method: "POST",
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        delegateUserId: ids.orgAdmin,
        permissionCodes: ["area.people"],
      },
    });
    expect(peopleOnly.statusCode).toBe(200);
    const stillDenied = await postGuardian(orgToken, ids.tenantA, {
      full_name: "Org People Only",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    expect(stillDenied.statusCode).toBe(403);

    // Clear area.people so learner.read is not implied for the next check.
    const revokePeople = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        delegateUserId: ids.orgAdmin,
        permissionCodes: ["area.people"],
      },
    });
    expect(revokePeople.statusCode).toBe(200);

    // F-3: guardian.write without learner.read must not probe learner existence.
    const writeOnly = await ctx.app.inject({
      method: "POST",
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        delegateUserId: ids.orgAdmin,
        permissionCodes: ["resource.guardian.write"],
      },
    });
    expect(writeOnly.statusCode).toBe(200);
    const missingLearnerRead = await postGuardian(orgToken, ids.tenantA, {
      full_name: "Org Write Only",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    expect(missingLearnerRead.statusCode).toBe(403);

    const grant = await ctx.app.inject({
      method: "POST",
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        delegateUserId: ids.orgAdmin,
        permissionCodes: ["resource.guardian.read", "resource.learner.read"],
      },
    });
    expect(grant.statusCode).toBe(200);
    const created = await postGuardian(orgToken, ids.tenantA, {
      full_name: "Org Created",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    expect(created.statusCode).toBe(201);
    const readOk = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${created.json().guardian.id}`,
      headers: bearer(orgToken, ids.tenantA),
    });
    expect(readOk.statusCode).toBe(200);
    expect(readOk.json().guardian.links).toBeUndefined();
  });

  it("database unique constraint wins under concurrent link creates", async () => {
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Concurrent Guardian",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    expect(created.statusCode).toBe(201);
    const gid = created.json().guardian.id as string;

    const [a, b] = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
        headers: bearer(adminToken, ids.tenantA),
        payload: { learner_id: learnerA2, relationship: "father" },
      }),
      ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/guardians/${gid}/links`,
        headers: bearer(adminToken, ids.tenantA),
        payload: { learner_id: learnerA2, relationship: "guardian" },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const links = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM guardian_links WHERE guardian_id = $1 AND learner_id = $2`,
      [gid, learnerA2],
    );
    expect(links.rows[0]!.n).toBe(1);
  });

  it("database unique constraint wins under concurrent direct inserts", async () => {
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: "Concurrent Insert Guardian",
      learners: [{ learner_id: learnerA1, relationship: "mother" }],
    });
    const gid = created.json().guardian.id as string;
    const learnerA4 = await createLearner(adminToken, ids.tenantA, "7004", "Concurrent Learner");

    const results = await Promise.allSettled([
      ctx.pool.query(
        `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
         VALUES ($1, $2, $3, 'mother')`,
        [ids.tenantA, gid, learnerA4],
      ),
      ctx.pool.query(
        `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
         VALUES ($1, $2, $3, 'father')`,
        [ids.tenantA, gid, learnerA4],
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/guardian_links_guardian_learner_uniq|duplicate key/i);

    const links = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM guardian_links WHERE guardian_id = $1 AND learner_id = $2`,
      [gid, learnerA4],
    );
    expect(links.rows[0]!.n).toBe(1);
  });

  it("OpenAPI documents the VS-2 operations with authZ metadata", () => {
    const spec = parseYaml(readFileSync(join(process.cwd(), "openapi/openapi.yaml"), "utf8")) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown>; pattern?: string }> };
    };
    const cases: Array<[string, "get" | "post", string[]]> = [
      ["/v1/tenants/{tenantId}/guardians", "post", ["resource.guardian.write", "resource.learner.read"]],
      ["/v1/tenants/{tenantId}/guardians/{guardianId}", "get", ["resource.guardian.read"]],
      ["/v1/tenants/{tenantId}/guardians/{guardianId}/links", "post", ["resource.guardian.write", "resource.learner.read"]],
      [
        "/v1/tenants/{tenantId}/learners/{learnerId}/guardians",
        "get",
        ["resource.guardian.read", "resource.learner.read"],
      ],
    ];
    const routes = (ctx.app as { routeTable: Array<{ method: string; url: string }> }).routeTable;
    for (const [path, method, perms] of cases) {
      const op = spec.paths[path]?.[method];
      expect(op, `${method} ${path}`).toBeTruthy();
      expect(op!["x-figbloom-authz"]).toBe("permission");
      expect(op!["x-figbloom-permissions"]).toEqual(perms);
      const fastifyUrl = path.replace(/\{(\w+)\}/g, ":$1");
      expect(routes.some((r) => r.method === method.toUpperCase() && r.url === fastifyUrl)).toBe(true);
    }

    // F-5: phone and name rules are machine-readable constraints, not description-only.
    const createSchema = spec.components.schemas.CreateGuardianRequest as {
      properties: {
        full_name: { pattern?: string; minLength?: number; maxLength?: number };
        phone: { pattern?: string; minLength?: number; maxLength?: number };
        alt_phone: { pattern?: string; minLength?: number; maxLength?: number };
      };
    };
    expect(createSchema.properties.phone.pattern).toBe(GUARDIAN_PHONE_PATTERN);
    expect(createSchema.properties.phone.minLength).toBe(5);
    expect(createSchema.properties.phone.maxLength).toBe(32);
    expect(createSchema.properties.alt_phone.pattern).toBe(GUARDIAN_PHONE_PATTERN);
    expect(createSchema.properties.full_name.pattern).toBe(GUARDIAN_NAME_PATTERN);
    expect(spec.components.schemas.GuardianContact).toBeTruthy();
  });

  it("published phone and name rules agree with the backend on the same values (F-5)", async () => {
    const spec = parseYaml(readFileSync(join(process.cwd(), "openapi/openapi.yaml"), "utf8")) as {
      components: {
        schemas: {
          CreateGuardianRequest: {
            properties: Record<string, { pattern?: string; minLength?: number; maxLength?: number }>;
          };
        };
      };
    };
    const props = spec.components.schemas.CreateGuardianRequest.properties;
    const phoneRule = props.phone!;
    const nameRule = props.full_name!;
    // JSON Schema counts minLength / maxLength in Unicode code points, not UTF-16 units.
    const cp = (value: string) => Array.from(value).length;
    const accepts = (rule: { pattern?: string; minLength?: number; maxLength?: number }, value: string) =>
      new RegExp(rule.pattern!).test(value) &&
      cp(value) >= (rule.minLength ?? 0) &&
      cp(value) <= (rule.maxLength ?? Infinity);

    const phoneSamples = [
      "0712345678",
      "0712 345 678",
      "+254 712-345-678",
      "(020) 123",
      "12345",
      "1234",
      " 0712345678",
      "0712345678 ",
      "     ",
      "07123456789012345678901234567890123",
      "abc",
    ];
    for (const value of phoneSamples) {
      const res = await postGuardian(adminToken, ids.tenantA, {
        full_name: "Phone Probe",
        phone: value,
        learners: [{ learner_id: learnerA2, relationship: "guardian" }],
      });
      expect(res.statusCode === 201, `phone ${JSON.stringify(value)}`).toBe(accepts(phoneRule, value));
      if (res.statusCode !== 201) expect(res.statusCode, `phone ${JSON.stringify(value)}`).toBe(400);
    }

    const smile = String.fromCodePoint(0x1f600); // one code point, two UTF-16 units
    const nameSamples = [
      "A",
      "Jane Kamau",
      " A",
      "Jane ",
      "   ",
      "x".repeat(120),
      "x".repeat(121),
      smile.repeat(61), // 61 code points, 122 UTF-16 units: the original mismatch
      smile.repeat(120), // exactly at the limit
      smile.repeat(121), // one over
      smile.repeat(60) + "x".repeat(60), // mixed, at the limit
      smile.repeat(60) + "x".repeat(61), // mixed, one over
      "x".repeat(119) + smile, // astral character in the last position, at the limit
      "x".repeat(120) + smile, // one over
    ];
    for (const value of nameSamples) {
      const res = await postGuardian(adminToken, ids.tenantA, {
        full_name: value,
        learners: [{ learner_id: learnerA2, relationship: "guardian" }],
      });
      expect(res.statusCode === 201, `name ${JSON.stringify(value)}`).toBe(accepts(nameRule, value));
      if (res.statusCode !== 201) expect(res.statusCode, `name ${JSON.stringify(value)}`).toBe(400);
    }
  });

  it("published email rule is what the backend enforces, and does not weaken zod's email check", async () => {
    const spec = parseYaml(readFileSync(join(process.cwd(), "openapi/openapi.yaml"), "utf8")) as {
      components: {
        schemas: {
          CreateGuardianRequest: {
            properties: { email: { pattern?: string; maxLength?: number; format?: string } };
          };
        };
      };
    };
    const emailRule = spec.components.schemas.CreateGuardianRequest.properties.email;
    expect(emailRule.pattern).toBe(GUARDIAN_EMAIL_PATTERN);
    expect(emailRule.maxLength).toBe(254);

    const domain = "@example.com";
    const samples = [
      "jane.kamau@example.com",
      "a+b@x.co",
      "o'brien@example.org",
      "a_b-c@sub.example.co.ke",
      "nope",
      "",
      " jane@example.com",
      "jane@example.com ",
      "jane@example.com\n",
      "jane@@example.com",
      ".jane@example.com",
      "ja..ne@example.com",
      "jane.@example.com",
      "jane@example",
      "jane@example.c",
      "jane@-example.com",
      "jane doe@example.com",
      "jane@exámple.com",
      "a".repeat(254 - domain.length) + domain, // 254: at the limit
      "a".repeat(255 - domain.length) + domain, // 255: one over
    ];
    const zodEmail = z.email();
    for (const value of samples) {
      const publishedAccepts = new RegExp(emailRule.pattern!).test(value) && value.length <= emailRule.maxLength!;
      // The backend must not accept anything zod's own email check refuses (no weakening).
      if (new RegExp(emailRule.pattern!).test(value)) {
        expect(zodEmail.safeParse(value).success, `zod .email() on ${JSON.stringify(value)}`).toBe(true);
      } else {
        expect(zodEmail.safeParse(value).success, `zod .email() on ${JSON.stringify(value)}`).toBe(false);
      }
      const res = await postGuardian(adminToken, ids.tenantA, {
        full_name: "Email Probe",
        email: value,
        learners: [{ learner_id: learnerA2, relationship: "guardian" }],
      });
      expect(res.statusCode === 201, `email ${JSON.stringify(value)}`).toBe(publishedAccepts);
      if (res.statusCode !== 201) expect(res.statusCode, `email ${JSON.stringify(value)}`).toBe(400);
    }
  });

  it("counts name length in code points and stores accepted names unchanged", async () => {
    const smile = String.fromCodePoint(0x1f600);
    const accepted = smile.repeat(61) + " Kamau"; // 67 code points (128 UTF-16 units: over 120 if counted wrongly)
    const created = await postGuardian(adminToken, ids.tenantA, {
      full_name: accepted,
      learners: [{ learner_id: learnerA2, relationship: "guardian" }],
    });
    expect(created.statusCode).toBe(201);
    const gid = created.json().guardian.id as string;
    const read = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/guardians/${gid}`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(read.json().guardian.full_name).toBe(accepted); // no normalization, no truncation
    const stored = await ctx.pool.query<{ n: number; same: boolean }>(
      `SELECT char_length(full_name)::int AS n, full_name = $2 AS same FROM guardians WHERE id = $1`,
      [gid, accepted],
    );
    expect(stored.rows[0]).toEqual({ n: Array.from(accepted).length, same: true });

    const atLimit = smile.repeat(120);
    const ok = await postGuardian(adminToken, ids.tenantA, {
      full_name: atLimit,
      learners: [{ learner_id: learnerA2, relationship: "guardian" }],
    });
    expect(ok.statusCode).toBe(201);

    const over = await postGuardian(adminToken, ids.tenantA, {
      full_name: smile.repeat(121),
      learners: [{ learner_id: learnerA2, relationship: "guardian" }],
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe("validation_error");
    expect(assertErrorShape(over.json())).toEqual([]);
  });
});
