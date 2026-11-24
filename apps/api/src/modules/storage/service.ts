import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { validateContentForOwnerType, type OwnerResourceType } from "./ownerTypes.js";
import { getStorageProvider, type StorageProvider } from "./storageProvider.js";

export type { OwnerResourceType } from "./ownerTypes.js";

export interface StorageObjectRecord {
  id: string;
  tenant_id: string;
  owner_resource_type: OwnerResourceType;
  owner_resource_id: string | null;
  uploaded_by: string | null;
  object_key: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string | null;
  storage_provider: "s3" | "mock" | "not_configured";
  status: "pending_upload" | "available" | "failed" | "deleted";
  expires_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicStorageObject {
  id: string;
  owner_resource_type: OwnerResourceType;
  owner_resource_id: string | null;
  original_filename: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string | null;
  storage_provider: "s3" | "mock" | "not_configured";
  status: "pending_upload" | "available" | "failed" | "deleted";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// Content types and size limits are per owner type (OWNER_TYPE_RULES in ./ownerTypes.ts).

// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[\\/\u0000-\u001f\u007f]/;

const COLS = `id, tenant_id, owner_resource_type, owner_resource_id, uploaded_by, object_key,
  original_filename, content_type, byte_size, checksum_sha256, storage_provider, status,
  expires_at, deleted_at, created_at, updated_at`;

export function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255 || UNSAFE_FILENAME.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw validationError("Invalid filename: path separators and control characters are not allowed");
  }
  return trimmed;
}

export function toPublicStorageObject(row: StorageObjectRecord): PublicStorageObject {
  return {
    id: row.id,
    owner_resource_type: row.owner_resource_type,
    owner_resource_id: row.owner_resource_id,
    original_filename: row.original_filename,
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
    checksum_sha256: row.checksum_sha256,
    storage_provider: row.storage_provider,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createPendingStorageObject(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string | null;
    ownerResourceType: OwnerResourceType;
    ownerResourceId?: string | null;
    originalFilename: string;
    contentType: string;
    byteSize: number;
    checksumSha256?: string | null;
    expiresAt?: Date | null;
    provider?: StorageProvider;
    ip?: string | null;
  },
): Promise<StorageObjectRecord> {
  const filename = sanitizeFilename(input.originalFilename);
  const { contentType, byteSize } = validateContentForOwnerType(input.ownerResourceType, input.contentType, input.byteSize);
  const provider = input.provider ?? getStorageProvider();

  const res = await tx.query<StorageObjectRecord>(
    `INSERT INTO storage_objects (
       tenant_id, owner_resource_type, owner_resource_id, uploaded_by, object_key,
       original_filename, content_type, byte_size, checksum_sha256, storage_provider, status, expires_at
     ) VALUES ($1, $2, $3, $4, 'server_generated', $5, $6, $7, $8, $9, 'pending_upload', $10)
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.ownerResourceType,
      input.ownerResourceId ?? null,
      input.actorUserId,
      filename,
      contentType,
      byteSize,
      input.checksumSha256 ?? null,
      provider.providerName,
      input.expiresAt ? input.expiresAt.toISOString() : null,
    ],
  );
  const row = res.rows[0]!;
  if (input.actorUserId) {
    await recordSecurityEvent(tx, {
      eventType: "storage.object.upload_initiated",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      ip: input.ip,
      detail: { objectId: row.id, ownerResourceType: row.owner_resource_type, contentType, byteSize },
    });
  }
  return row;
}

/** One object of this school, or null (RLS and the tenant filter both confine it to the school of the request). */
export async function findStorageObjectById(tx: Tx, tenantId: string, objectId: string): Promise<StorageObjectRecord | null> {
  const res = await tx.query<StorageObjectRecord>(
    `SELECT ${COLS} FROM storage_objects WHERE tenant_id = $1 AND id = $2`,
    [tenantId, objectId],
  );
  return res.rows[0] ?? null;
}

export async function getStorageObjectById(tx: Tx, tenantId: string, objectId: string): Promise<StorageObjectRecord> {
  const row = await findStorageObjectById(tx, tenantId, objectId);
  if (!row) throw notFound("Storage object not found");
  return row;
}

export async function markStorageObjectAvailable(
  tx: Tx,
  input: {
    tenantId: string;
    objectId: string;
    actorUserId: string | null;
    byteSize?: number;
    checksumSha256?: string | null;
    ip?: string | null;
  },
): Promise<StorageObjectRecord> {
  const existing = await getStorageObjectById(tx, input.tenantId, input.objectId);
  if (existing.status !== "pending_upload") throw conflict(`Only a pending upload can be finalized (status: ${existing.status})`);
  const res = await tx.query<StorageObjectRecord>(
    `UPDATE storage_objects
        SET status = 'available',
            byte_size = COALESCE($3, byte_size),
            checksum_sha256 = COALESCE($4, checksum_sha256)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [input.tenantId, input.objectId, input.byteSize ?? null, input.checksumSha256 ?? null],
  );
  const row = res.rows[0]!;
  if (input.actorUserId) {
    await recordSecurityEvent(tx, {
      eventType: "storage.object.upload_completed",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      ip: input.ip,
      detail: { objectId: row.id, byteSize: Number(row.byte_size) },
    });
  }
  return row;
}

export async function markStorageObjectDeleted(
  tx: Tx,
  input: { tenantId: string; objectId: string; actorUserId: string; ip?: string | null },
): Promise<StorageObjectRecord> {
  const res = await tx.query<StorageObjectRecord>(
    `UPDATE storage_objects
        SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), deleted_by = COALESCE(deleted_by, $3)
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [input.tenantId, input.objectId, input.actorUserId],
  );
  if (!res.rows[0]) throw notFound("Storage object not found");
  await recordSecurityEvent(tx, {
    eventType: "storage.object.deleted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    ip: input.ip,
    detail: { objectId: input.objectId },
  });
  return res.rows[0];
}
