import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { calendarDateString } from "../schemas.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";
import { pageQuery } from "../../modules/academics/pagination.js";

const ENTRY_KINDS = [
  "education_level",
  "pathway",
  "grade",
  "learning_area",
  "subject",
  "strand",
  "sub_strand",
  "learning_outcome",
  "learning_experience",
  "core_competency",
  "value",
  "pci",
  "assessment_method",
] as const;

const ImportEntrySchema = z.strictObject({
  entry_kind: z.enum(ENTRY_KINDS),
  code: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).nullable().optional(),
  education_level: z.string().max(64).nullable().optional(),
  grade_band: z.string().max(64).nullable().optional(),
  pathway: z.string().max(64).nullable().optional(),
  parent_code: z.string().max(64).nullable().optional(),
  known_limitations: z.string().max(1000).nullable().optional(),
});

const ImportBatchBody = z.strictObject({
  source_organisation: z.string().min(1).max(120),
  source_title: z.string().min(1).max(200),
  source_uri: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//i.test(u), "source_uri must be an http(s) URL")
    .nullable()
    .optional(),
  publication_or_version: z.string().max(120).nullable().optional(),
  retrieved_at: calendarDateString,
  entries: z.array(z.unknown()).min(1).max(200),
});

const ReviewEntryBody = z.strictObject({
  action: z.enum(["submit_for_review", "verify", "reject"]),
  review_note: z.string().max(1000).nullable().optional(),
});

const SupersedeEntryBody = z.strictObject({
  title: z.string().min(1).max(200),
  body: z.string().max(4000).nullable().optional(),
  publication_or_version: z.string().max(120).nullable().optional(),
  review_note: z.string().max(1000).nullable().optional(),
});

export const CURRICULUM_CATALOGUE_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/academics/cbe/curriculum-catalogue/import-batches": ImportBatchBody,
  "POST /v1/tenants/{tenantId}/academics/cbe/curriculum-catalogue/entries/{entryId}/review": ReviewEntryBody,
  "POST /v1/tenants/{tenantId}/academics/cbe/curriculum-catalogue/entries/{entryId}/supersede": SupersedeEntryBody,
} as const;

const P = "/v1/tenants/:tenantId/academics/cbe/curriculum-catalogue";

function mapDbErr(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "P0002") throw notFound(e.message ?? "Catalogue entry not found");
  if (e.code === "42501") throw forbidden(e.message ?? "Insufficient permission for catalogue action");
  if (e.code === "23514") throw conflict(e.message ?? "Invalid catalogue state transition");
  throw err;
}

export async function registerCurriculumCatalogueRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(`${P}/import-batches`, async (request, reply) => {
    const params = request.params as { tenantId: string };

    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.curriculum.verify", { ip, deferAudit: true });
      const body = parseOrThrow(ImportBatchBody, request.body, "source_organisation, source_title, retrieved_at and entries are required");

      const checksum = createHash("sha256").update(JSON.stringify(body.entries)).digest("hex");
      const batchRes = await tx.query<{ id: string }>(
        `INSERT INTO curriculum_import_batches (
           tenant_id, source_organisation, source_title, source_uri, publication_or_version,
           retrieved_at, source_checksum, imported_by, status, total_rows
         ) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'pending', $9)
         RETURNING id`,
        [
          params.tenantId,
          body.source_organisation.trim(),
          body.source_title.trim(),
          body.source_uri ?? null,
          body.publication_or_version ?? null,
          body.retrieved_at,
          checksum,
          auth.user.id,
          body.entries.length,
        ],
      );
      const batchId = batchRes.rows[0]!.id;

      // Ensure a curriculum_provenance record exists for this tenant batch
      const provRes = await tx.query<{ id: string }>(
        `INSERT INTO curriculum_provenance (tenant_id, source_kind, source_label, source_uri)
         VALUES ($1, 'import_pending', $2, $3)
         RETURNING id`,
        [params.tenantId, `${body.source_organisation.trim()}: ${body.source_title.trim()}`.slice(0, 160), body.source_uri ?? null],
      );
      const provenanceId = provRes.rows[0]!.id;

      let importedCount = 0;
      let duplicateCount = 0;
      const errors: Array<{ index: number; message: string }> = [];
      const importedIds: string[] = [];

      for (let i = 0; i < body.entries.length; i++) {
        const parsed = ImportEntrySchema.safeParse(body.entries[i]);
        if (!parsed.success) {
          errors.push({ index: i, message: parsed.error.issues[0]?.message ?? "Invalid entry" });
          continue;
        }
        const e = parsed.data;
        const r = await tx.query<{ id: string; duplicated: boolean }>(
          `SELECT id, duplicated FROM public.curriculum_catalogue_import_entry(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date, $16
           )`,
          [
            batchId,
            provenanceId,
            e.entry_kind,
            e.code,
            e.title,
            e.body ?? null,
            e.education_level ?? null,
            e.grade_band ?? null,
            e.pathway ?? null,
            e.parent_code ?? null,
            body.source_organisation,
            body.source_title,
            body.source_uri ?? null,
            body.publication_or_version ?? null,
            body.retrieved_at,
            e.known_limitations ?? null,
          ],
        );
        if (r.rows[0]?.duplicated) {
          duplicateCount++;
        } else if (r.rows[0]?.id) {
          importedCount++;
          importedIds.push(r.rows[0].id);
        }
      }

      const finalBatch = await tx.query(
        `UPDATE curriculum_import_batches
            SET status = 'completed',
                imported_count = $3,
                duplicate_count = $4,
                error_count = $5,
                error_report = $6::jsonb
          WHERE tenant_id = $1 AND id = $2
          RETURNING id, source_organisation, source_title, source_uri, publication_or_version,
                    retrieved_at::text, source_checksum, status, total_rows, imported_count,
                    duplicate_count, error_count, error_report, created_at`,
        [params.tenantId, batchId, importedCount, duplicateCount, errors.length, JSON.stringify(errors)],
      );

      await recordSecurityEvent(tx, {
        eventType: "curriculum.catalogue.batch_imported",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { batchId, importedCount, duplicateCount, errorCount: errors.length },
      });

      return { batch: finalBatch.rows[0], imported_entry_ids: importedIds };
    });

    return reply.status(201).send(out);
  });

  app.get(`${P}/import-batches`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const res = await pageQuery(
        tx,
        `SELECT id, source_organisation, source_title, source_uri, publication_or_version,
                retrieved_at::text, source_checksum, status, total_rows, imported_count,
                duplicate_count, error_count, error_report, created_at
           FROM curriculum_import_batches WHERE tenant_id = $1`,
        [params.tenantId],
        { name: "created_at", expr: "q.created_at", type: "timestamptz", dir: "desc" },
        { limit: page.limit, rawCursor: page.rawCursor },
      );
      return { batches: res.rows, page: res.page };
    });
  });

  app.post(`${P}/entries/:entryId/review`, async (request) => {
    const params = request.params as { tenantId: string; entryId: string };
    assertUuid(params.entryId, "entryId");
    const body = parseOrThrow(ReviewEntryBody, request.body, "action is required");
    const targetStatus = body.action === "submit_for_review" ? "under_review" : body.action === "verify" ? "verified" : "rejected";

    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.curriculum.verify", { ip, deferAudit: true });
      try {
        await tx.query(`SELECT public.curriculum_catalogue_transition($1, $2, $3)`, [
          params.entryId,
          targetStatus,
          body.review_note ?? null,
        ]);
      } catch (err) {
        mapDbErr(err);
      }
      const entry = await tx.query(
        `SELECT id, tenant_id, entry_kind, code, title, verification_status, reviewed_by, reviewed_at,
                review_note, version_number, superseded_by_id, superseded_at, source_organisation, source_title
           FROM curriculum_reference_entries WHERE id = $1`,
        [params.entryId],
      );
      await recordSecurityEvent(tx, {
        eventType: `curriculum.catalogue.entry_${targetStatus}`,
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { entryId: params.entryId, status: targetStatus },
      });
      return { entry: entry.rows[0] };
    });
  });

  app.post(`${P}/entries/:entryId/supersede`, async (request, reply) => {
    const params = request.params as { tenantId: string; entryId: string };
    assertUuid(params.entryId, "entryId");
    const body = parseOrThrow(SupersedeEntryBody, request.body, "title is required");

    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.curriculum.verify", { ip, deferAudit: true });
      let newId: string;
      try {
        const res = await tx.query<{ id: string }>(
          `SELECT public.curriculum_catalogue_supersede($1, $2, $3, $4, $5) AS id`,
          [params.entryId, body.title, body.body ?? null, body.publication_or_version ?? null, body.review_note ?? null],
        );
        newId = res.rows[0]!.id;
      } catch (err) {
        mapDbErr(err);
      }
      const entry = await tx.query(
        `SELECT id, tenant_id, entry_kind, code, title, verification_status, version_number,
                source_organisation, source_title, publication_or_version, review_note, created_at
           FROM curriculum_reference_entries WHERE id = $1`,
        [newId],
      );
      await recordSecurityEvent(tx, {
        eventType: "curriculum.catalogue.entry_superseded",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        ip,
        detail: { previousEntryId: params.entryId, newEntryId: newId },
      });
      return { entry: entry.rows[0], superseded_entry_id: params.entryId };
    });

    return reply.status(201).send(out);
  });

  app.get(`${P}/entries/:entryId/history`, async (request) => {
    const params = request.params as { tenantId: string; entryId: string };
    assertUuid(params.entryId, "entryId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, "resource.academics.read", { ip, deferAudit: true });
      const res = await tx.query(
        `WITH RECURSIVE chain AS (
           SELECT id, entry_kind, code, title, verification_status, version_number,
                  reviewed_by, reviewed_at, review_note, superseded_by_id, superseded_at, created_at
             FROM curriculum_reference_entries
            WHERE id = $1
           UNION ALL
           SELECT e.id, e.entry_kind, e.code, e.title, e.verification_status, e.version_number,
                  e.reviewed_by, e.reviewed_at, e.review_note, e.superseded_by_id, e.superseded_at, e.created_at
             FROM curriculum_reference_entries e
             JOIN chain c ON e.id = c.superseded_by_id
         )
         SELECT * FROM chain ORDER BY version_number ASC`,
        [params.entryId],
      );
      if (res.rows.length === 0) throw notFound("Catalogue entry not found");
      return { versions: res.rows };
    });
  });
}
