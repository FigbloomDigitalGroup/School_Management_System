import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_CATEGORIES, auditEventLabel } from "../src/modules/audit/schoolAudit.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * The school's audit log (docs/SCHOOL-AUDIT.md, migration 106), through the real figbloom_app login. Negative first: who may
 * not read it (a parent, a student, a driver, a teacher without the Audit area, a holder of another area, another school's
 * administrator, an archived member, a suspended school, a disabled account, anonymous), what is never returned (sign-in, session
 * and two-step events, refusals, read events, personal settings, other schools' events, the detail and the IP address), and that
 * every event kind the code writes has been classified on purpose.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Row = Record<string, unknown>;

const SNAPSHOT = join(process.cwd(), "test", "fixtures", "schoolAuditClassification.json");

describe("school audit log", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const path = "/audit-events";

  const get = (who: string, query = "", opts: { tenant?: string; header?: string } = {}) => {
    const tenant = opts.tenant ?? ids.tenantA;
    return ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenant}${path}${query}`,
      headers: { authorization: `Bearer ${tok[who]}`, "x-tenant-id": opts.header ?? tenant },
    });
  };
  const events = async (who: string, query = "", opts: { tenant?: string } = {}): Promise<Row[]> => {
    const res = await get(who, query, opts);
    expect(res.statusCode, `${who} ${query} ${res.body}`).toBe(200);
    return res.json().events as Row[];
  };
  const types = (rows: Row[]) => rows.map((r) => String(r.event_type));
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);

  async function member(name: string, role: string, loginId: string, tenant: string): Promise<string> {
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, NULL, password_hash, $2, 'active' FROM users WHERE id = $3`,
      [userId, name, ids.adminA],
    );
    await q(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [userId, tenant, role, loginId]);
    return userId;
  }
  async function login(tenantId: string, loginId: string): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId, loginId, password: "correct-horse-battery" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }
  async function whileChanged(change: string, undo: string, params: unknown[], fn: () => Promise<void>): Promise<void> {
    await q(change, params);
    try {
      await fn();
    } finally {
      await q(undo, params);
    }
  }
  /** One event, written as the owner (the runtime role has INSERT only; the API writes events the same way). `minutesAgo` orders them. */
  async function event(tenant: string | null, eventType: string, actor: string | null, minutesAgo: number, detail: Record<string, unknown> = {}): Promise<string> {
    const res = await q(
      `INSERT INTO security_audit_events (tenant_id, event_type, actor_user_id, detail, ip, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, '203.0.113.9'::inet, now() - make_interval(mins => $5)) RETURNING id`,
      [tenant, eventType, actor, JSON.stringify(detail), minutesAgo],
    );
    return res.rows[0].id as string;
  }
  const conforms = (body: unknown) => {
    const schema = responseSchema(spec, "GET", "/v1/tenants/{tenantId}/audit-events", 200);
    expect(typeof schema).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, errs.join("; ")).toEqual([]);
  };

  // What school A's log must show, newest first (each is written one minute earlier than the one above): [event type, category].
  const VISIBLE: Array<[string, string]> = [
    ["finance.payment.recorded", "financial"],
    ["directory.learner.created", "provisioning"],
    ["rbac.staff_areas.changed", "access"],
    ["academics.mark.upserted", "academic"],
    ["health.mar.recorded", "health"],
    ["transport.trip.started", "transport"],
    ["communications.announcement.published", "communication"],
    ["communications.visit.created", "operations"],
    ["academics.membership.assigned", "provisioning"],
    ["inventory.issue.created", "operations"],
    ["attendance.settings.updated", "provisioning"],
    ["storage.object.deleted", "operations"],
    ["finance.term.billed", "financial"], // written by the system: no actor
    ["admin.manual_notice", "communication"],
  ];
  // Never shown, whatever the school: sign-in and two-step, refusals, read events, personal and internal ones, unknown domains.
  const HIDDEN = [
    "auth.login.success", "auth.login.failure", "auth.logout", "auth.mfa.enrolled", "auth.password.changed",
    "rbac.permission.denied", "rbac.staff_areas.denied", "rbac.org_delegation.denied", "family.child.denied", "ai.bloom.denied", "ai.bloom.queried",
    "notifications.outbox.enqueued", "identity.external.linked",
    "health.sick_bay.visit_viewed", "health.sick_bay.board_viewed", "communications.visit.viewed", "communications.visit.list_viewed",
    "communications.chat.started", "communications.notification_preferences.updated",
    "finance.mpesa.operator_inconclusive", "storage.object.upload_initiated", "storage.object.download_authorized",
    "attendance.register.stale_ignored",
    "brand.new.kind", // a kind nobody classified yet: hidden until someone decides
  ];

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const A = ids.tenantA;
    const B = ids.tenantB;

    id.teacher2 = await member("Audit Teacher", "teacher", "TC-0002", A); // will hold the Audit area
    id.teacher3 = await member("Fees Teacher", "teacher", "TC-0003", A); // holds another area
    id.teacher4 = await member("Plain Teacher", "teacher", "TC-0004", A);
    id.student = await member("Student One", "student", "ST-0001", A);
    id.driver = await member("Driver One", "driver", "DR-0001", A);
    id.adminB = await member("Admin B", "school_admin", "AD-0002", B);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'audit')`, [A, id.teacher2]);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees')`, [A, id.teacher3]);

    tok.admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token;
    tok.adminB = await login(B, "AD-0002");
    tok.auditTeacher = await login(A, "TC-0002");
    tok.feesTeacher = await login(A, "TC-0003");
    tok.teacher = await login(A, "TC-0004");
    tok.teacherA = await login(A, "TC-0001");
    tok.parent = await login(A, "PT-0001");
    tok.student = await login(A, "ST-0001");
    tok.driver = await login(A, "DR-0001");

    // School A: the visible events (actor = the administrator, or null for the system one), the hidden ones, all with a secret detail and an IP.
    for (const [i, [type]] of VISIBLE.entries()) {
      await event(A, type, type === "finance.term.billed" ? null : ids.adminA, i + 1, { secret: "do-not-show", learner: "Amina Ochieng" });
    }
    for (const [i, type] of HIDDEN.entries()) await event(A, type, ids.adminA, 20 + i, { secret: "do-not-show" });
    // Other places: another school's event, and one with no school at all.
    await event(B, "finance.payment.recorded", id.adminB, 1, { secret: "school B" });
    await event(null, "curriculum.catalogue.batch_imported", ids.adminA, 1, { secret: "no school" });
  }, 240_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("who may read it", () => {
    it("a parent, a student, a driver, a teacher without the Audit area and a holder of another area get the audited 403", async () => {
      for (const who of ["parent", "student", "driver", "teacher", "teacherA", "feesTeacher"]) {
        const res = await get(who);
        expect(res.statusCode, who).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
      const audit = await q(
        `SELECT 1 FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied' AND detail->>'permission' = 'resource.audit.read'`,
        [ids.parentA],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
    });

    it("anonymous gets 401, a disabled account 401, an archived member and a suspended school 403", async () => {
      expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}${path}` })).statusCode).toBe(401);
      await whileChanged(
        `UPDATE users SET status = 'disabled' WHERE id = $1`,
        `UPDATE users SET status = 'active' WHERE id = $1`,
        [ids.adminA],
        async () => expect((await get("admin")).statusCode).toBe(401),
      );
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [ids.adminA, ids.tenantA],
        async () => expect((await get("admin")).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => expect((await get("admin")).statusCode).toBe(403),
      );
    });

    it("another school's administrator is refused here, by path and by header, and reads only their own school", async () => {
      expect((await get("adminB")).statusCode).toBe(403);
      expect((await get("admin", "", { tenant: ids.tenantB })).statusCode).toBe(403);
      expect((await get("admin", "", { header: ids.tenantB })).statusCode).toBe(403);
      const own = await events("adminB", "", { tenant: ids.tenantB });
      expect(types(own)).toContain("finance.payment.recorded");
      expect(own.every((e) => e.actor_user_id === id.adminB)).toBe(true);
      expect(own.length).toBe(1);
    });

    it("the Audit area opens it, and ending the area closes it again", async () => {
      expect(types(await events("auditTeacher")).length).toBe(VISIBLE.length);
      await whileChanged(
        `DELETE FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2 AND area = 'audit'`,
        `INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($2, $1, 'audit')`,
        [id.teacher2, ids.tenantA],
        async () => expect((await get("auditTeacher")).statusCode).toBe(403),
      );
    });

    it("the database function refuses without a school and an account in the request", async () => {
      await expect(
        ctx.runtimePool.query(`SELECT * FROM public.school_audit_events(NULL, NULL, NULL, NULL, NULL, 10)`),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("what it returns", () => {
    it("exactly the school's business events, newest first, and nothing from sign-in, refusals, reads, other schools or no school", async () => {
      const rows = await events("admin", "?limit=200");
      expect(types(rows)).toEqual(VISIBLE.map(([t]) => t));
      for (const hidden of HIDDEN) expect(types(rows), hidden).not.toContain(hidden);
      expect(types(rows)).not.toContain("curriculum.catalogue.batch_imported");
    });

    it("each row says what happened, who and when, and carries no detail and no IP address", async () => {
      const res = await get("admin", "?limit=200");
      conforms(res.json());
      const rows = res.json().events as Row[];
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(["actor_name", "actor_user_id", "category", "event_type", "id", "label", "occurred_at"]);
      expect(res.body).not.toContain("do-not-show");
      expect(res.body).not.toContain("Amina Ochieng");
      expect(res.body).not.toContain("203.0.113.9");
      const payment = rows.find((r) => r.event_type === "finance.payment.recorded")!;
      expect(payment).toMatchObject({ category: "financial", label: "Payment recorded", actor_user_id: ids.adminA });
      expect(typeof payment.actor_name).toBe("string");
      const billed = rows.find((r) => r.event_type === "finance.term.billed")!;
      expect(billed).toMatchObject({ actor_user_id: null, actor_name: null });
      for (const [type, category] of VISIBLE) expect(rows.find((r) => r.event_type === type)!.category, type).toBe(category);
    });

    it("the words: a known wording, or the event's own name without its domain", () => {
      expect(auditEventLabel("finance.payment.recorded")).toBe("Payment recorded");
      expect(auditEventLabel("directory.learner.created")).toBe("Learner created");
      expect(auditEventLabel("inventory.issue.created")).toBe("Issue created");
      expect(auditEventLabel("health.mar.recorded")).toBe("Mar recorded");
      expect(auditEventLabel("nothing")).toBe("nothing");
    });
  });

  describe("filters and pages", () => {
    it("a category narrows to its own events; an unknown category is refused", async () => {
      for (const category of AUDIT_CATEGORIES) {
        const rows = await events("admin", `?category=${category}`);
        const expected = VISIBLE.filter(([, c]) => c === category).map(([t]) => t);
        expect(types(rows), category).toEqual(expected);
      }
      expect((await get("admin", "?category=secrets")).statusCode).toBe(400);
    });

    it("since keeps that day and later; a bad date is refused", async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      expect(await events("admin", `?since=${tomorrow}`)).toEqual([]);
      expect((await events("admin", `?since=${today}&limit=200`)).length).toBeGreaterThan(0);
      for (const bad of ["2026-02-31", "yesterday", "2026-1-1"]) expect((await get("admin", `?since=${bad}`)).statusCode, bad).toBe(400);
    });

    it("search matches who did it and the event's words, as plain text", async () => {
      expect(types(await events("admin", "?search=payment"))).toEqual(["finance.payment.recorded"]);
      expect(types(await events("admin", "?search=LEARNER%20created"))).toEqual(["directory.learner.created"]);
      expect((await events("admin", "?search=nobody%20by%20this%20name")).length).toBe(0);
      // a wildcard is just a character: it matches nothing here
      expect(await events("admin", "?search=%25")).toEqual([]);
      expect(await events("admin", "?search=_")).toEqual([]);
      const adminName = (await events("admin")).find((r) => r.actor_name)!.actor_name as string;
      expect((await events("admin", `?search=${encodeURIComponent(adminName.slice(0, 3).toLowerCase())}&limit=200`)).length).toBeGreaterThan(0);
      expect((await get("admin", `?search=${"x".repeat(81)}`)).statusCode).toBe(400);
    });

    it("pages in a fixed order, and a cursor cannot be replayed under another filter or by another school", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 12; i++) {
        const res = await get("admin", `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.statusCode, res.body).toBe(200);
        seen.push(...types(res.json().events));
        cursor = res.json().page.next_cursor as string | null;
        if (!cursor) break;
      }
      expect(seen).toEqual(VISIBLE.map(([t]) => t));
      const first = await get("admin", "?limit=5");
      const token = first.json().page.next_cursor as string;
      expect(token).toBeTruthy();
      expect((await get("admin", `?limit=5&category=access&cursor=${encodeURIComponent(token)}`)).statusCode).toBe(400);
      expect((await get("admin", `?limit=5&search=a&cursor=${encodeURIComponent(token)}`)).statusCode).toBe(400);
      expect((await get("adminB", `?limit=5&cursor=${encodeURIComponent(token)}`, { tenant: ids.tenantB })).statusCode).toBe(400);
      expect((await get("admin", "?sort=occurred_at_desc")).statusCode).toBe(400);
      expect((await get("admin", "?limit=0")).statusCode).toBe(400);
    });
  });

  describe("every event kind the code writes is classified on purpose", () => {
    const SRC = join(process.cwd(), "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    /** Kinds built from a template in the code (a value is appended), spelled out here. */
    const DYNAMIC = [
      "curriculum.catalogue.entry_under_review", "curriculum.catalogue.entry_verified", "curriculum.catalogue.entry_rejected", "curriculum.catalogue.entry_superseded",
      "health.medication_authorization.approved", "health.medication_authorization.rejected",
      "medication.authorization_approved", "medication.authorization_rejected",
      "health.sick_bay.visit_corrected", "health.sick_bay.visit_updated",
    ];
    const written = (): string[] => {
      const found = new Set<string>(DYNAMIC);
      for (const file of walk(SRC)) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/(?:eventType|event_type)\W{1,3}"([a-z_]+\.[a-z_.]+)"/g)) found.add(m[1]!);
      }
      return [...found].sort();
    };

    it("the log shows each kind in the category written down in test/fixtures/schoolAuditClassification.json, or hides it", async () => {
      const kinds = written();
      expect(kinds.length).toBeGreaterThan(150);
      // School B is this test's own: one event of each kind, then read back what its administrator sees.
      for (const k of kinds) await event(ids.tenantB, k, id.adminB, 0, { snapshot: true });
      const seen = new Map<string, string>();
      let cursor: string | null = null;
      for (let i = 0; i < 40; i++) {
        const res = await get("adminB", `?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { tenant: ids.tenantB });
        expect(res.statusCode, res.body).toBe(200);
        for (const e of res.json().events as Row[]) seen.set(String(e.event_type), String(e.category));
        cursor = res.json().page.next_cursor as string | null;
        if (!cursor) break;
      }
      const actual: Record<string, string> = {};
      for (const k of kinds) actual[k] = seen.get(k) ?? "hidden";

      if (process.env.SCHOOL_AUDIT_WRITE_SNAPSHOT === "1") {
        mkdirSync(dirname(SNAPSHOT), { recursive: true });
        writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + "\n");
        return;
      }
      expect(existsSync(SNAPSHOT), "run with SCHOOL_AUDIT_WRITE_SNAPSHOT=1 to write it, and review it").toBe(true);
      const decided = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
      const unclassified = kinds.filter((k) => !(k in decided));
      expect(unclassified, "new event kinds: decide if a school may see them (migration 106 function), then regenerate the file with SCHOOL_AUDIT_WRITE_SNAPSHOT=1 and review the diff").toEqual([]);
      const changed = kinds.filter((k) => decided[k] !== actual[k]).map((k) => `${k}: file says ${decided[k]}, the database says ${actual[k]}`);
      expect(changed).toEqual([]);
    }, 120_000);
  });
});
