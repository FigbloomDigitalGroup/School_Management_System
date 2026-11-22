import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { loadEffectivePermissions, requirePermission } from "../../modules/rbac/authorize.js";
import type { AuthzContext } from "../../modules/rbac/authorize.js";
import { attachDenialAudit } from "../../db/errors.js";
import type { Tx } from "../../db/sql.js";
import {
  archiveDocument,
  getDocumentById,
  listDocumentsPage,
  registerDocument,
} from "../../modules/directory/documents.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { AppError, forbidden, notFound, validationError } from "../errors.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { withTenantRequest } from "../tenantRequest.js";
import { getStorageProvider } from "../../modules/storage/storageProvider.js";
import { parseOrThrow } from "../validation.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";

const UuidParam = uuidString;
const SubjectType = z.enum(["learner", "guardian", "staff"]);

const RegisterSchema = z.strictObject({
  subject_type: SubjectType,
  subject_id: uuidString,
  doc_type: z.string().min(1).max(64),
  file_name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(128).nullable().optional(),
  byte_size: z.number().int().min(0).max(104_857_600).nullable().optional(),
  // F-04: there is deliberately no storage_key. strictObject rejects it with 400; the database
  // generates the only key that will ever exist for the row.
});

/**
 * F-01: a document whose subject is a guardian describes guardian PII (contact scans, ID copies).
 * It therefore needs the explicit guardian resource permission IN ADDITION to the document
 * permission. `area.people` never implies it (FIG-1614 stays open and unwidened).
 *
 * P3-AUDIT-010 extends the same rule to the other two subject types. A document record names the
 * subject it belongs to, and registering one answers "does this learner id exist in this school?"
 * (404 vs 201). A caller holding `resource.document.*` without `resource.learner.read` could
 * therefore enumerate the roster through the documents API. The subject permission is now
 * required for every subject type, so document access never exceeds access to the thing the
 * document is about. In practice nothing loses access: `area.people` implies learner, staff and
 * document read/write together, and a full administrator holds all of them — only an explicitly
 * narrowed grant or delegation is affected, which is exactly the case the rule exists for.
 */
/** Exported so tests can pin the exact mapping: widening it is a security change. */
export const SUBJECT_READ_PERMISSION: Record<DocumentSubject, string> = {
  learner: "resource.learner.read",
  guardian: "resource.guardian.read",
  staff: "resource.staff.read",
};

/**
 * Writing a document about a subject needs the permission that lets the caller name that
 * subject. For learners and staff that is the read permission (the directory has no separate
 * "may attach things to" power); for guardians it is `resource.guardian.write`, which F-01
 * already required.
 */
export const SUBJECT_WRITE_PERMISSION: Record<DocumentSubject, string> = {
  learner: "resource.learner.read",
  guardian: "resource.guardian.write",
  staff: "resource.staff.read",
};

type DocumentSubject = "learner" | "guardian" | "staff";

/**
 * The subject types the caller may NOT see, so an unfiltered listing silently omits them instead
 * of refusing the whole page (the behaviour F-01 established for guardians).
 */
async function hiddenSubjectTypes(tx: Tx, authz: AuthzContext): Promise<DocumentSubject[]> {
  const perms = await loadEffectivePermissions(tx, authz);
  return (["learner", "guardian", "staff"] as const).filter(
    (subject) => !perms.has(SUBJECT_READ_PERMISSION[subject]),
  );
}

async function mayReadSubject(tx: Tx, authz: AuthzContext, subject: DocumentSubject): Promise<boolean> {
  const perms = await loadEffectivePermissions(tx, authz);
  return perms.has(SUBJECT_READ_PERMISSION[subject]);
}

async function mayWriteSubject(tx: Tx, authz: AuthzContext, subject: DocumentSubject): Promise<boolean> {
  const perms = await loadEffectivePermissions(tx, authz);
  return perms.has(SUBJECT_WRITE_PERMISSION[subject]);
}

/**
 * 404 (not 403) for a document whose subject the caller may not see, so a document id does not
 * reveal which kind of subject it belongs to. The denial is still audited after the transaction
 * rolls back.
 */
function hiddenDocument(authz: AuthzContext, permission: string, ip: string | null): AppError {
  const err = notFound("Document not found");
  attachDenialAudit(err, {
    eventType: "rbac.permission.denied",
    actorUserId: authz.userId,
    tenantId: authz.tenantId,
    detail: { permission, role: authz.role, isOrgAdminForTenant: authz.isOrgAdminForTenant, resource: "document" },
    ip,
  });
  return err;
}

export async function registerDocumentRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post("/v1/tenants/:tenantId/documents", async (request, reply) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (request.body && typeof request.body === "object" && "permissions" in request.body) {
      throw forbidden("Client-supplied permissions are not accepted");
    }
    const parsed = parseOrThrow(
      RegisterSchema,
      request.body,
      "subject_type, subject_id, doc_type and file_name are required (storage keys are assigned by the server)",
    );
    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    const out = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.document.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      // Checked BEFORE the subject lookup so the response never confirms a subject id exists
      // (P3-AUDIT-010; F-01 for the guardian case).
      await requirePermission(tx, auth.authz, SUBJECT_WRITE_PERMISSION[parsed.subject_type], {
        ip: clientIp(request),
        deferAudit: true,
      });
      return runIdempotent(tx, {
        key,
        config: app.appConfig,
        routeTemplate: "POST /v1/tenants/:tenantId/documents",
        fingerprintInput: { params, body: parsed },
        status: 201,
        execute: async () => {
          const document = await registerDocument(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            ...parsed,
            ip: clientIp(request),
          });
          return { value: { document }, resourceType: "document", resourceId: document.id };
        },
        replay: async (_type, id) => {
          try {
            return { document: await getDocumentById(tx, { tenantId: params.tenantId, documentId: id }) };
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 404) return null;
            throw err;
          }
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get("/v1/tenants/:tenantId/documents", async (request) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    const query = request.query as Record<string, unknown>;
    let subject_type: "learner" | "guardian" | "staff" | null = null;
    if (typeof query.subject_type === "string" && query.subject_type !== "") {
      const parsed = SubjectType.safeParse(query.subject_type);
      if (!parsed.success) throw validationError("subject_type must be learner, guardian or staff");
      subject_type = parsed.data;
    }
    const subject_id =
      typeof query.subject_id === "string" && query.subject_id !== "" ? query.subject_id : null;
    if (subject_id && !UuidParam.safeParse(subject_id).success) {
      throw validationError("subject_id must be a UUID");
    }
    const includeArchived = query.include_archived === "true";
    const list = parseListQuery(query, {
      sort: "created",
      filter: { resource: "documents", tenantId: params.tenantId, subject_type, subject_id, includeArchived },
      keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
    });
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.document.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const hidden = await hiddenSubjectTypes(tx, auth.authz);
      // An explicit filter on a subject type the caller may not read is a 403, not an empty page:
      // the caller asked for something they are not allowed to ask for.
      if (subject_type && hidden.includes(subject_type)) {
        await requirePermission(tx, auth.authz, SUBJECT_READ_PERMISSION[subject_type], {
          ip: clientIp(request),
          deferAudit: true,
        });
      }
      const rows = await listDocumentsPage(tx, {
        tenantId: params.tenantId,
        limit: list.limit,
        cursorKeys: list.cursor?.k ?? null,
        subject_type,
        subject_id,
        includeArchived,
        // Unfiltered and subject_id-only listings silently omit the subject types the caller may
        // not read, instead of refusing the whole page.
        excludeSubjectTypes: hidden,
      });
      const page = pageFromKeysetRows(rows, {
        limit: list.limit,
        sort: list.sort,
        fingerprint: list.fingerprint,
        keysOf: (row) => [row._sort_created, row.id],
      });
      return {
        documents: page.items.map(({ _sort_created: _, ...doc }) => doc),
        page: page.page,
      };
    });
  });

  app.get("/v1/tenants/:tenantId/documents/:documentId", async (request) => {
    const params = request.params as { tenantId: string; documentId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.documentId).success) throw validationError("documentId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.document.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const document = await getDocumentById(tx, {
        tenantId: params.tenantId,
        documentId: params.documentId,
      });
      if (!(await mayReadSubject(tx, auth.authz, document.subject_type))) {
        throw hiddenDocument(
          auth.authz,
          SUBJECT_READ_PERMISSION[document.subject_type],
          clientIp(request),
        );
      }
      return { document };
    });
  });

  app.post("/v1/tenants/:tenantId/documents/:documentId/archive", async (request) => {
    const params = request.params as { tenantId: string; documentId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.documentId).success) throw validationError("documentId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.document.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const existing = await getDocumentById(tx, {
        tenantId: params.tenantId,
        documentId: params.documentId,
      });
      if (!(await mayWriteSubject(tx, auth.authz, existing.subject_type))) {
        throw hiddenDocument(
          auth.authz,
          SUBJECT_WRITE_PERMISSION[existing.subject_type],
          clientIp(request),
        );
      }
      return {
        document: await archiveDocument(tx, {
          tenantId: params.tenantId,
          documentId: params.documentId,
          actorUserId: auth.user.id,
          ip: clientIp(request),
        }),
      };
    });
  });

  app.post("/v1/tenants/:tenantId/documents/:documentId/storage-presign", async (request, reply) => {
    const params = request.params as { tenantId: string; documentId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (!UuidParam.safeParse(params.documentId).success) throw validationError("documentId must be a UUID");
    const body = parseOrThrow(
      z.strictObject({ operation: z.enum(["put", "get"]) }),
      request.body,
      "operation (put|get) is required",
    );
    const doc = await withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      const perm = body.operation === "put" ? "resource.document.write" : "resource.document.read";
      await requirePermission(tx, auth.authz, perm, { ip: clientIp(request), deferAudit: true });
      const existing = await getDocumentById(tx, { tenantId: params.tenantId, documentId: params.documentId });
      const mayAccess =
        body.operation === "put"
          ? await mayWriteSubject(tx, auth.authz, existing.subject_type)
          : await mayReadSubject(tx, auth.authz, existing.subject_type);
      if (!mayAccess) {
        const subjectPerm =
          body.operation === "put" ? SUBJECT_WRITE_PERMISSION[existing.subject_type] : SUBJECT_READ_PERMISSION[existing.subject_type];
        throw hiddenDocument(auth.authz, subjectPerm, clientIp(request));
      }
      return existing;
    });
    const out =
      body.operation === "put"
        ? await getStorageProvider().createPresignedUpload({
            tenantId: params.tenantId,
            objectKey: `${params.tenantId}/${doc.id}`,
            contentType: doc.content_type ?? "application/octet-stream",
            maxBytes: doc.byte_size ?? 10 * 1024 * 1024,
          })
        : await getStorageProvider().createPresignedDownload({
            tenantId: params.tenantId,
            objectKey: `${params.tenantId}/${doc.id}`,
          });
    if (out.status === "not_configured") return reply.status(503).send(out);
    return reply.status(200).send(out);
  });
}
