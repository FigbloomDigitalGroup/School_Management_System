import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { parse as parseYaml } from "yaml";
import { createTestApp, type FixtureIds } from "./support.js";
import { ACCENT_MAX_LENGTH, ACCENT_PATTERN } from "../src/modules/directory/contact.js";

/**
 * Stage 8 — adversarial audit regression suite.
 *
 * These tests exist because the implementation pass's own tests did not catch the defects below.
 * Each one is written against a defect that was reproduced first (against the live PostgreSQL
 * catalogue as `figbloom_app`, or through the HTTP surface) and only then fixed:
 *
 *   A-01  `accent` accepted 33 characters while the CHECK allows 32 → SQLSTATE 23514, which is
 *         unmapped, so the API answered **500** instead of 400.
 *   A-02  `GuardianMutationResponse.oneOf` matched both branches for a full contact body, so a
 *         strict validator rejected every read-capable guardian write response.
 *   A-03  The database accepted an ACTIVE `guardian_links` row pointing at an ARCHIVED guardian.
 *         Only the application refused it, although the symmetric learner rule has been enforced
 *         in the database since migration 008.
 *   A-04  `logo_object_key` was revoked for UPDATE but INSERT is table-wide, so a first write
 *         could still store a client-chosen key.
 *   A-05  PATCHing an archived guardian answered 404, where learners and staff answer 400 with
 *         an instruction.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("Stage 8 adversarial audit", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let learnerId: string;
  let learner2Id: string;

  const A = () => ids.tenantA;
  const B = () => ids.tenantB;

  function bearer(token: string, tenantId: string): Record<string, string> {
    return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
  }

  async function req(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    token = adminToken,
    tenantId = A(),
  ) {
    return ctx.app.inject({ method, url, headers: bearer(token, tenantId), payload: payload as never });
  }

  async function newLearner(full_name: string, admission_no: string): Promise<string> {
    const r = await req("POST", `/v1/tenants/${A()}/learners`, { admission_no, full_name, gender: "female" });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().learner.id as string;
  }

  async function newGuardian(full_name: string, learners: string[]): Promise<string> {
    const r = await req("POST", `/v1/tenants/${A()}/guardians`, {
      full_name,
      learners: learners.map((learner_id) => ({ learner_id, relationship: "mother" })),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().guardian.id as string;
  }

  /** figbloom_app with tenant context, always rolled back. Exercises real privileges and RLS. */
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

  /**
   * Upper bound of a `char_length(...) <= N` CHECK, read from the live catalogue rather than from
   * the migration text, so the test measures what the database actually enforces.
   *
   * Handles both forms the migrations use — `char_length(col)` and
   * `char_length(TRIM(BOTH FROM col))` — and matches the column as a whole word so `phone` does
   * not also pick up `alt_phone`. Where several constraints bound the same column the tightest
   * one wins, because that is the one a request will hit first.
   */
  async function dbMaxLength(table: string, column: string): Promise<number> {
    const r = await ctx.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = $1::regclass AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%char_length%'`,
      [`public.${table}`],
    );
    const wholeWord = new RegExp(`\\b${column}\\b`);
    const bounds: number[] = [];
    for (const row of r.rows) {
      if (!wholeWord.test(row.def)) continue;
      for (const m of row.def.matchAll(/char_length\([^<>]*?\)\s*<=\s*(\d+)/g)) {
        bounds.push(Number(m[1]));
      }
    }
    expect(bounds.length, `${table}.${column} has no char_length upper bound`).toBeGreaterThan(0);
    return Math.min(...bounds);
  }

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
    learnerId = await newLearner("Audit Learner One", "AUD-0001");
    learner2Id = await newLearner("Audit Learner Two", "AUD-0002");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ======================================================= A-01 and its whole defect class
  describe("A-01 validation bounds never exceed the database CHECK (no request becomes a 500)", () => {
    it("the accent rule agrees with the school_profiles CHECK at the boundary", async () => {
      const dbMax = await dbMaxLength("school_profiles", "accent");
      expect(ACCENT_MAX_LENGTH, "ACCENT_MAX_LENGTH drifted from the CHECK").toBe(dbMax);

      // The exact value that produced a 500: pattern-valid, one over the CHECK.
      const overBound = `#${"a".repeat(dbMax - 1 + 1)}`;
      expect(overBound.length).toBe(dbMax + 1);
      const over = await req("PATCH", `/v1/tenants/${A()}/school-profile`, { accent: overBound });
      expect(over.statusCode, `accent of ${overBound.length} chars`).toBe(400);
      expect(over.json().error.code).toBe("validation_error");

      // Exactly at the bound still works, from both forms.
      for (const ok of [`#${"a".repeat(dbMax - 1)}`, "b".repeat(dbMax)]) {
        expect(ok.length).toBe(dbMax);
        const r = await req("PATCH", `/v1/tenants/${A()}/school-profile`, { accent: ok });
        expect(r.statusCode, `accent of ${ok.length} chars`).toBe(200);
        expect(r.json().schoolProfile.accent).toBe(ok);
      }
      // The published pattern must itself be incapable of producing an over-length value.
      expect(new RegExp(ACCENT_PATTERN).test(overBound)).toBe(false);
    });

    /**
     * The generic form of A-01. For every directory text column that carries a length CHECK, a
     * value one character over that bound must be refused by validation (400) and must never
     * reach the database, where an unmapped 23514 becomes a 500. The payloads use each field's
     * own permitted character set so a pattern cannot reject them for the wrong reason.
     */
    const OVER_BOUND: Array<{
      label: string;
      table: string;
      column: string;
      method: "POST" | "PATCH";
      url: (t: string) => string;
      body: (over: string) => Record<string, unknown>;
      fill: string;
    }> = [
      {
        label: "learners.admission_no",
        table: "learners",
        column: "admission_no",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/learners`,
        body: (v) => ({ admission_no: v, full_name: "Bound Probe", gender: "female" }),
        fill: "A",
      },
      {
        label: "learners.full_name",
        table: "learners",
        column: "full_name",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/learners`,
        body: (v) => ({ admission_no: "BOUND-LN", full_name: v, gender: "female" }),
        fill: "N",
      },
      {
        label: "guardians.full_name",
        table: "guardians",
        column: "full_name",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/guardians`,
        body: (v) => ({ full_name: v, learners: [] as unknown[] }),
        fill: "G",
      },
      {
        label: "staff_members.full_name",
        table: "staff_members",
        column: "full_name",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/staff`,
        body: (v) => ({ full_name: v }),
        fill: "S",
      },
      {
        label: "staff_members.staff_title",
        table: "staff_members",
        column: "staff_title",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/staff`,
        body: (v) => ({ full_name: "Bound Title", staff_title: v }),
        fill: "T",
      },
      {
        label: "staff_members.phone",
        table: "staff_members",
        column: "phone",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/staff`,
        body: (v) => ({ full_name: "Bound Phone", phone: v }),
        fill: "7",
      },
      {
        label: "staff_members.email",
        table: "staff_members",
        column: "email",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/staff`,
        body: (v) => ({ full_name: "Bound Email", email: `${v.slice(0, v.length - 12)}@example.com` }),
        fill: "e",
      },
      {
        label: "school_profiles.county",
        table: "school_profiles",
        column: "county",
        method: "PATCH",
        url: (t) => `/v1/tenants/${t}/school-profile`,
        body: (v) => ({ county: v }),
        fill: "C",
      },
      {
        label: "school_profiles.level",
        table: "school_profiles",
        column: "level",
        method: "PATCH",
        url: (t) => `/v1/tenants/${t}/school-profile`,
        body: (v) => ({ level: v }),
        fill: "L",
      },
      {
        label: "school_profiles.moe_registration",
        table: "school_profiles",
        column: "moe_registration",
        method: "PATCH",
        url: (t) => `/v1/tenants/${t}/school-profile`,
        body: (v) => ({ moe_registration: v }),
        fill: "M",
      },
      {
        label: "school_profiles.contact_phone",
        table: "school_profiles",
        column: "contact_phone",
        method: "PATCH",
        url: (t) => `/v1/tenants/${t}/school-profile`,
        body: (v) => ({ contact_phone: v }),
        fill: "7",
      },
      {
        label: "directory_documents.doc_type",
        table: "directory_documents",
        column: "doc_type",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/documents`,
        body: (v) => ({ subject_type: "learner", subject_id: learnerId, doc_type: v, file_name: "b.pdf" }),
        fill: "D",
      },
      {
        label: "directory_documents.file_name",
        table: "directory_documents",
        column: "file_name",
        method: "POST",
        url: (t) => `/v1/tenants/${t}/documents`,
        body: (v) => ({ subject_type: "learner", subject_id: learnerId, doc_type: "bound", file_name: v }),
        fill: "f",
      },
    ];

    for (const c of OVER_BOUND) {
      it(`${c.label}: one character over the CHECK is a 400, never a 5xx`, async () => {
        const dbMax = await dbMaxLength(c.table, c.column);
        const over = c.fill.repeat(dbMax + 1);
        const body = c.body(over);
        if (c.label === "guardians.full_name") body.learners = [{ learner_id: learnerId, relationship: "mother" }];
        const res = await req(c.method, c.url(A()), body);
        expect(res.statusCode, `${c.label} (${dbMax + 1} chars) -> ${res.body}`).toBeLessThan(500);
        expect(res.statusCode, c.label).toBe(400);
      });
    }
  });

  // ================================================================================ A-02
  it("A-02 the guardian write-response oneOf is satisfiable by exactly one branch", async () => {
    const spec = parseYaml(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8")) as any;
    const ack = spec.components.schemas.GuardianWriteAck;
    const contact = spec.components.schemas.GuardianContact;
    // Without additionalProperties:false a full contact body satisfies BOTH branches.
    expect(ack.additionalProperties).toBe(false);

    const g = await newGuardian("OneOf Guardian", [learnerId]);
    const read = await req("GET", `/v1/tenants/${A()}/guardians/${g}`);
    const body = read.json().guardian as Record<string, unknown>;
    const matchesAck =
      ack.required.every((k: string) => k in body) &&
      Object.keys(body).every((k) => k in ack.properties);
    const matchesContact = contact.required.every((k: string) => k in body);
    expect(matchesContact).toBe(true);
    expect(matchesAck, "a full contact body must NOT also satisfy GuardianWriteAck").toBe(false);
  });

  // ================================================================================ A-03
  describe("A-03 a live guardian relationship requires an active guardian, enforced by the database", () => {
    it("the runtime role cannot insert an active link onto an archived guardian", async () => {
      const g = await newGuardian("DB Guard Guardian", [learnerId]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);

      // Directly as figbloom_app: no application code is involved, so only the trigger can refuse.
      const code = await asRuntime(A(), (c) =>
        sqlCode(
          c.query(
            `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship)
             VALUES ($1, $2, $3, 'father')`,
            [A(), g, learner2Id],
          ),
        ),
      );
      expect(code, "archived guardian must be refused by the database").toBe("P0002");
    });

    it("the runtime role cannot un-archive a link onto an archived guardian", async () => {
      const g = await newGuardian("DB Unarchive Guardian", [learnerId]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      const link = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM guardian_links WHERE guardian_id = $1 LIMIT 1`,
        [g],
      );
      // As the OWNER, which holds every privilege: only the trigger can stop this.
      const code = await sqlCode(
        ctx.pool.query(`UPDATE guardian_links SET archived_at = NULL WHERE id = $1`, [link.rows[0]!.id]),
      );
      expect(code).toBe("P0002");
    });

    it("control: an active guardian and an active learner still link normally", async () => {
      const g = await newGuardian("Control Guardian", [learnerId]);
      const ok = await req("POST", `/v1/tenants/${A()}/guardians/${g}/links`, {
        learner_id: learner2Id,
        relationship: "father",
      });
      expect(ok.statusCode, ok.body).toBe(201);
    });

    it("archiving is always permitted, including for an already-archived learner", async () => {
      const l = await newLearner("Archive Both Sides", "AUD-BOTH");
      const g = await newGuardian("Archive Both Guardian", [l]);
      expect((await req("POST", `/v1/tenants/${A()}/learners/${l}/archive`)).statusCode).toBe(200);
      // The link now points at an archived learner; unlinking it must still work.
      const link = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM guardian_links WHERE guardian_id = $1 AND learner_id = $2`,
        [g, l],
      );
      const unlink = await req(
        "POST",
        `/v1/tenants/${A()}/guardians/${g}/links/${link.rows[0]!.id}/archive`,
      );
      expect(unlink.statusCode, unlink.body).toBe(200);
      // And archiving the guardian afterwards must still work.
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
    });

    it("the invariant holds across the whole table: no active link references an archived guardian or learner", async () => {
      const bad = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM guardian_links l
           JOIN guardians g ON g.id = l.guardian_id
           JOIN learners  r ON r.id = l.learner_id
          WHERE l.archived_at IS NULL AND (g.active = false OR r.active = false)`,
      );
      expect(bad.rows[0]!.n, "active links on archived parties").toBe(0);
    });
  });

  // ================================================================================ A-04
  describe("A-04 the school logo key is server-owned on every write path", () => {
    it("a client-shaped key supplied on INSERT by the runtime role is discarded", async () => {
      await ctx.pool.query(`DELETE FROM school_profiles WHERE tenant_id = $1`, [B()]);
      const stored = await asRuntime(B(), async (c) => {
        await c.query(
          `INSERT INTO school_profiles (tenant_id, logo_object_key) VALUES ($1, $2)`,
          [B(), `obj/${B()}/${"a".repeat(64)}`],
        );
        const r = await c.query<{ logo_object_key: string | null }>(
          `SELECT logo_object_key FROM school_profiles WHERE tenant_id = $1`,
          [B()],
        );
        return r.rows[0]!.logo_object_key;
      });
      expect(stored, "INSERT must not be a way to set a logo key").toBeNull();
    });

    it("UPDATE of the column remains revoked, and the API neither accepts nor returns it", async () => {
      const priv = await ctx.pool.query<{ upd: boolean }>(
        `SELECT has_column_privilege('figbloom_app','public.school_profiles','logo_object_key','UPDATE') AS upd`,
      );
      expect(priv.rows[0]?.upd).toBe(false);
      const sent = await req("PATCH", `/v1/tenants/${A()}/school-profile`, {
        logo_object_key: `obj/${A()}/${"a".repeat(64)}`,
      });
      expect(sent.statusCode).toBe(400);
      const got = await req("GET", `/v1/tenants/${A()}/school-profile`);
      expect(got.body).not.toContain("logo_object_key");
    });
  });

  // ================================================================================ A-05
  it("A-05 PATCHing an archived guardian answers like an archived learner and staff member", async () => {
    const g = await newGuardian("Archived Patch Guardian", [learnerId]);
    expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
    const patched = await req("PATCH", `/v1/tenants/${A()}/guardians/${g}`, { full_name: "New Name" });
    expect(patched.statusCode, patched.body).toBe(400);
    expect(patched.json().error.message).toMatch(/restore first/i);

    // The same shape for the other two entities, so the lifecycle really is uniform.
    const l = await newLearner("Archived Patch Learner", "AUD-APL");
    expect((await req("POST", `/v1/tenants/${A()}/learners/${l}/archive`)).statusCode).toBe(200);
    const pl = await req("PATCH", `/v1/tenants/${A()}/learners/${l}`, { full_name: "New Name" });
    expect(pl.statusCode).toBe(400);
    expect(pl.json().error.message).toMatch(/restore first/i);

    const s = await req("POST", `/v1/tenants/${A()}/staff`, { full_name: "Archived Patch Staff" });
    const sid = s.json().staff.id as string;
    expect((await req("POST", `/v1/tenants/${A()}/staff/${sid}/archive`)).statusCode).toBe(200);
    const ps = await req("PATCH", `/v1/tenants/${A()}/staff/${sid}`, { full_name: "New Name" });
    expect(ps.statusCode).toBe(400);
    expect(ps.json().error.message).toMatch(/restore first/i);

    // And the archived guardian's stored name is genuinely unchanged.
    const row = await ctx.pool.query<{ full_name: string }>(`SELECT full_name FROM guardians WHERE id = $1`, [g]);
    expect(row.rows[0]!.full_name).toBe("Archived Patch Guardian");
  });

  // ===================================================== guardian lifecycle, challenged further
  describe("guardian lifecycle under adverse conditions", () => {
    /**
     * Isolates the `g.active = true` filter in `listGuardiansForLearnerPage`.
     *
     * The test below it ("disappears from the learner's guardian list") does NOT isolate that
     * filter: archiving a guardian also archives its links, so the row is already excluded by
     * `l.archived_at IS NULL` and the test passes with the guardian filter deleted. A mutation
     * check proved exactly that, so this test builds the one state in which the two filters
     * disagree — a LIVE link on an ARCHIVED guardian.
     *
     * That state is not reachable through the API, and since migration 028 it cannot be created
     * by inserting or un-archiving a link either. It is still reachable by archiving the guardian
     * directly without the application's cascade, which is what this test does as the table owner,
     * because the archive cascade's ordering (guardian first, then its links) means a trigger on
     * `guardians` could not forbid it without breaking the cascade itself. The read-path filter is
     * therefore the compensating control, and this test is what holds it in place.
     */
    it("an archived guardian is hidden from a learner's list even if a live link survives", async () => {
      const l = await newLearner("Live Link Learner", "AUD-LIVE");
      const g = await newGuardian("Live Link Guardian", [l]);

      // Archive the guardian WITHOUT the application cascade, so the link stays live.
      await ctx.pool.query(
        `UPDATE guardians SET active = false, archived_at = now() WHERE id = $1`,
        [g],
      );
      const live = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guardian_links
          WHERE guardian_id = $1 AND archived_at IS NULL`,
        [g],
      );
      expect(live.rows[0]!.n, "fixture must leave the link live").toBe(1);

      const list = await req("GET", `/v1/tenants/${A()}/learners/${l}/guardians`);
      expect(list.statusCode).toBe(200);
      expect(
        list.json().items.map((x: { id: string }) => x.id),
        "an archived guardian must never be listed for a learner",
      ).not.toContain(g);
    });

    it("an archived guardian disappears from the learner's guardian list and cannot be re-linked", async () => {
      const l = await newLearner("Hidden Guardian Learner", "AUD-HID");
      const g = await newGuardian("Soon Archived", [l]);
      const before = await req("GET", `/v1/tenants/${A()}/learners/${l}/guardians`);
      expect(before.json().items.map((x: { id: string }) => x.id)).toContain(g);

      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      const after = await req("GET", `/v1/tenants/${A()}/learners/${l}/guardians`);
      expect(after.json().items.map((x: { id: string }) => x.id)).not.toContain(g);

      // Adding a link to it is a 404 that does not distinguish archived from non-existent (F-3).
      const relink = await req("POST", `/v1/tenants/${A()}/guardians/${g}/links`, {
        learner_id: learner2Id,
        relationship: "father",
      });
      expect(relink.statusCode).toBe(404);
      const unknown = await req(
        "POST",
        `/v1/tenants/${A()}/guardians/00000000-0000-0000-0000-000000000000/links`,
        { learner_id: learner2Id, relationship: "father" },
      );
      expect(unknown.statusCode).toBe(404);
      expect(relink.json().error.message).toBe(unknown.json().error.message);
    });

    it("a suspended school permits no lifecycle transition at all", async () => {
      const g = await newGuardian("Suspended School Guardian", [learnerId]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [A()]);
      try {
        for (const url of [
          `/v1/tenants/${A()}/guardians/${g}/restore`,
          `/v1/tenants/${A()}/guardians/${g}/archive`,
          `/v1/tenants/${A()}/learners/${learnerId}/archive`,
        ]) {
          const r = await req("POST", url);
          expect(r.statusCode, url).toBe(403);
        }
        const still = await ctx.pool.query<{ active: boolean }>(
          `SELECT active FROM guardians WHERE id = $1`,
          [g],
        );
        expect(still.rows[0]!.active, "no state changed while suspended").toBe(false);
      } finally {
        await ctx.pool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [A()]);
      }
    });

    it("concurrent archive and restore converge on a state that satisfies the invariant", async () => {
      const l = await newLearner("Race Lifecycle Learner", "AUD-RACE");
      const g = await newGuardian("Race Lifecycle Guardian", [l]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);

      // Fire both at once; either order is legal, the resulting state must not be.
      const [restore, archive] = await Promise.all([
        req("POST", `/v1/tenants/${A()}/guardians/${g}/restore`),
        req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`),
      ]);
      for (const r of [restore, archive]) {
        expect(r.statusCode, `unexpected ${r.statusCode}: ${r.body}`).toBeLessThan(500);
      }

      const state = await ctx.pool.query<{ active: boolean; live_links: number }>(
        `SELECT g.active,
                (SELECT count(*)::int FROM guardian_links l
                  WHERE l.guardian_id = g.id AND l.archived_at IS NULL) AS live_links
           FROM guardians g WHERE g.id = $1`,
        [g],
      );
      const { active, live_links } = state.rows[0]!;
      // The invariant: an archived guardian has no live relationships.
      if (!active) expect(live_links, "archived guardian with live links").toBe(0);
      else expect(live_links).toBeGreaterThanOrEqual(0);
    });

    it("restore and archive audit events carry counts and ids only, never contact details", async () => {
      const g = await newGuardian("Audit Trail Guardian", [learnerId, learner2Id]);
      await req("PATCH", `/v1/tenants/${A()}/guardians/${g}`, {
        phone: "0799111222",
        email: "audit.trail@example.com",
      });
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/restore`)).statusCode).toBe(200);

      const events = await ctx.pool.query<{ event_type: string; detail: Record<string, unknown> }>(
        `SELECT event_type, detail FROM security_audit_events
          WHERE tenant_id = $1 AND detail->>'guardianId' = $2
          ORDER BY occurred_at, id`,
        [A(), g],
      );
      expect(events.rows.map((e) => e.event_type)).toEqual([
        "directory.guardian.created",
        "directory.guardian.updated",
        "directory.guardian.archived",
        "directory.guardian.restored",
      ]);
      const blob = JSON.stringify(events.rows.map((e) => e.detail));
      expect(blob).not.toMatch(/Audit Trail Guardian|0799111222|audit\.trail@/);
      const archived = events.rows.find((e) => e.event_type === "directory.guardian.archived")!;
      const restored = events.rows.find((e) => e.event_type === "directory.guardian.restored")!;
      expect(archived.detail.linksArchived).toBe(2);
      expect(restored.detail).toMatchObject({ linksRestored: 2, linksHeldBack: 0 });
    });
  });

  // ============================================================= cross-tenant, still adversarial
  describe("cross-tenant isolation of every Stage 8 lifecycle transition", () => {
    it("no directory write reaches another tenant's row, whatever id is supplied", async () => {
      const foreign = await ctx.pool.query<{ g: string; l: string; s: string }>(
        `WITH g AS (INSERT INTO guardians (tenant_id, full_name) VALUES ($1,'Foreign G') RETURNING id),
              l AS (INSERT INTO learners (tenant_id, admission_no, full_name, gender)
                    VALUES ($1,'AUD-FGN','Foreign L','male') RETURNING id),
              s AS (INSERT INTO staff_members (tenant_id, full_name) VALUES ($1,'Foreign S') RETURNING id)
         SELECT g.id AS g, l.id AS l, s.id AS s FROM g, l, s`,
        [B()],
      );
      const { g, l, s } = foreign.rows[0]!;
      const attempts: Array<[string, Record<string, unknown> | undefined]> = [
        [`/v1/tenants/${A()}/guardians/${g}/archive`, undefined],
        [`/v1/tenants/${A()}/guardians/${g}/restore`, undefined],
        [`/v1/tenants/${A()}/learners/${l}/archive`, undefined],
        [`/v1/tenants/${A()}/learners/${l}/restore`, undefined],
        [`/v1/tenants/${A()}/staff/${s}/archive`, undefined],
        [`/v1/tenants/${A()}/staff/${s}/restore`, undefined],
      ];
      for (const [url] of attempts) {
        const r = await req("POST", url);
        expect(r.statusCode, url).toBe(404);
      }
      for (const [url, body] of [
        [`/v1/tenants/${A()}/guardians/${g}`, { full_name: "Hijacked" }],
        [`/v1/tenants/${A()}/learners/${l}`, { full_name: "Hijacked" }],
        [`/v1/tenants/${A()}/staff/${s}`, { full_name: "Hijacked" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await req("PATCH", url, body);
        expect(r.statusCode, url).toBe(404);
      }
      // Nothing in tenant B changed.
      const after = await ctx.pool.query<{ gn: string; ln: string; sn: string; ga: boolean }>(
        `SELECT (SELECT full_name FROM guardians WHERE id=$1) AS gn,
                (SELECT full_name FROM learners  WHERE id=$2) AS ln,
                (SELECT full_name FROM staff_members WHERE id=$3) AS sn,
                (SELECT active    FROM guardians WHERE id=$1) AS ga`,
        [g, l, s],
      );
      expect(after.rows[0]).toEqual({ gn: "Foreign G", ln: "Foreign L", sn: "Foreign S", ga: true });
    });

    it("a guardian cannot be linked to a learner of another tenant", async () => {
      const foreignLearner = await ctx.pool.query<{ id: string }>(
        `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
         VALUES ($1,'AUD-XLN','Cross Learner','female') RETURNING id`,
        [B()],
      );
      const g = await newGuardian("Cross Link Guardian", [learnerId]);
      const r = await req("POST", `/v1/tenants/${A()}/guardians/${g}/links`, {
        learner_id: foreignLearner.rows[0]!.id,
        relationship: "father",
      });
      expect(r.statusCode).toBe(404);
      const n = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guardian_links WHERE learner_id = $1`,
        [foreignLearner.rows[0]!.id],
      );
      expect(n.rows[0]!.n).toBe(0);
    });
  });

  // ================================================== runtime privileges, verified in the catalogue
  it("the runtime role holds no privilege on any identity, provenance or storage column", async () => {
    const protectedColumns: Array<[string, string, "UPDATE" | "INSERT"]> = [
      ["learners", "id", "UPDATE"],
      ["learners", "tenant_id", "UPDATE"],
      ["learners", "created_at", "UPDATE"],
      ["learners", "created_by", "UPDATE"],
      ["guardians", "id", "UPDATE"],
      ["guardians", "created_at", "UPDATE"],
      ["guardian_links", "guardian_id", "UPDATE"],
      ["guardian_links", "learner_id", "UPDATE"],
      ["guardian_links", "relationship", "UPDATE"],
      ["guardian_links", "is_primary_payer", "UPDATE"],
      ["staff_members", "id", "UPDATE"],
      ["staff_members", "created_by", "UPDATE"],
      ["school_profiles", "logo_object_key", "UPDATE"],
      ["directory_documents", "storage_key", "UPDATE"],
      ["directory_documents", "storage_status", "UPDATE"],
      ["directory_documents", "subject_id", "UPDATE"],
      ["directory_documents", "uploaded_by", "UPDATE"],
    ];
    for (const [table, column, priv] of protectedColumns) {
      const r = await ctx.pool.query<{ ok: boolean }>(
        `SELECT has_column_privilege('figbloom_app', $1, $2, $3) AS ok`,
        [`public.${table}`, column, priv],
      );
      expect(r.rows[0]?.ok, `${table}.${column} ${priv}`).toBe(false);
    }

    // The two columns where INSERT privilege is unavoidable (it is table-wide) are neutralised by
    // a trigger instead, so the end state is the same: a client value can never be stored.
    for (const [table, column] of [
      ["directory_documents", "storage_key"],
      ["school_profiles", "logo_object_key"],
    ] as Array<[string, string]>) {
      const ins = await ctx.pool.query<{ ok: boolean }>(
        `SELECT has_column_privilege('figbloom_app', $1, $2, 'INSERT') AS ok`,
        [`public.${table}`, column],
      );
      expect(ins.rows[0]?.ok, `${table}.${column} INSERT is table-wide`).toBe(true);
      const trg = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgtype & 4 = 4`,
        [`public.${table}`],
      );
      expect(trg.rows[0]!.n, `${table} needs a BEFORE INSERT trigger to neutralise it`).toBeGreaterThan(0);
    }
  });

  // ============================================================ deferred work stays deferred
  it("deferred capabilities are not quietly present", async () => {
    const urls = ctx.app.routeTable!.map((r) => `${r.method.toUpperCase()} ${r.url}`);
    // Object bytes, bulk import and invitations stay out of the directory API.
    // Class assignment and higher-education enrolment are Stage 9 routes.
    for (const forbidden of [/upload/i, /download/i, /invite/i]) {
      const hit = urls.filter((u) => forbidden.test(u));
      expect(hit, `routes matching ${forbidden}`).toEqual([]);
    }
    // Stage 16 deterministic learner CSV import is intentional; other /import* surfaces remain forbidden.
    const importHits = urls.filter((u) => /\/import/i.test(u));
    expect(importHits.every((u) => u.includes("/imports/learners/"))).toBe(true);
    // Documents remain metadata-only, in the response and in the database CHECK.
    const doc = await req("POST", `/v1/tenants/${A()}/documents`, {
      subject_type: "learner",
      subject_id: learnerId,
      doc_type: "deferred_probe",
      file_name: "d.pdf",
    });
    expect(doc.statusCode).toBe(201);
    expect(doc.json().document).toMatchObject({ storage_status: "metadata_only", object_available: false });
    const chk = await ctx.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'directory_documents_storage_status_chk'`,
    );
    expect(chk.rows[0]!.def).toContain("metadata_only");
    expect(chk.rows[0]!.def).not.toMatch(/available|uploaded|stored/i);
  });

  // ====================================================== pagination on the Stage 8 endpoints
  /**
   * `pagination.cursor-matrix.test.ts` says "all four paginated endpoints" and was written before
   * Phase 3 existed: it covers org schools, permissions, org delegations and learners. The four
   * paginated endpoints Stage 8 added — guardians, staff, documents and a learner's guardians —
   * were never added to it, so their cursor hardening and keyset correctness were unproven.
   */
  describe("pagination on the endpoints Stage 8 added", () => {
    const PAGED: Array<{ label: string; url: (t: string) => string; key: string }> = [
      { label: "learners", url: (t) => `/v1/tenants/${t}/learners`, key: "learners" },
      { label: "guardians", url: (t) => `/v1/tenants/${t}/guardians`, key: "guardians" },
      { label: "staff", url: (t) => `/v1/tenants/${t}/staff`, key: "staff" },
      { label: "documents", url: (t) => `/v1/tenants/${t}/documents`, key: "documents" },
      { label: "learner guardians", url: (t) => `/v1/tenants/${t}/learners/${learnerId}/guardians`, key: "items" },
    ];

    const b64 = (v: unknown) =>
      Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");

    /**
     * These tests own their fixtures.
     *
     * The first version relied on rows created by earlier tests in this file. Run on their own
     * (`vitest -t …`, which is how the mutation checks run them) there were no guardians, staff or
     * documents at all, so `next_cursor` was null, the cursor-binding test returned early and
     * asserted nothing — and a mutation that reintroduced the A-07 collision was reported as
     * "not caught". A paging test with nothing to page is not a passing test.
     */
    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        await newLearner(`Page Learner ${i}`, `AUD-PG-L${i}`);
        await newGuardian(`Page Guardian ${i}`, [learnerId]);
        const s = await req("POST", `/v1/tenants/${A()}/staff`, { full_name: `Page Staff ${i}` });
        expect(s.statusCode, s.body).toBe(201);
        const d = await req("POST", `/v1/tenants/${A()}/documents`, {
          subject_type: "learner",
          subject_id: learnerId,
          doc_type: "paging",
          file_name: `page-${i}.pdf`,
        });
        expect(d.statusCode, d.body).toBe(201);
      }
      // Every paginated endpoint must now have at least three rows, or the walk proves nothing.
      for (const p of PAGED) {
        const r = await req("GET", `${p.url(A())}?limit=200`);
        expect(r.statusCode, p.label).toBe(200);
        expect((r.json()[p.key] as unknown[]).length, `${p.label} fixture`).toBeGreaterThanOrEqual(3);
      }
    }, 120_000);

    for (const p of PAGED) {
      it(`${p.label}: every malformed cursor is a 400, never a 500 and never an empty page`, async () => {
        const cases: Array<[string, string]> = [
          ["not base64", "!!!!not-a-cursor!!!!"],
          ["base64 of junk", b64("plain text")],
          ["empty object", b64({})],
          ["wrong version", b64({ v: 999, k: ["a", "b"], f: "x", s: "name" })],
          ["extra field", b64({ v: 2, k: ["a", "b"], f: "x", s: "name", evil: 1 })],
          ["keys not strings", b64({ v: 2, k: [1, 2], f: "x", s: "name" })],
          ["too few keys", b64({ v: 2, k: ["a"], f: "x", s: "name" })],
          ["too many keys", b64({ v: 2, k: ["a", "b", "c"], f: "x", s: "name" })],
          ["NUL in key", b64({ v: 2, k: ["a\u0000b", "b"], f: "x", s: "name" })],
          ["poisoned uuid key", b64({ v: 2, k: ["a", "'; DROP TABLE learners; --"], f: "x", s: "name" })],
          ["oversized", b64({ v: 2, k: ["a".repeat(4000), "b"], f: "x", s: "name" })],
        ];
        for (const [label, cursor] of cases) {
          const r = await req("GET", `${p.url(A())}?cursor=${encodeURIComponent(cursor)}`);
          expect(r.statusCode, `${p.label} / ${label} -> ${r.body}`).toBe(400);
          expect(r.json().error.code, `${p.label} / ${label}`).toBe("validation_error");
          // No SQL, driver text or stack may reach the client.
          expect(r.body).not.toMatch(/SELECT |syntax error|pg_|stack|at Object\./i);
        }
      });

      it(`${p.label}: a cursor is bound to its endpoint and its filter`, async () => {
        const first = await req("GET", `${p.url(A())}?limit=1`);
        expect(first.statusCode, first.body).toBe(200);
        const cursor = first.json().page.next_cursor as string | null;
        if (!cursor) return; // fewer than two rows: nothing to bind

        // Same endpoint, different filter.
        const otherFilter = await req(
          "GET",
          `${p.url(A())}?limit=1&q=zzz&cursor=${encodeURIComponent(cursor)}`,
        );
        if (p.key !== "documents" && p.key !== "items") {
          expect(otherFilter.statusCode, `${p.label} filter rebind`).toBe(400);
        }
        // Every OTHER endpoint, not just one. Audit finding A-07: learners, guardians and staff
        // all fingerprinted as sort=name + {tenantId, active, q}, so a cursor from one was
        // silently honoured by the others and returned a wrong page instead of a 400. Checking a
        // single counterpart would have missed it, because the first counterpart tried happened
        // to be a differently-shaped endpoint.
        for (const other of PAGED.filter((x) => x.label !== p.label)) {
          const crossed = await req(
            "GET",
            `${other.url(A())}?limit=1&cursor=${encodeURIComponent(cursor)}`,
          );
          expect(crossed.statusCode, `${p.label} cursor accepted by ${other.label}`).toBe(400);
        }
      });

      it(`${p.label}: paging with limit=1 visits every row exactly once`, async () => {
        const all = await req("GET", `${p.url(A())}?limit=200`);
        expect(all.statusCode, all.body).toBe(200);
        const expected: string[] = all.json()[p.key].map((x: { id: string }) => x.id);
        expect(all.json().page.next_cursor, "fixture must fit in one page").toBeNull();

        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard <= expected.length + 2; guard++) {
          const url: string = `${p.url(A())}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
          const page = await req("GET", url);
          expect(page.statusCode, page.body).toBe(200);
          const items = page.json()[p.key] as Array<{ id: string }>;
          expect(items.length, `${p.label} page size`).toBeLessThanOrEqual(1);
          for (const it of items) seen.push(it.id);
          cursor = page.json().page.next_cursor;
          if (!cursor) break;
        }
        expect(cursor, `${p.label} did not terminate`).toBeNull();
        // No duplicates and no omissions: the keyset is total and strictly ordered.
        expect(new Set(seen).size, `${p.label} returned a duplicate`).toBe(seen.length);
        expect([...seen].sort()).toEqual([...expected].sort());
      });
    }
  });

  // ======================================================== search, challenged for leakage
  it("search cannot be used to probe another tenant or to widen a result set", async () => {
    await ctx.pool.query(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
       VALUES ($1,'AUD-SECRET','Zzz Secret Foreign Learner','male')`,
      [B()],
    );
    // Independent review I-02: the original probe only hit learners. Guardians and staff share
    // the same LIKE escaping helper — prove each list endpoint, not only one of three.
    await ctx.pool.query(
      `INSERT INTO guardians (tenant_id, full_name)
       VALUES ($1,'Zzz Secret Foreign Guardian')`,
      [B()],
    );
    await ctx.pool.query(
      `INSERT INTO staff_members (tenant_id, full_name)
       VALUES ($1,'Zzz Secret Foreign Staff')`,
      [B()],
    );
    const probes: Array<{
      path: string;
      key: string;
      foreignName: string;
    }> = [
      {
        path: "learners",
        key: "learners",
        foreignName: "Zzz Secret Foreign Learner",
      },
      {
        path: "guardians",
        key: "guardians",
        foreignName: "Zzz Secret Foreign Guardian",
      },
      {
        path: "staff",
        key: "staff",
        foreignName: "Zzz Secret Foreign Staff",
      },
    ];
    for (const endpoint of probes) {
      for (const q of ["Zzz Secret", "%", "_", "%%", "\\", "' OR 1=1 --", "%' OR '%'='"]) {
        const r = await req(
          "GET",
          `/v1/tenants/${A()}/${endpoint.path}?limit=200&q=${encodeURIComponent(q)}`,
        );
        expect(r.statusCode, `${endpoint.path} q=${q}`).toBe(200);
        const names = r.json()[endpoint.key].map((x: { full_name: string }) => x.full_name);
        expect(names, `${endpoint.path} q=${q} leaked a foreign row`).not.toContain(endpoint.foreignName);
        if (q !== "Zzz Secret") {
          expect(names.length, `${endpoint.path} q=${q} behaved as a wildcard`).toBe(0);
        }
      }
    }
    // A cursor minted for one tenant's query is not usable against a different filter.
    const page = await req("GET", `/v1/tenants/${A()}/learners?limit=1`);
    const cursor = page.json().page.next_cursor as string;
    expect(cursor).toBeTruthy();
    const reused = await req(
      "GET",
      `/v1/tenants/${A()}/learners?limit=1&q=abc&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(reused.statusCode, "a cursor must be bound to its filter").toBe(400);
  });

  // ======================================== independent review I-01 (A-01 residual)
  it("I-01 check_violation SQLSTATE 23514 maps to 400, never 500, with no SQL in the body", async () => {
    const { toClientError } = await import("../src/http/errors.js");
    const mapped = toClientError({
      code: "23514",
      message: 'new row for relation "school_profiles" violates check constraint "school_profiles_accent_len"',
    });
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("validation_error");
    expect(JSON.stringify(mapped.body)).not.toMatch(/school_profiles|accent_len|constraint|23514/i);
  });
});
