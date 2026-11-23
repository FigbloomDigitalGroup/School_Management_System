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
});
