import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createTestApp, type FixtureIds } from "./support.js";
import { PEOPLE_AREA_IMPLIED } from "../src/modules/rbac/authorize.js";
import {
  SUBJECT_READ_PERMISSION,
  SUBJECT_WRITE_PERMISSION,
} from "../src/http/routes/documents.js";
import { LIKE_ESCAPE_CLAUSE, likeContains, parseSearchTerm } from "../src/modules/directory/search.js";
import { ACCENT_PATTERN } from "../src/modules/directory/contact.js";

/**
 * Stage 8 — School Directory completion.
 *
 * Regression tests for the work that closed the remaining Stage 8 gaps:
 *   * guardian restore (the lifecycle learners and staff already had);
 *   * P3-AUDIT-009 column-level UPDATE grants and the guardian_links un-archive guard;
 *   * P3-AUDIT-010 document subject permissions;
 *   * P3-AUDIT-012 lost updates on read-modify-write PATCH;
 *   * P3-AUDIT-013 search-term and contact-field validation;
 *   * P3-AUDIT-014 archived documents are frozen and the file-name constraint is VALIDATED;
 *   * P3-AUDIT-015 the indexes the list endpoints actually need;
 *   * school-profile row provenance (why there is no create route).
 *
 * Each test is written so that it fails if the corresponding change is reverted.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Stage 8 school directory completion", () => {
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
    return ctx.app.inject({
      method,
      url,
      headers: bearer(token, tenantId),
      payload: payload as never,
    });
  }

  async function newLearner(full_name: string, admission_no: string): Promise<string> {
    const r = await req("POST", `/v1/tenants/${A()}/learners`, {
      admission_no,
      full_name,
      gender: "female",
    });
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

  /** Active (non-archived) link rows of a guardian, oldest first. */
  async function linksOf(guardianId: string): Promise<Array<{ learner_id: string; reason: string; archived: boolean }>> {
    const r = await ctx.pool.query<{ learner_id: string; archived_reason: string; archived_at: Date | null }>(
      `SELECT learner_id, archived_reason, archived_at FROM guardian_links
        WHERE guardian_id = $1 ORDER BY created_at, id`,
      [guardianId],
    );
    return r.rows.map((x) => ({
      learner_id: x.learner_id,
      reason: x.archived_reason,
      archived: x.archived_at !== null,
    }));
  }

  async function latestEvent(type: string): Promise<{ detail: Record<string, unknown> } | null> {
    const r = await ctx.pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = $1
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [type],
    );
    return r.rows[0] ?? null;
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
    learnerId = await newLearner("Stage8 Learner One", "S8-0001");
    learner2Id = await newLearner("Stage8 Learner Two", "S8-0002");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ==================================================================== search
  describe("P3-AUDIT-013 search terms are literal, bounded and never normalised", () => {
    it("escapes LIKE wildcards: q=% is a search for a per-cent sign, not the whole roster", async () => {
      const all = await req("GET", `/v1/tenants/${A()}/learners?limit=200`);
      expect(all.statusCode).toBe(200);
      expect(all.json().learners.length).toBeGreaterThan(1);

      const pct = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent("%")}`);
      expect(pct.statusCode).toBe(200);
      expect(pct.json().learners).toEqual([]);

      const underscore = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent("_")}`);
      expect(underscore.statusCode).toBe(200);
      expect(underscore.json().learners).toEqual([]);
    });

    it("a name that really contains a wildcard character is findable by it", async () => {
      await newLearner("Ten % Percent", "S8-PCT");
      await newLearner("Under_score Name", "S8-UND");
      const pct = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent("% Per")}`);
      expect(pct.json().learners.map((l: { full_name: string }) => l.full_name)).toEqual(["Ten % Percent"]);
      const und = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent("er_sco")}`);
      expect(und.json().learners.map((l: { full_name: string }) => l.full_name)).toEqual(["Under_score Name"]);
    });

    it("a trailing backslash cannot escape the closing wildcard", async () => {
      const r = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent("Stage8\\")}`);
      expect(r.statusCode).toBe(200);
      expect(r.json().learners).toEqual([]);
      expect(likeContains("Stage8\\")).toBe("%stage8\\\\%");
    });

    it("bounds the term and refuses control characters", async () => {
      const long = "a".repeat(121);
      for (const url of [
        `/v1/tenants/${A()}/learners?q=${long}`,
        `/v1/tenants/${A()}/guardians?q=${long}`,
        `/v1/tenants/${A()}/staff?q=${long}`,
      ]) {
        const r = await req("GET", url);
        expect(r.statusCode, url).toBe(400);
        expect(r.json().error.code).toBe("validation_error");
      }
      const ctrl = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent("a\nb")}`);
      expect(ctrl.statusCode).toBe(400);
      // Exactly 120 is accepted.
      expect((await req("GET", `/v1/tenants/${A()}/learners?q=${"a".repeat(120)}`)).statusCode).toBe(200);
    });

    it("blank and whitespace-only q behave exactly like no q at all (same page, same cursor)", async () => {
      const none = await req("GET", `/v1/tenants/${A()}/learners?limit=1`);
      const blank = await req("GET", `/v1/tenants/${A()}/learners?limit=1&q=`);
      const spaces = await req("GET", `/v1/tenants/${A()}/learners?limit=1&q=${encodeURIComponent("   ")}`);
      expect(blank.json()).toEqual(none.json());
      expect(spaces.json()).toEqual(none.json());
      // Same fingerprint, so a cursor from one works on the other.
      expect(blank.json().page.next_cursor).toBe(none.json().page.next_cursor);
    });

    it("preserves personal names exactly: accents, apostrophes and non-Latin scripts are searchable as typed", async () => {
      const names = ["Wanjirũ Njeri", "Siobhán O'Brien", "李 明", "Müller-Śmith"];
      for (const [i, name] of names.entries()) await newLearner(name, `S8-U${i}`);
      for (const name of names) {
        const r = await req("GET", `/v1/tenants/${A()}/learners?q=${encodeURIComponent(name)}`);
        expect(r.statusCode, name).toBe(200);
        const found = r.json().learners.map((l: { full_name: string }) => l.full_name);
        expect(found, name).toContain(name);
      }
      // Stored unchanged — no NFC/NFD rewriting, no accent stripping.
      const stored = await ctx.pool.query<{ full_name: string }>(
        `SELECT full_name FROM learners
          WHERE tenant_id = $1 AND admission_no = ANY($2::text[])
          ORDER BY admission_no`,
        [A(), names.map((_, i) => `S8-U${i}`)],
      );
      expect(stored.rows.map((r) => r.full_name)).toEqual(names);
    });

    it("the escape clause is actually emitted, so the escaping is not inert", () => {
      expect(LIKE_ESCAPE_CLAUSE).toBe("ESCAPE '\\'");
      expect(parseSearchTerm("  ok  ")).toBe("ok");
      expect(parseSearchTerm("   ")).toBeNull();
      expect(() => parseSearchTerm("a".repeat(121))).toThrow();
    });

    it("the same escaping applies to guardians and staff", async () => {
      await newGuardian("Percent % Guardian", [learnerId]);
      const sr = await req("POST", `/v1/tenants/${A()}/staff`, { full_name: "Percent % Staff" });
      expect(sr.statusCode).toBe(201);
      for (const [url, key] of [
        [`/v1/tenants/${A()}/guardians`, "guardians"],
        [`/v1/tenants/${A()}/staff`, "staff"],
      ] as const) {
        const wild = await req("GET", `${url}?q=${encodeURIComponent("%")}`);
        expect(wild.statusCode, url).toBe(200);
        expect(wild.json()[key].length, url).toBe(1);
        expect(wild.json()[key][0].full_name).toContain("%");
      }
    });
  });

  // ========================================================== guardian restore
  describe("guardian restore completes the directory lifecycle", () => {
    it("restores the guardian and exactly the links its own archive cascaded over", async () => {
      const g = await newGuardian("Restorable Guardian", [learnerId, learner2Id]);
      expect((await linksOf(g)).filter((l) => !l.archived)).toHaveLength(2);

      const archived = await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`);
      expect(archived.statusCode).toBe(200);
      expect(archived.json().guardian.active).toBe(false);
      expect(archived.json().guardian.archived_at).not.toBeNull();
      expect((await linksOf(g)).every((l) => l.archived && l.reason === "guardian_archived")).toBe(true);

      const restored = await req("POST", `/v1/tenants/${A()}/guardians/${g}/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().guardian.active).toBe(true);
      expect(restored.json().guardian.archived_at).toBeNull();

      const after = await linksOf(g);
      expect(after.filter((l) => !l.archived).map((l) => l.learner_id).sort()).toEqual(
        [learnerId, learner2Id].sort(),
      );

      const ev = await latestEvent("directory.guardian.restored");
      expect(ev?.detail).toMatchObject({ guardianId: g, linksRestored: 2, linksHeldBack: 0 });
      // Audit detail is an allow-list of ids and counts only. A denylist regex on `07\\d{2}`
      // false-positived on UUID hex (independent review I-03): e.g. …355c307767d3 contains 0767.
      expect(Object.keys(ev!.detail!).sort()).toEqual([
        "guardianId",
        "linksHeldBack",
        "linksRestored",
      ]);
      expect(JSON.stringify(ev?.detail)).not.toContain("Restorable");
    });

    it("a relationship that was unlinked on purpose stays unlinked after a restore", async () => {
      const g = await newGuardian("Deliberate Unlink", [learnerId, learner2Id]);
      const links = await ctx.pool.query<{ id: string; learner_id: string }>(
        `SELECT id, learner_id FROM guardian_links WHERE guardian_id = $1 ORDER BY created_at, id`,
        [g],
      );
      const toUnlink = links.rows.find((l) => l.learner_id === learner2Id)!;
      expect(
        (await req("POST", `/v1/tenants/${A()}/guardians/${g}/links/${toUnlink.id}/archive`)).statusCode,
      ).toBe(200);

      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/restore`)).statusCode).toBe(200);

      const after = await linksOf(g);
      const active = after.filter((l) => !l.archived).map((l) => l.learner_id);
      expect(active).toEqual([learnerId]);
      expect(after.find((l) => l.learner_id === learner2Id)).toMatchObject({
        archived: true,
        reason: "unlinked",
      });
    });

    it("a link whose learner was archived meanwhile is held back; the guardian still restores", async () => {
      const held = await newLearner("Stage8 Held Learner", "S8-HELD");
      const g = await newGuardian("Partially Restorable", [learnerId, held]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      expect((await req("POST", `/v1/tenants/${A()}/learners/${held}/archive`)).statusCode).toBe(200);

      const restored = await req("POST", `/v1/tenants/${A()}/guardians/${g}/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().guardian.active).toBe(true);

      const after = await linksOf(g);
      expect(after.filter((l) => !l.archived).map((l) => l.learner_id)).toEqual([learnerId]);
      const heldLink = after.find((l) => l.learner_id === held)!;
      expect(heldLink.archived).toBe(true);
      expect(heldLink.reason).toBe("guardian_archived");

      const ev = await latestEvent("directory.guardian.restored");
      expect(ev?.detail).toMatchObject({ guardianId: g, linksRestored: 1, linksHeldBack: 1 });
    });

    it("the database refuses to un-archive a link onto an archived learner, whatever writes it (migration 027)", async () => {
      const gone = await newLearner("Stage8 Gone Learner", "S8-GONE");
      const g = await newGuardian("Guard Check", [gone]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      expect((await req("POST", `/v1/tenants/${A()}/learners/${gone}/archive`)).statusCode).toBe(200);
      const link = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM guardian_links WHERE guardian_id = $1`,
        [g],
      );
      // As the OWNER, which has every privilege: only the trigger can refuse this.
      await expect(
        ctx.pool.query(`UPDATE guardian_links SET archived_at = NULL WHERE id = $1`, [
          link.rows[0]!.id,
        ]),
      ).rejects.toMatchObject({ code: "P0002" });
    });

    it("refuses a guardian that is not archived (400) and an unknown or foreign one (404)", async () => {
      const g = await newGuardian("Never Archived", [learnerId]);
      const notArchived = await req("POST", `/v1/tenants/${A()}/guardians/${g}/restore`);
      expect(notArchived.statusCode).toBe(400);

      const unknown = await req(
        "POST",
        `/v1/tenants/${A()}/guardians/00000000-0000-0000-0000-000000000000/restore`,
      );
      expect(unknown.statusCode).toBe(404);

      // A guardian of the other tenant is indistinguishable from one that does not exist.
      const foreign = await ctx.pool.query<{ id: string }>(
        `INSERT INTO guardians (tenant_id, full_name) VALUES ($1, 'Foreign Guardian')
         RETURNING id`,
        [B()],
      );
      const cross = await req("POST", `/v1/tenants/${A()}/guardians/${foreign.rows[0]!.id}/restore`);
      expect(cross.statusCode).toBe(404);
      const still = await ctx.pool.query<{ active: boolean }>(
        `SELECT active FROM guardians WHERE id = $1`,
        [foreign.rows[0]!.id],
      );
      expect(still.rows[0]!.active).toBe(true);
    });

    it("needs guardian.write and learner.read, and gives a write-only caller no contact details", async () => {
      const g = await newGuardian("Write Only View", [learnerId]);
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);

      // A teacher holding no People area and no guardian grant is refused outright.
      const teacher = await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: A(), loginId: "TC-0001", password: "correct-horse-battery" },
      });
      expect(teacher.statusCode).toBe(200);
      const denied = await req(
        "POST",
        `/v1/tenants/${A()}/guardians/${g}/restore`,
        undefined,
        teacher.json().token as string,
      );
      expect(denied.statusCode).toBe(403);

      // Write-only: an explicit guardian.write grant, no guardian.read.
      await ctx.pool.query(
        `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by)
         VALUES ($1, $2, 'resource.guardian.write', $3)`,
        [A(), ids.teacherA, ids.adminA],
      );
      await ctx.pool.query(
        `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by)
         VALUES ($1, $2, 'people', $3) ON CONFLICT DO NOTHING`,
        [A(), ids.teacherA, ids.adminA],
      );
      try {
        const res = await req(
          "POST",
          `/v1/tenants/${A()}/guardians/${g}/restore`,
          undefined,
          teacher.json().token as string,
        );
        expect(res.statusCode, res.body).toBe(200);
        expect(Object.keys(res.json().guardian).sort()).toEqual(["id", "tenantId"]);
        expect(res.body).not.toMatch(/Write Only View/);
        // Audit: asserting only the response shape would also pass if the restore silently did
        // nothing. The write must really have happened, and the link must really be live again.
        const state = await ctx.pool.query<{ active: boolean; live_links: number }>(
          `SELECT g.active,
                  (SELECT count(*)::int FROM guardian_links l
                    WHERE l.guardian_id = g.id AND l.archived_at IS NULL) AS live_links
             FROM guardians g WHERE g.id = $1`,
          [g],
        );
        expect(state.rows[0]).toEqual({ active: true, live_links: 1 });
      } finally {
        await ctx.pool.query(
          `UPDATE staff_resource_grants SET revoked_at = now(), revoked_by = $3
            WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [A(), ids.teacherA, ids.adminA],
        );
        await ctx.pool.query(`DELETE FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2`, [
          A(),
          ids.teacherA,
        ]);
      }
    });

    it("exposes the guardian lifecycle state that ?active= filters on", async () => {
      const g = await newGuardian("Lifecycle Visible", [learnerId]);
      const read = await req("GET", `/v1/tenants/${A()}/guardians/${g}`);
      expect(read.json().guardian).toMatchObject({ active: true, archived_at: null });
      expect((await req("POST", `/v1/tenants/${A()}/guardians/${g}/archive`)).statusCode).toBe(200);
      const after = await req("GET", `/v1/tenants/${A()}/guardians/${g}`);
      expect(after.json().guardian.active).toBe(false);
      expect(after.json().guardian.archived_at).not.toBeNull();

      const archivedOnly = await req("GET", `/v1/tenants/${A()}/guardians?active=false&limit=200`);
      expect(archivedOnly.json().guardians.every((x: { active: boolean }) => x.active === false)).toBe(true);
    });
  });

  // ======================================================== document subjects
  describe("P3-AUDIT-010 a document never grants more reach than its subject", () => {
    it("pins the subject→permission mapping (widening it is a security change)", () => {
      expect(SUBJECT_READ_PERMISSION).toEqual({
        learner: "resource.learner.read",
        guardian: "resource.guardian.read",
        staff: "resource.staff.read",
      });
      expect(SUBJECT_WRITE_PERMISSION).toEqual({
        learner: "resource.learner.read",
        guardian: "resource.guardian.write",
        staff: "resource.staff.read",
      });
    });

    it("no reachable caller loses access: the People area still implies learner and staff reads", () => {
      // The documents API is reachable today only through `area.people` (resource.document.* is
      // not delegable) or a full administrator. Both hold the learner and staff permissions, so
      // the new requirement changes nothing for them — it closes the gap for any future, narrower
      // grant. If this ever stops being true, the People workflow breaks and this test says so.
      expect(PEOPLE_AREA_IMPLIED).toContain("resource.learner.read");
      expect(PEOPLE_AREA_IMPLIED).toContain("resource.staff.read");
      expect(PEOPLE_AREA_IMPLIED).toContain("resource.document.read");
      expect(PEOPLE_AREA_IMPLIED).toContain("resource.document.write");
      // ... and still never the guardian permissions (FIG-1614).
      expect(PEOPLE_AREA_IMPLIED).not.toContain("resource.guardian.read");
      expect(PEOPLE_AREA_IMPLIED).not.toContain("resource.guardian.write");
    });

    it("the guardian case still behaves as F-01 requires, through the generalised code path", async () => {
      const g = await newGuardian("Doc Subject Guardian", [learnerId]);
      const doc = await req("POST", `/v1/tenants/${A()}/documents`, {
        subject_type: "guardian",
        subject_id: g,
        doc_type: "id_copy",
        file_name: "id.pdf",
      });
      expect(doc.statusCode, doc.body).toBe(201);
      const docId = doc.json().document.id as string;

      // A People-area holder has document r/w but never guardian: the document is invisible.
      await ctx.pool.query(
        `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by)
         VALUES ($1, $2, 'people', $3) ON CONFLICT DO NOTHING`,
        [A(), ids.teacherA, ids.adminA],
      );
      try {
        const teacher = await ctx.app.inject({
          method: "POST",
          url: "/v1/auth/login/login-id",
          payload: { tenantId: A(), loginId: "TC-0001", password: "correct-horse-battery" },
        });
        const t = teacher.json().token as string;

        const get = await req("GET", `/v1/tenants/${A()}/documents/${docId}`, undefined, t);
        expect(get.statusCode).toBe(404);

        const list = await req("GET", `/v1/tenants/${A()}/documents?limit=200`, undefined, t);
        expect(list.statusCode).toBe(200);
        expect(list.json().documents.map((d: { id: string }) => d.id)).not.toContain(docId);

        const filtered = await req(
          "GET",
          `/v1/tenants/${A()}/documents?subject_type=guardian`,
          undefined,
          t,
        );
        expect(filtered.statusCode).toBe(403);

        // Learner-subject documents stay fully visible to the same caller.
        const own = await req(
          "POST",
          `/v1/tenants/${A()}/documents`,
          { subject_type: "learner", subject_id: learnerId, doc_type: "birth_certificate", file_name: "bc.pdf" },
          t,
        );
        expect(own.statusCode, own.body).toBe(201);
        expect(
          (await req("GET", `/v1/tenants/${A()}/documents/${own.json().document.id}`, undefined, t)).statusCode,
        ).toBe(200);
      } finally {
        await ctx.pool.query(`DELETE FROM staff_area_grants WHERE tenant_id = $1 AND user_id = $2`, [
          A(),
          ids.teacherA,
        ]);
      }
    });

    it("registering a document for an unknown subject never distinguishes 'absent' from 'not yours'", async () => {
      const unknown = await req("POST", `/v1/tenants/${A()}/documents`, {
        subject_type: "learner",
        subject_id: "00000000-0000-0000-0000-000000000000",
        doc_type: "x",
        file_name: "x.pdf",
      });
      expect(unknown.statusCode).toBe(404);
      const foreignLearner = await ctx.pool.query<{ id: string }>(
        `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
         VALUES ($1, 'S8-FOREIGN', 'Foreign Learner', 'male') RETURNING id`,
        [B()],
      );
      const foreign = await req("POST", `/v1/tenants/${A()}/documents`, {
        subject_type: "learner",
        subject_id: foreignLearner.rows[0]!.id,
        doc_type: "x",
        file_name: "x.pdf",
      });
      expect(foreign.statusCode).toBe(404);
    });
  });

  // ======================================================== contact validation
  describe("P3-AUDIT-013 contact fields are shape-checked, not length-checked", () => {
    it("staff phone and email follow the same rules as guardian contacts", async () => {
      for (const body of [
        { full_name: "Bad Phone", phone: "not a number" },
        { full_name: "Bad Phone 2", phone: "<script>x" },
        { full_name: "Bad Email", email: "nope" },
        { full_name: "Bad Email 2", email: "a@b" },
      ]) {
        const r = await req("POST", `/v1/tenants/${A()}/staff`, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
      }
      const ok = await req("POST", `/v1/tenants/${A()}/staff`, {
        full_name: "Good Contact",
        phone: "+254 700 123456",
        email: "good.contact@example.com",
      });
      expect(ok.statusCode, ok.body).toBe(201);

      const patch = await req("PATCH", `/v1/tenants/${A()}/staff/${ok.json().staff.id}`, {
        email: "still bad",
      });
      expect(patch.statusCode).toBe(400);
    });

    it("the school profile refuses a CSS-injecting accent and a malformed contact", async () => {
      for (const body of [
        { accent: "red;background:url(x)" },
        { accent: "a b" },
        { accent: 'x"y' },
        { accent: "#".repeat(40) },
        { contact_email: "not-an-email" },
        { contact_phone: "call me" },
      ]) {
        const r = await req("PATCH", `/v1/tenants/${A()}/school-profile`, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
      }
      for (const accent of ["#1d4ed8", "brand-primary", "accent_2"]) {
        const r = await req("PATCH", `/v1/tenants/${A()}/school-profile`, { accent });
        expect(r.statusCode, accent).toBe(200);
        expect(r.json().schoolProfile.accent).toBe(accent);
      }
      expect(new RegExp(ACCENT_PATTERN).test("red;background:url(x)")).toBe(false);
    });

    it("a value stored before the rule cannot be carried forward by an unrelated PATCH", async () => {
      await ctx.pool.query(
        `INSERT INTO school_profiles (tenant_id, accent) VALUES ($1, 'red;evil')
         ON CONFLICT (tenant_id) DO UPDATE SET accent = EXCLUDED.accent`,
        [A()],
      );
      const r = await req("PATCH", `/v1/tenants/${A()}/school-profile`, { county: "Nakuru" });
      expect(r.statusCode).toBe(400);
      // Clean up so later tests start from a valid row.
      await ctx.pool.query(`UPDATE school_profiles SET accent = NULL WHERE tenant_id = $1`, [A()]);
    });

    it("refuses a document doc_type carrying control characters", async () => {
      const r = await req("POST", `/v1/tenants/${A()}/documents`, {
        subject_type: "learner",
        subject_id: learnerId,
        doc_type: "report\ncard",
        file_name: "r.pdf",
      });
      expect(r.statusCode).toBe(400);
    });
  });

  // ============================================================ lost updates
  /**
   * P3-AUDIT-012 is about a LOST UPDATE, not about blocking, and the difference matters.
   *
   * A first version of these tests asserted only that a PATCH waits behind a row lock. A mutation
   * check exposed that as worthless: with the handler's `SELECT … FOR UPDATE` deleted the test
   * still passed, because the handler's final `UPDATE` blocks on the same lock anyway. Waiting
   * was never the property at risk.
   *
   * What is at risk is this: two PATCHes that touch DIFFERENT fields each read the row, each merge
   * their change into the value they read, and the second write then carries the first's field back
   * to its old value. These tests therefore let both requests reach their read, release them
   * together, and require BOTH changes to survive — which is false without the lock and true with
   * it, whichever request wins the race.
   */
  describe("P3-AUDIT-012 two concurrent PATCHes on different fields both survive", () => {
    /**
     * Holds a row lock, launches both PATCHes, releases, and returns once both have answered.
     * The pause is what makes the no-lock case fail deterministically: without the handler's
     * `FOR UPDATE` both requests complete their read during it and go on to overwrite each other.
     */
    async function raceTwoPatches(
      lockSql: string,
      lockParams: unknown[],
      url: string,
      first: Record<string, unknown>,
      second: Record<string, unknown>,
    ): Promise<void> {
      const owner = await ctx.pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query(lockSql, lockParams);
        const a = req("PATCH", url, first);
        const b = req("PATCH", url, second);
        await sleep(400);
        await owner.query("COMMIT");
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.statusCode, ra.body).toBe(200);
        expect(rb.statusCode, rb.body).toBe(200);
      } finally {
        await owner.query("ROLLBACK").catch(() => undefined);
        owner.release();
      }
    }

    it("learners: a name change and a boarding change cannot overwrite each other", async () => {
      const id = await newLearner("Lock Target Learner", "S8-LK1");
      await raceTwoPatches(
        `SELECT 1 FROM learners WHERE id = $1 FOR UPDATE`,
        [id],
        `/v1/tenants/${A()}/learners/${id}`,
        { full_name: "Lock Target Learner B" },
        { boarding: true },
      );
      const after = await req("GET", `/v1/tenants/${A()}/learners/${id}`);
      expect(after.json().learner.full_name).toBe("Lock Target Learner B");
      expect(after.json().learner.boarding).toBe(true);
    });

    it("staff: a name change and a title change cannot overwrite each other", async () => {
      const created = await req("POST", `/v1/tenants/${A()}/staff`, { full_name: "Lock Target Staff" });
      expect(created.statusCode).toBe(201);
      const id = created.json().staff.id as string;
      await raceTwoPatches(
        `SELECT 1 FROM staff_members WHERE id = $1 FOR UPDATE`,
        [id],
        `/v1/tenants/${A()}/staff/${id}`,
        { full_name: "Lock Target Staff B" },
        { staff_title: "Bursar" },
      );
      const after = await req("GET", `/v1/tenants/${A()}/staff/${id}`);
      expect(after.json().staff.full_name).toBe("Lock Target Staff B");
      expect(after.json().staff.staff_title).toBe("Bursar");
    });

    it("guardians: a name change and a phone change cannot overwrite each other", async () => {
      const id = await newGuardian("Lock Target Guardian", [learnerId]);
      await raceTwoPatches(
        `SELECT 1 FROM guardians WHERE id = $1 FOR UPDATE`,
        [id],
        `/v1/tenants/${A()}/guardians/${id}`,
        { full_name: "Lock Target Guardian B" },
        { phone: "0722000333" },
      );
      const after = await req("GET", `/v1/tenants/${A()}/guardians/${id}`);
      expect(after.json().guardian.full_name).toBe("Lock Target Guardian B");
      expect(after.json().guardian.phone).toBe("0722000333");
    });

    it("school profile: a county change and a country change cannot overwrite each other", async () => {
      // Materialise the row first, so the lock below has something to take.
      expect((await req("PATCH", `/v1/tenants/${A()}/school-profile`, { county: "Kiambu" })).statusCode).toBe(200);
      await raceTwoPatches(
        `SELECT 1 FROM school_profiles WHERE tenant_id = $1 FOR UPDATE`,
        [A()],
        `/v1/tenants/${A()}/school-profile`,
        { county: "Machakos" },
        { country: "Kenya" },
      );
      const after = await req("GET", `/v1/tenants/${A()}/school-profile`);
      expect(after.json().schoolProfile.county).toBe("Machakos");
      expect(after.json().schoolProfile.country).toBe("Kenya");
    });
  });

  // ================================================= school profile provenance
  describe("school profile row provenance (the Stage 8 'missing create route' question)", () => {
    it("reads before any profile row exists, then the first PATCH creates exactly one", async () => {
      // tenantB has never been written to by these tests.
      const before = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM school_profiles WHERE tenant_id = $1`,
        [B()],
      );
      expect(before.rows[0]!.n).toBe(0);

      const read = await req("GET", `/v1/tenants/${A()}/school-profile`);
      expect(read.statusCode).toBe(200);
      expect(read.json().schoolProfile).toMatchObject({ tenantId: A(), slug: "school-a" });

      await ctx.pool.query(`DELETE FROM school_profiles WHERE tenant_id = $1`, [A()]);
      expect((await req("PATCH", `/v1/tenants/${A()}/school-profile`, { county: "Nairobi" })).statusCode).toBe(200);
      expect((await req("PATCH", `/v1/tenants/${A()}/school-profile`, { country: "Kenya" })).statusCode).toBe(200);
      const rows = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM school_profiles WHERE tenant_id = $1`,
        [A()],
      );
      expect(rows.rows[0]!.n).toBe(1);
      const after = await req("GET", `/v1/tenants/${A()}/school-profile`);
      expect(after.json().schoolProfile).toMatchObject({ county: "Nairobi", country: "Kenya" });
    });

    it("publishes no create operation, because the primary key makes a second row impossible", async () => {
      const posted = ctx.app
        .routeTable!.filter((r) => r.url === "/v1/tenants/:tenantId/school-profile")
        .map((r) => r.method.toUpperCase());
      expect(posted).not.toContain("POST");
      expect(posted).toContain("GET");
      expect(posted).toContain("PATCH");
      const pk = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.table_constraints
          WHERE table_schema = 'public' AND table_name = 'school_profiles'
            AND constraint_type = 'PRIMARY KEY'`,
      );
      expect(pk.rows[0]!.n).toBe(1);
      await expect(
        ctx.pool.query(`INSERT INTO school_profiles (tenant_id) VALUES ($1)`, [A()]),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  // ===================================================== migration 027 details
  describe("migration 027 integrity", () => {
    it("validates the file-name constraint instead of leaving it NOT VALID (P3-AUDIT-014)", async () => {
      const r = await ctx.pool.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'directory_documents_file_name_safe'`,
      );
      expect(r.rows[0]?.convalidated).toBe(true);
    });

    it("refuses an unknown guardian-link archive reason", async () => {
      await expect(
        ctx.pool.query(
          `UPDATE guardian_links SET archived_reason = 'something_else' WHERE id = (SELECT id FROM guardian_links LIMIT 1)`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("creates the indexes the list endpoints need (P3-AUDIT-015)", async () => {
      const want = [
        "learners_tenant_name_id_idx",
        "learners_tenant_created_id_idx",
        "guardians_tenant_name_id_idx",
        "staff_members_tenant_name_id_idx",
        "staff_members_user_id_idx",
        "directory_documents_uploaded_by_idx",
        "guardian_links_guardian_cascade_idx",
      ];
      const r = await ctx.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
        [want],
      );
      expect(r.rows.map((x) => x.indexname).sort()).toEqual([...want].sort());
    });
  });

  // ============================================================= OpenAPI truth
  describe("P3-AUDIT-011 the published contract matches the implementation", () => {
    const spec = parseYaml(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8")) as any;

    it("documents the restore operation the server registers", () => {
      const path = spec.paths["/v1/tenants/{tenantId}/guardians/{guardianId}/restore"];
      expect(path?.post?.operationId).toBe("restoreGuardian");
      expect(path.post["x-figbloom-permissions"]).toEqual([
        "resource.guardian.write",
        "resource.learner.read",
      ]);
      const registered = ctx.app
        .routeTable!.filter((r) => r.url === "/v1/tenants/:tenantId/guardians/:guardianId/restore")
        .map((r) => r.method.toUpperCase());
      expect(registered).toContain("POST");
    });

    it("learner PATCH is documented as a partial update, not as the create body", async () => {
      const op = spec.paths["/v1/tenants/{tenantId}/learners/{learnerId}"].patch;
      const ref = op.requestBody.content["application/json"].schema.$ref;
      expect(ref).toBe("#/components/schemas/PatchLearnerRequest");
      const schema = spec.components.schemas.PatchLearnerRequest;
      expect(schema.required).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
      // And the server really does accept a single field and reject an unknown one.
      const id = await newLearner("Patch Shape", "S8-PATCH");
      expect((await req("PATCH", `/v1/tenants/${A()}/learners/${id}`, { boarding: true })).statusCode).toBe(200);
      expect(
        (await req("PATCH", `/v1/tenants/${A()}/learners/${id}`, { nope: 1 })).statusCode,
      ).toBe(400);
    });

    it("every body documented as additionalProperties:false really rejects an unknown field", async () => {
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ["POST", `/v1/tenants/${A()}/staff`, { full_name: "Strict Staff", nope: 1 }],
        ["PATCH", `/v1/tenants/${A()}/school-profile`, { county: "X", nope: 1 }],
        [
          "POST",
          `/v1/tenants/${A()}/documents`,
          { subject_type: "learner", subject_id: learnerId, doc_type: "t", file_name: "f.pdf", storage_key: "x" },
        ],
        [
          "POST",
          `/v1/tenants/${A()}/guardians`,
          { full_name: "Strict Guardian", learners: [{ learner_id: learnerId, relationship: "mother" }], nope: 1 },
        ],
      ];
      for (const [method, url, body] of cases) {
        const r = await req(method as "POST", url, body);
        expect(r.statusCode, `${method} ${url}`).toBe(400);
      }
      for (const name of [
        "CreateStaffRequest",
        "PatchStaffRequest",
        "PatchSchoolProfileRequest",
        "RegisterDocumentRequest",
        "CreateGuardianRequest",
        "GuardianLinkRequest",
        "PatchLearnerRequest",
      ]) {
        expect(spec.components.schemas[name].additionalProperties, name).toBe(false);
      }
    });

    it("the documented response schemas describe the real bodies", async () => {
      const requiredOf = (name: string): string[] => spec.components.schemas[name].required;

      const staff = await req("POST", `/v1/tenants/${A()}/staff`, { full_name: "Shape Staff" });
      expect(staff.statusCode).toBe(201);
      for (const key of requiredOf("StaffMember")) expect(staff.json().staff, key).toHaveProperty(key);

      const doc = await req("POST", `/v1/tenants/${A()}/documents`, {
        subject_type: "learner",
        subject_id: learnerId,
        doc_type: "shape",
        file_name: "shape.pdf",
      });
      expect(doc.statusCode).toBe(201);
      for (const key of requiredOf("DirectoryDocument")) expect(doc.json().document, key).toHaveProperty(key);
      // The storage key is still never published.
      expect(doc.body).not.toContain("storage_key");

      const profile = await req("GET", `/v1/tenants/${A()}/school-profile`);
      for (const key of requiredOf("SchoolProfile")) expect(profile.json().schoolProfile, key).toHaveProperty(key);

      const guardians = await req("GET", `/v1/tenants/${A()}/guardians?limit=1`);
      expect(guardians.json()).toHaveProperty("guardians");
      expect(guardians.json()).toHaveProperty("page");
      for (const key of requiredOf("GuardianContact")) {
        expect(guardians.json().guardians[0], key).toHaveProperty(key);
      }
    });

    it("documents the search parameter's real bound", () => {
      expect(spec.components.parameters.SearchQuery.schema.maxLength).toBe(120);
      for (const path of [
        "/v1/tenants/{tenantId}/learners",
        "/v1/tenants/{tenantId}/guardians",
        "/v1/tenants/{tenantId}/staff",
      ]) {
        const refs = spec.paths[path].get.parameters.map((p: { $ref?: string }) => p.$ref);
        expect(refs, path).toContain("#/components/parameters/SearchQuery");
      }
    });
  });
});
