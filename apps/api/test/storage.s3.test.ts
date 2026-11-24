import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import {
  InMemoryStorageProvider,
  NotConfiguredStorageProvider,
  S3StorageProvider,
  setStorageProviderForTesting,
} from "../src/modules/storage/storageProvider.js";
import { runMaintenance } from "../src/worker/runtime.js";
import { createPool } from "../src/db/pool.js";

const PASSWORD = "correct-horse-battery";

describe("Stage 3: S3 Object Storage (migration 090)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherAToken: string;
  let teacherBToken: string;
  let workerPool: ReturnType<typeof createPool>;

  // Local mock S3 HTTP server (no AWS account contacted)
  let mockS3Server: Server;
  let mockS3Port: number;
  const s3Objects = new Map<string, { body: Buffer; contentType: string; etag: string }>();
  const s3SeenAuthHeaders: string[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;

    const workerPassword = `wrk_${randomUUID().replace(/-/g, "")}`;
    await ctx.pool.query(`ALTER ROLE figbloom_worker WITH LOGIN PASSWORD '${workerPassword}'`);
    const workerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
    workerUrl.username = "figbloom_worker";
    workerUrl.password = workerPassword;
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2, applicationName: "figbloom-test-worker" });

    adminToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: PASSWORD } })
    ).json().token as string;
    teacherAToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;
    teacherBToken = (
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD } })
    ).json().token as string;

    mockS3Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const key = url.pathname;
      if (req.headers.authorization) s3SeenAuthHeaders.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") {
          const body = Buffer.concat(chunks);
          const etag = `"${createHash("md5").update(body).digest("hex")}"`;
          s3Objects.set(key, {
            body,
            contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
            etag,
          });
          res.statusCode = 200;
          res.setHeader("etag", etag);
          res.end();
          return;
        }
        if (req.method === "HEAD") {
          const item = s3Objects.get(key);
          if (!item) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", item.contentType);
          res.setHeader("content-length", String(item.body.byteLength));
          res.setHeader("etag", item.etag);
          res.end();
          return;
        }
        if (req.method === "GET") {
          const item = s3Objects.get(key);
          if (!item) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", item.contentType);
          res.setHeader("content-length", String(item.body.byteLength));
          res.setHeader("etag", item.etag);
          res.end(item.body);
          return;
        }
        if (req.method === "DELETE") {
          s3Objects.delete(key);
          res.statusCode = 204;
          res.end();
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockS3Server.listen(0, "127.0.0.1", () => {
        const addr = mockS3Server.address();
        mockS3Port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }, 120_000);

  afterEach(() => {
    setStorageProviderForTesting(null);
  });

  afterAll(async () => {
    setStorageProviderForTesting(null);
    if (mockS3Server) await new Promise<void>((resolve) => mockS3Server.close(() => resolve()));
    if (workerPool) await workerPool.end();
    if (ctx) {
      await ctx.app.close();
      await ctx.pool.end();
    }
  });

  it("S3StorageProvider performs real SigV4 PUT, HEAD, GET, DELETE and presigned URLs against local mock S3", async () => {
    const s3 = new S3StorageProvider({
      bucket: "figbloom-test-bucket",
      region: "eu-west-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      endpoint: `http://127.0.0.1:${mockS3Port}`,
      forcePathStyle: true,
      presignTtlSeconds: 180,
    });

    const key = `tenants/${ids.tenantA}/general/test-file.pdf`;
    const payload = Buffer.from("%PDF-1.4\nhello world\n", "utf8");

    const put = await s3.putObject({ tenantId: ids.tenantA, objectKey: key, contentType: "application/pdf", body: payload });
    expect(put.status).toBe("ok");
    if (put.status === "ok") {
      expect(put.byteSize).toBe(payload.byteLength);
      expect(put.checksumSha256).toBe(createHash("sha256").update(payload).digest("hex"));
    }
    expect(s3SeenAuthHeaders.some((h) => h.startsWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/"))).toBe(true);

    const head = await s3.headObject({ tenantId: ids.tenantA, objectKey: key });
    expect(head.status).toBe("exists");
    if (head.status === "exists") expect(head.byteSize).toBe(payload.byteLength);

    const get = await s3.getObject({ tenantId: ids.tenantA, objectKey: key });
    expect(get.status).toBe("ok");
    if (get.status === "ok") expect(get.body.equals(payload)).toBe(true);

    const presignGet = await s3.createPresignedDownload({ tenantId: ids.tenantA, objectKey: key, downloadFilename: "report.pdf" });
    expect(presignGet.status).toBe("ready");
    if (presignGet.status === "ready") {
      expect(presignGet.url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
      expect(presignGet.url).toContain("X-Amz-Signature=");
      expect(presignGet.url).toContain("X-Amz-Expires=180");
      expect(presignGet.expiresInSeconds).toBe(180);
    }

    const del = await s3.deleteObject({ tenantId: ids.tenantA, objectKey: key });
    expect(del.status).toBe("deleted");

    const missing = await s3.getObject({ tenantId: ids.tenantA, objectKey: key });
    expect(missing.status).toBe("not_found");
  });

  it("enforces full upload lifecycle, MIME/size/filename validation, authorization, cross-tenant denial, deletion and abandoned cleanup", async () => {
    const s3 = new S3StorageProvider({
      bucket: "figbloom-test-bucket",
      region: "eu-west-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      endpoint: `http://127.0.0.1:${mockS3Port}`,
      forcePathStyle: true,
    });
    setStorageProviderForTesting(s3);

    // 1. Invalid MIME type rejected (400)
    const badMime = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "general",
        original_filename: "evil.exe",
        content_type: "application/x-msdownload",
        byte_size: 1024,
      },
    });
    expect(badMime.statusCode).toBe(400);

    // 2. Path traversal filename rejected (400)
    const badName = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "general",
        original_filename: "../../etc/passwd",
        content_type: "application/pdf",
        byte_size: 1024,
      },
    });
    expect(badName.statusCode).toBe(400);

    // 3. Oversized file rejected (400)
    const tooBig = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "general",
        original_filename: "huge.pdf",
        content_type: "application/pdf",
        byte_size: 50 * 1024 * 1024,
      },
    });
    expect(tooBig.statusCode).toBe(400);

    // 4. Unauthorized teacher without resource.document.write denied (403)
    const deniedWrite = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${teacherAToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "general",
        original_filename: "consent.pdf",
        content_type: "application/pdf",
        byte_size: 512,
      },
    });
    expect(deniedWrite.statusCode).toBe(403);

    // 5. Valid upload initiation returns presigned URL and pending_upload status
    const init = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "medication_authorization",
        original_filename: "consent-form.pdf",
        content_type: "application/pdf",
        byte_size: 19,
      },
    });
    expect(init.statusCode, JSON.stringify(init.json())).toBe(201);
    const objectId = init.json().object.id as string;
    expect(init.json().object.status).toBe("pending_upload");
    expect(init.json().upload.status).toBe("ready");
    // Raw object_key must never be exposed in public metadata
    expect(init.json().object.object_key).toBeUndefined();

    // 6. Completing before actual bytes exist in S3 returns 404 (prevents ghost uploads)
    const prematureComplete = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects/${objectId}/complete`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {},
    });
    expect(prematureComplete.statusCode).toBe(404);

    // 7. Upload actual bytes using the presigned URL
    const uploadUrl = init.json().upload.url as string;
    const putResp = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: "%PDF-1.4\nconsent!!\n" }); // exactly the 19 bytes declared at initiation (completion now verifies size)
    expect(putResp.ok).toBe(true);

    // 8. Complete upload -> status becomes available
    const completed = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects/${objectId}/complete`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().object.status).toBe("available");

    // 9. Authorized download URL succeeds and serves bytes
    const dl = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects/${objectId}/download-url`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.json().status).toBe("ready");
    const dlResp = await fetch(dl.json().url as string);
    expect(dlResp.ok).toBe(true);
    expect(await dlResp.text()).toBe("%PDF-1.4\nconsent!!\n");

    // 10. Cross-tenant access denied (403)
    const crossTenant = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects/${objectId}/download-url`,
      headers: { authorization: `Bearer ${teacherBToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(crossTenant.statusCode).toBe(403);

    // 11. Delete object -> subsequent download refused (409)
    const delRes = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tenants/${ids.tenantA}/storage/objects/${objectId}`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(delRes.statusCode).toBe(204);

    const dlAfterDel = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects/${objectId}/download-url`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(dlAfterDel.statusCode).toBe(409);

    // 12. Abandoned upload cleanup via worker maintenance
    setStorageProviderForTesting(new InMemoryStorageProvider());
    const staleId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO storage_objects (id, tenant_id, owner_resource_type, original_filename, content_type, byte_size, storage_provider, status, created_at)
       VALUES ($1, $2, 'general', 'abandoned.pdf', 'application/pdf', 128, 'mock', 'pending_upload', now() - interval '25 hours')`,
      [staleId, ids.tenantA],
    );
    await runMaintenance(workerPool, "test-storage-maint");
    const staleRow = await ctx.pool.query<{ status: string }>(`SELECT status FROM storage_objects WHERE id = $1`, [staleId]);
    expect(staleRow.rows[0]?.status).toBe("failed");

    // 13. Unconfigured provider returns honest 503
    setStorageProviderForTesting(new NotConfiguredStorageProvider());
    const unconfInit = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/storage/objects`,
      headers: { authorization: `Bearer ${adminToken}`, "x-tenant-id": ids.tenantA },
      payload: {
        owner_resource_type: "general",
        original_filename: "unconf.pdf",
        content_type: "application/pdf",
        byte_size: 128,
      },
    });
    expect(unconfInit.statusCode).toBe(201);
    expect(unconfInit.json().upload.status).toBe("not_configured");
  });

  describe("owner types (migration 102): per-type authorization, limits, and the family and self paths", () => {
    const A = () => ids.tenantA;
    const B = () => ids.tenantB;
    const H = (token: string, tenantId = A()) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenantId });
    const S = (tenantId = A()) => `/v1/tenants/${tenantId}/storage/objects`;
    const owner = async (sql: string, params: unknown[] = []) => (await ctx.pool.query(sql, params)).rows as Array<Record<string, any>>;

    let academicsToken: string;
    let feesToken: string;
    let peopleToken: string;
    let parentAToken: string;
    let parent2Token: string;
    let adminBToken: string;
    let orgAdminToken: string;
    let learner1: string; // parent A's child
    let invoice1: string; // parent A's child's invoice
    let invoice2: string; // parent 2's child's invoice
    let invoiceB: string; // an invoice of school B

    const useMockS3 = () =>
      setStorageProviderForTesting(
        new S3StorageProvider({
          bucket: "figbloom-test-bucket",
          region: "eu-west-1",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          endpoint: `http://127.0.0.1:${mockS3Port}`,
          forcePathStyle: true,
        }),
      );

    async function login(payload: Record<string, unknown>): Promise<string> {
      const r = await ctx.app.inject({ method: "POST", url: payload.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload });
      expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
      return r.json().token as string;
    }

    async function member(email: string | null, tenantId: string, role: string, loginId: string, area?: string): Promise<string> {
      const id = randomUUID();
      await owner(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, $2, password_hash, 'Storage member', 'active' FROM users WHERE id = $3`, [id, email, ids.adminA]);
      await owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [id, tenantId, role, loginId]);
      if (area) await owner(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, $3)`, [tenantId, id, area]);
      return id;
    }

    async function learnerWithInvoice(tenantId: string, tag: string): Promise<{ learner: string; invoice: string }> {
      const learner = (await owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Storage learner', 'female') RETURNING id`, [tenantId, `ST${tag}`]))[0]!.id as string;
      const year = (await owner(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, $2, '2020-01-01', '2035-12-31') RETURNING id`, [tenantId, `SY${tag}`]))[0]!.id as string;
      const term = (await owner(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, $3, '2020-01-01', '2035-12-31') RETURNING id`, [tenantId, year, `ST${tag}`]))[0]!.id as string;
      const invoice = (await owner(`INSERT INTO finance_invoices (tenant_id, learner_id, term_id, due_on) VALUES ($1, $2, $3, '2035-12-31') RETURNING id`, [tenantId, learner, term]))[0]!.id as string;
      return { learner, invoice };
    }

    /** guardian record + relationship + accepted invitation + live account link (the family link family_my_children() reads) */
    async function linkFamily(tenantId: string, learnerId: string, userId: string): Promise<void> {
      const guardian = randomUUID();
      await owner(`INSERT INTO guardians (id, tenant_id, full_name, phone) VALUES ($1, $2, 'Storage guardian', '+254700000222')`, [guardian, tenantId]);
      await owner(`INSERT INTO guardian_links (tenant_id, learner_id, guardian_id, relationship) VALUES ($1, $2, $3, 'mother')`, [tenantId, learnerId, guardian]);
      const inv = (await owner(
        `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status,
            contact_verification, created_at, expires_at, accepted_at, accepted_by)
         VALUES ($1,$2,$3,'email','st@example.com',$4,'accepted','token_and_contact_echo', now() - interval '1 hour', now() + interval '1 day', now(), $5)
         RETURNING id`,
        [tenantId, guardian, learnerId, createHash("sha256").update(randomUUID()).digest("hex"), userId],
      ))[0]!.id as string;
      await owner(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`, [tenantId, guardian, userId, inv]);
    }

    const init = (token: string, payload: Record<string, unknown>, tenantId = A()) =>
      ctx.app.inject({ method: "POST", url: S(tenantId), headers: H(token, tenantId), payload });
    const body = (type: string, ownerId: string | null, contentType = "application/pdf", byteSize = 16, filename = "file.pdf") => ({
      owner_resource_type: type,
      owner_resource_id: ownerId,
      original_filename: filename,
      content_type: contentType,
      byte_size: byteSize,
    });
    const get = (token: string, id: string, tenantId = A()) => ctx.app.inject({ method: "GET", url: `${S(tenantId)}/${id}`, headers: H(token, tenantId) });
    const download = (token: string, id: string, tenantId = A()) =>
      ctx.app.inject({ method: "POST", url: `${S(tenantId)}/${id}/download-url`, headers: H(token, tenantId) });
    const complete = (token: string, id: string) => ctx.app.inject({ method: "POST", url: `${S()}/${id}/complete`, headers: H(token), payload: {} });
    const remove = (token: string, id: string, tenantId = A()) => ctx.app.inject({ method: "DELETE", url: `${S(tenantId)}/${id}`, headers: H(token, tenantId) });

    /** init + PUT the exact bytes + complete, as `token`; returns the object id */
    async function upload(token: string, type: string, ownerId: string | null, contentType = "application/pdf", content = "%PDF-1.4\nstorage\n"): Promise<string> {
      const started = await init(token, body(type, ownerId, contentType, Buffer.byteLength(content)));
      expect(started.statusCode, `${type}: ${started.body}`).toBe(201);
      const id = started.json().object.id as string;
      const put = await fetch(started.json().upload.url as string, { method: "PUT", headers: { "content-type": contentType }, body: content });
      expect(put.ok).toBe(true);
      const done = await complete(token, id);
      expect(done.statusCode, `${type} complete: ${done.body}`).toBe(200);
      expect(done.json().object.status).toBe("available");
      return id;
    }

    beforeAll(async () => {
      await member("stor-acad@example.com", A(), "teacher", "TC-6601", "academics");
      await member("stor-fees@example.com", A(), "teacher", "TC-6602", "fees");
      await member("stor-ppl@example.com", A(), "teacher", "TC-6603", "people");
      const parent2 = await member(null, A(), "parent", "PT-6604");
      await member("stor-admin-b@example.com", B(), "school_admin", "AD-6605");
      academicsToken = await login({ email: "stor-acad@example.com", password: PASSWORD });
      feesToken = await login({ email: "stor-fees@example.com", password: PASSWORD });
      peopleToken = await login({ email: "stor-ppl@example.com", password: PASSWORD });
      adminBToken = await login({ email: "stor-admin-b@example.com", password: PASSWORD });
      orgAdminToken = await login({ email: "orgadmin@example.com", password: PASSWORD });
      parentAToken = await login({ tenantId: A(), loginId: "PT-0001", password: PASSWORD });
      parent2Token = await login({ tenantId: A(), loginId: "PT-6604", password: PASSWORD });

      const f1 = await learnerWithInvoice(A(), "F1");
      const f2 = await learnerWithInvoice(A(), "F2");
      learner1 = f1.learner;
      invoice1 = f1.invoice;
      invoice2 = f2.invoice;
      invoiceB = (await learnerWithInvoice(B(), "FB")).invoice;
      await linkFamily(A(), f1.learner, ids.parentA);
      await linkFamily(A(), f2.learner, parent2);
    }, 120_000);

    it("a school administrator uploads, finishes and downloads every new owner type; keys stay server-made", async () => {
      useMockS3();
      const cases: Array<[string, string | null, string]> = [
        ["payment_proof", invoice1, "application/pdf"],
        ["homework_attachment", null, "application/pdf"],
        ["learning_material", null, "application/pdf"],
        ["exam_paper", null, "application/pdf"],
        ["avatar", learner1, "image/png"],
        ["school_logo", null, "image/webp"],
      ];
      for (const [type, ownerId, contentType] of cases) {
        const id = await upload(adminToken, type, ownerId, contentType);
        const key = (await owner(`SELECT object_key FROM storage_objects WHERE id = $1`, [id]))[0]!.object_key as string;
        expect(key).toBe(`tenants/${A()}/${type}/${id}`);
        const dl = await download(adminToken, id);
        expect(dl.statusCode, type).toBe(200);
        expect(dl.json().status).toBe("ready");
      }
    });

    it("content types, sizes and owner ids are checked per owner type", async () => {
      useMockS3();
      const MIB = 1024 * 1024;
      const refused: Array<[string, Record<string, unknown>]> = [
        ["avatar as PDF", body("avatar", learner1, "application/pdf")],
        ["school logo as CSV", body("school_logo", null, "text/csv")],
        ["payment proof as DOCX", body("payment_proof", invoice1, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
        ["avatar over 5 MiB", body("avatar", learner1, "image/png", 5 * MIB + 1)],
        ["payment proof over 10 MiB", body("payment_proof", invoice1, "application/pdf", 10 * MIB + 1)],
        ["payment proof without an invoice", body("payment_proof", null)],
        ["avatar without a person", body("avatar", null, "image/png")],
        ["payment proof naming another school's invoice", body("payment_proof", invoiceB)],
        ["payment proof naming no invoice", body("payment_proof", randomUUID())],
        ["avatar of someone outside the school", body("avatar", ids.teacherB, "image/png")],
      ];
      for (const [label, payload] of refused) {
        const r = await init(adminToken, payload);
        expect(r.statusCode, `${label}: ${r.body}`).toBe(400);
      }
      // within each type's own limit
      expect((await init(adminToken, body("homework_attachment", null, "application/pdf", 20 * MIB))).statusCode).toBe(201);
      expect((await init(adminToken, body("payment_proof", invoice1, "image/jpeg", 10 * MIB))).statusCode).toBe(201);
      // the database refuses an owner-less proof or avatar even from the table owner
      await expect(
        owner(`INSERT INTO storage_objects (tenant_id, owner_resource_type, original_filename, content_type, byte_size) VALUES ($1, 'payment_proof', 'x.pdf', 'application/pdf', 1)`, [A()]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("staff reach only the owner types of their own area", async () => {
      useMockS3();
      const proof = await upload(adminToken, "payment_proof", invoice1);
      const material = await upload(adminToken, "learning_material", null);
      const exam = await upload(adminToken, "exam_paper", null);
      const logo = await upload(adminToken, "school_logo", null, "image/png", "PNGDATA");

      // Academics area: academic files only
      const homework = await upload(academicsToken, "homework_attachment", null);
      expect((await get(academicsToken, material)).statusCode).toBe(200);
      expect((await init(academicsToken, body("payment_proof", invoice1))).statusCode).toBe(403);
      expect((await init(academicsToken, body("school_logo", null, "image/png"))).statusCode).toBe(403);
      expect((await init(academicsToken, body("general", null))).statusCode).toBe(403);
      expect((await download(academicsToken, proof)).statusCode).toBe(403);
      expect((await get(academicsToken, randomUUID())).statusCode).toBe(404); // staff: a missing object is 404
      expect((await remove(academicsToken, homework)).statusCode).toBe(204);

      // Fees area: reads proofs; submitting one for a family is the office's (finance administer) job, as in POST /finance/proofs
      expect((await download(feesToken, proof)).statusCode).toBe(200);
      expect((await init(feesToken, body("payment_proof", invoice1))).statusCode).toBe(403);
      expect((await get(feesToken, exam)).statusCode).toBe(403);
      expect((await remove(feesToken, proof)).statusCode).toBe(403);

      // People area: photos, not the crest and not money
      expect((await init(peopleToken, body("avatar", learner1, "image/png"))).statusCode).toBe(201);
      expect((await init(peopleToken, body("school_logo", null, "image/png"))).statusCode).toBe(403);
      expect((await download(peopleToken, logo)).statusCode).toBe(200);
      expect((await remove(peopleToken, logo)).statusCode).toBe(403);
      expect((await get(peopleToken, proof)).statusCode).toBe(403);

      // A plain teacher holds none of these: staff types are refused, and a missing object is 403, not 404
      expect((await init(teacherAToken, body("exam_paper", null))).statusCode).toBe(403);
      expect((await get(teacherAToken, exam)).statusCode).toBe(403);
      expect((await get(teacherAToken, randomUUID())).statusCode).toBe(403);
    });

    it("a family touches only payment proofs of its own children's invoices", async () => {
      useMockS3();
      const own = await upload(parentAToken, "payment_proof", invoice1, "image/jpeg", "JPEGBYTES");
      expect((await get(parentAToken, own)).statusCode).toBe(200);
      expect((await download(parentAToken, own)).statusCode).toBe(200);
      // a proof the office recorded for the same child is the family's too
      const office = await upload(adminToken, "payment_proof", invoice1);
      expect((await download(parentAToken, office)).statusCode).toBe(200);

      // another family, another school, an invoice that does not exist: the same 403
      expect((await init(parentAToken, body("payment_proof", invoice2))).statusCode).toBe(403);
      expect((await init(parentAToken, body("payment_proof", invoiceB))).statusCode).toBe(403);
      expect((await init(parentAToken, body("payment_proof", randomUUID()))).statusCode).toBe(403);
      expect((await get(parent2Token, own)).statusCode).toBe(403);
      expect((await download(parent2Token, office)).statusCode).toBe(403);

      // finishing is for the uploader only; a family never deletes
      const pending = await init(parentAToken, body("payment_proof", invoice1));
      expect(pending.statusCode).toBe(201);
      expect((await complete(parent2Token, pending.json().object.id as string)).statusCode).toBe(403);
      const officePending = await init(adminToken, body("payment_proof", invoice1));
      expect((await complete(parentAToken, officePending.json().object.id as string)).statusCode).toBe(403);
      expect((await remove(parentAToken, own)).statusCode).toBe(403);

      // nothing outside payment proofs (and their own avatar)
      for (const [type, contentType] of [["homework_attachment", "application/pdf"], ["exam_paper", "application/pdf"], ["learning_material", "application/pdf"], ["school_logo", "image/png"], ["general", "application/pdf"], ["directory_document", "application/pdf"]] as const) {
        expect((await init(parentAToken, body(type, null, contentType))).statusCode, type).toBe(403);
      }
      const material = await upload(adminToken, "learning_material", null);
      expect((await get(parentAToken, material)).statusCode).toBe(403);
      expect((await get(parentAToken, randomUUID())).statusCode).toBe(403);

      // the link is checked live: once the account link is revoked, the family's own proof is closed to it
      await owner(`UPDATE guardian_accounts SET revoked_at = now(), revoke_reason = 'storage test' WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [ids.parentA, A()]);
      expect((await get(parentAToken, own)).statusCode).toBe(403);
      expect((await init(parentAToken, body("payment_proof", invoice1))).statusCode).toBe(403);
    });

    it("a member manages only their own avatar, and every member can read the school logo", async () => {
      useMockS3();
      const mine = await upload(teacherAToken, "avatar", ids.teacherA, "image/png", "PNGSELF");
      expect((await get(teacherAToken, mine)).statusCode).toBe(200);
      expect((await download(teacherAToken, mine)).statusCode).toBe(200);
      expect((await init(teacherAToken, body("avatar", ids.parentA, "image/png"))).statusCode).toBe(403);

      const parentPhoto = await upload(adminToken, "avatar", ids.parentA, "image/png", "PNGPARENT");
      expect((await get(teacherAToken, parentPhoto)).statusCode).toBe(403);
      expect((await get(parentAToken, parentPhoto)).statusCode).toBe(200);
      expect((await remove(teacherAToken, parentPhoto)).statusCode).toBe(403);
      // a pending photo of the teacher started by the office is finished by the office, not by the teacher
      const officeStarted = await init(adminToken, body("avatar", ids.teacherA, "image/png"));
      expect((await complete(teacherAToken, officeStarted.json().object.id as string)).statusCode).toBe(403);
      expect((await remove(teacherAToken, mine)).statusCode).toBe(204);

      const logo = await upload(adminToken, "school_logo", null, "image/png", "PNGCREST");
      expect((await download(teacherAToken, logo)).statusCode).toBe(200);
      expect((await get(parent2Token, logo)).statusCode).toBe(200);
      expect((await remove(teacherAToken, logo)).statusCode).toBe(403);
      expect((await init(teacherAToken, body("school_logo", null, "image/png"))).statusCode).toBe(403);

      // an organisation administrator without a delegation is not a member: refused before the body is read
      expect((await get(orgAdminToken, logo)).statusCode).toBe(403);
      expect((await init(orgAdminToken, {})).statusCode).toBe(403);
      expect((await init(orgAdminToken, body("avatar", ids.orgAdmin, "image/png"))).statusCode).toBe(403);
    });

    it("another school never reaches these objects", async () => {
      useMockS3();
      const proof = await upload(adminToken, "payment_proof", invoice1);
      const logo = await upload(adminToken, "school_logo", null, "image/png", "PNGCREST2");
      // school B's administrator naming school A
      expect((await init(adminBToken, body("exam_paper", null))).statusCode).toBe(403);
      expect((await get(adminBToken, logo)).statusCode).toBe(403);
      expect((await download(adminBToken, proof)).statusCode).toBe(403);
      expect((await remove(adminBToken, proof)).statusCode).toBe(403);
      // school B's administrator in their own school cannot see school A's object ids at all
      expect((await get(adminBToken, logo, B())).statusCode).toBe(404);
      expect((await download(adminBToken, proof, B())).statusCode).toBe(404);
      expect((await remove(adminBToken, proof, B())).statusCode).toBe(404);
      // a school B proof cannot name school A's invoice
      expect((await init(adminBToken, body("payment_proof", invoice1), B())).statusCode).toBe(400);
      // school A's administrator naming school B
      expect((await get(adminToken, logo, B())).statusCode).toBe(403);
      expect((await owner(`SELECT status FROM storage_objects WHERE id = $1`, [proof]))[0]!.status).toBe("available");
    });
  });
});
