import { validateMaterial, type MaterialInput, type MaterialRow } from "../materials";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { listClassesOrEmpty } from "./feesApi";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { listApiSubjects } from "./setupApi";

/**
 * Learning materials on apps/api: the API side of `materials.ts`.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET /learning-materials` and `POST /learning-materials` store metadata only (`storage_status: "metadata_only"`):
 *    `title`, `description`, `class_id`, `subject_id`, optional HTTPS `url`, and lifecycle timestamps. There are no uploaded files.
 *  - New materials are drafts; this adapter returns only active rows and uses `published_at` for the published date.
 */

type ApiMaterial = components["schemas"]["LearningMaterial"];

function whenForbidden<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  };
}

function mapMaterial(
  m: ApiMaterial,
  classById: ReadonlyMap<string, string>,
  subjectById: ReadonlyMap<string, string>,
): MaterialRow {
  return {
    id: m.id,
    kind: m.url ? "link" : "document",
    title: m.title,
    filePath: null,
    fileName: null,
    mimeType: null,
    sizeBytes: null,
    url: m.url ?? null,
    classId: m.class_id ?? "",
    className: (m.class_id && classById.get(m.class_id)) || "All classes",
    subjectId: m.subject_id ?? "",
    subjectName: (m.subject_id && subjectById.get(m.subject_id)) || "—",
    description: m.description ?? "",
    publishedAt: m.published_at,
    createdAt: m.created_at,
  };
}

/** Lists all learning materials for the school, resolving class and subject names. */
export async function apiFetchMaterials(tenantId: string): Promise<MaterialRow[]> {
  const [materials, classes, subjects] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learning-materials", {
        path: { tenantId },
        query: { limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.materials, page: r.page };
    }),
    listClassesOrEmpty(tenantId),
    listApiSubjects(tenantId).catch(whenForbidden([])),
  ]);

  const classById = new Map(classes.map((c) => [c.id, c.name]));
  const subjectById = new Map(subjects.map((s) => [s.id, s.name]));
  return materials.map((m) => mapMaterial(m, classById, subjectById));
}

/** Registers metadata for a learning material on apps/api and returns its id. */
export async function apiCreateLearningMaterial(tenantId: string, input: MaterialInput): Promise<string> {
  const checked = validateMaterial(input);
  if (!checked.ok) throw new Error(checked.message);

  const res = await apiClient().post("/v1/tenants/{tenantId}/learning-materials", {
    path: { tenantId },
    body: {
      title: checked.value.title,
      description: checked.value.description || null,
      class_id: checked.value.classId || null,
      subject_id: checked.value.subjectId || null,
    },
    tenantId,
  });
  return res.material.id;
}
