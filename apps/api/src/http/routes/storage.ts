import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import {
  createPendingStorageObject,
  getStorageObjectById,
  markStorageObjectAvailable,
  markStorageObjectDeleted,
  toPublicStorageObject,
} from "../../modules/storage/service.js";
import { getStorageProvider } from "../../modules/storage/storageProvider.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { conflict, notFound } from "../errors.js";
import { assertUuid, inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const InitUploadBody = z.strictObject({
  owner_resource_type: z.enum(["directory_document", "export_artifact", "medication_authorization", "general"]),
  owner_resource_id: z.guid().nullable().optional(),
  original_filename: z.string().min(1).max(255),
  content_type: z.string().min(3).max(128),
  byte_size: z.number().int().min(1).max(26_214_400),
  checksum_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});

const CompleteUploadBody = z.strictObject({
  checksum_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});

export const STORAGE_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/storage/objects": InitUploadBody,
  "POST /v1/tenants/{tenantId}/storage/objects/{objectId}/complete": CompleteUploadBody,
} as const;

const P = "/v1/tenants/:tenantId/storage/objects";

export async function registerStorageRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(P, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const provider = getStorageProvider();

    const record = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.write", { ip, deferAudit: true });
      const body = parseOrThrow(InitUploadBody, request.body, "owner_resource_type, original_filename, content_type and byte_size are required");
      return createPendingStorageObject(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        ownerResourceType: body.owner_resource_type,
        ownerResourceId: body.owner_resource_id,
        originalFilename: body.original_filename,
        contentType: body.content_type,
        byteSize: body.byte_size,
        checksumSha256: body.checksum_sha256,
        provider,
        ip,
      });
    });

    const presign = await provider.createPresignedUpload({
      tenantId: params.tenantId,
      objectKey: record.object_key,
      contentType: record.content_type,
      maxBytes: Number(record.byte_size),
    });

    return reply.status(201).send({
      object: toPublicStorageObject(record),
      upload: presign,
    });
  });

  app.post(`${P}/:objectId/complete`, async (request) => {
    const params = request.params as { tenantId: string; objectId: string };
    assertUuid(params.objectId, "objectId");
    const body = parseOrThrow(CompleteUploadBody, request.body ?? {}, "invalid body");
    const provider = getStorageProvider();

    const existing = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.write", { ip, deferAudit: true });
      return getStorageObjectById(tx, params.tenantId, params.objectId);
    });
    if (existing.status !== "pending_upload") throw conflict(`Only a pending upload can be finalized (status: ${existing.status})`);

    let verifiedSize: number | undefined;
    if (provider.configured) {
      const head = await provider.headObject({ tenantId: params.tenantId, objectKey: existing.object_key });
      if (head.status === "not_found") throw notFound("Uploaded object not found in storage provider");
      if (head.status === "error") throw conflict("Unable to verify uploaded object in storage provider");
      if (head.status === "exists") {
        // The stored object must be exactly what was declared at initiation; otherwise it is removed, not accepted.
        const typeOk = !head.contentType || head.contentType.split(";")[0]!.trim().toLowerCase() === existing.content_type;
        if (head.byteSize !== Number(existing.byte_size) || !typeOk) {
          await provider.deleteObject({ tenantId: params.tenantId, objectKey: existing.object_key });
          await inTenant(app, pool, request, params.tenantId, async ({ tx }) => {
            await tx.query(`UPDATE storage_objects SET status = 'failed' WHERE tenant_id = $1 AND id = $2 AND status = 'pending_upload'`, [
              params.tenantId,
              params.objectId,
            ]);
          });
          throw conflict("The uploaded object does not match the declared size or content type and was discarded");
        }
        verifiedSize = head.byteSize;
      }
    }

    const updated = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.write", { ip, deferAudit: true });
      return markStorageObjectAvailable(tx, {
        tenantId: params.tenantId,
        objectId: params.objectId,
        actorUserId: auth.user.id,
        byteSize: verifiedSize,
        checksumSha256: body.checksum_sha256,
        ip,
      });
    });

    return { object: toPublicStorageObject(updated) };
  });

  app.get(`${P}/:objectId`, async (request) => {
    const params = request.params as { tenantId: string; objectId: string };
    assertUuid(params.objectId, "objectId");
    const record = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.read", { ip, deferAudit: true });
      return getStorageObjectById(tx, params.tenantId, params.objectId);
    });
    return { object: toPublicStorageObject(record) };
  });

  app.post(`${P}/:objectId/download-url`, async (request, reply) => {
    const params = request.params as { tenantId: string; objectId: string };
    assertUuid(params.objectId, "objectId");
    const record = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.read", { ip, deferAudit: true });
      const obj = await getStorageObjectById(tx, params.tenantId, params.objectId);
      if (obj.status !== "available") throw conflict("Storage object is not available for download");
      await recordSecurityEvent(tx, {
        eventType: "storage.object.download_authorized",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { objectId: obj.id, ownerResourceType: obj.owner_resource_type },
      });
      return obj;
    });
    const out = await getStorageProvider().createPresignedDownload({
      tenantId: params.tenantId,
      objectKey: record.object_key,
      downloadFilename: record.original_filename,
    });
    if (out.status === "not_configured") return reply.status(503).send(out);
    return reply.status(200).send(out);
  });

  app.delete(`${P}/:objectId`, async (request, reply) => {
    const params = request.params as { tenantId: string; objectId: string };
    assertUuid(params.objectId, "objectId");
    const record = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.write", { ip, deferAudit: true });
      return getStorageObjectById(tx, params.tenantId, params.objectId);
    });
    const provider = getStorageProvider();
    if (provider.configured) {
      const del = await provider.deleteObject({ tenantId: params.tenantId, objectKey: record.object_key });
      if (del.status !== "deleted") throw conflict("The object could not be removed from storage; it was not marked deleted. Try again.");
    }
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.document.write", { ip, deferAudit: true });
      await markStorageObjectDeleted(tx, {
        tenantId: params.tenantId,
        objectId: params.objectId,
        actorUserId: auth.user.id,
        ip,
      });
    });
    return reply.status(204).send();
  });
}
