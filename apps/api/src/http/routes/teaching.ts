import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import {
  listTeachingColleagues,
  listTeachingHomework,
  listTeachingLearners,
  listTeachingMaterials,
  listTeachingPapers,
} from "../../modules/academics/teaching.js";
import { inTenant, myTeachingClassIds, optionalUuid, pageFrom } from "../routeKit.js";

/**
 * Teacher reads (docs/TEACHER-READS.md): what a teacher with no admin area may read about the classes they teach. Every
 * route needs `resource.teaching.read` (an audited 403 for a parent, a student or a driver) and returns only rows of the
 * classes the caller teaches now (an empty list when they teach nothing or have no linked staff record).
 */
const P = "/v1/tenants/:tenantId/me/teaching";

export async function registerTeachingRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get(`${P}/learners`, async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as Record<string, unknown>).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const classIds = await myTeachingClassIds(tx, auth, ip);
      const out = await listTeachingLearners(tx, { tenantId: params.tenantId, classIds, classId, page });
      return { learners: out.items, page: out.page };
    });
  });

  app.get(`${P}/colleagues`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const classIds = await myTeachingClassIds(tx, auth, ip);
      const out = await listTeachingColleagues(tx, { tenantId: params.tenantId, classIds, page });
      return { colleagues: out.items, page: out.page };
    });
  });

  // The teacher's view of the content of their classes (docs/TEACHER-READS.md, "Content of the classes I teach"). The same
  // rows and shapes as `GET /homework-items`, `/learning-materials` and `/online-exam-papers`, which need the Academics area.
  app.get(`${P}/homework-items`, async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as Record<string, unknown>).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const classIds = await myTeachingClassIds(tx, auth, ip);
      const out = await listTeachingHomework(tx, { tenantId: params.tenantId, classIds, classId, page });
      return { homework: out.items, page: out.page };
    });
  });

  app.get(`${P}/learning-materials`, async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as Record<string, unknown>).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const classIds = await myTeachingClassIds(tx, auth, ip);
      const out = await listTeachingMaterials(tx, { tenantId: params.tenantId, classIds, classId, page });
      return { materials: out.items, page: out.page };
    });
  });

  app.get(`${P}/online-exam-papers`, async (request) => {
    const params = request.params as { tenantId: string };
    const classId = optionalUuid((request.query as Record<string, unknown>).classId, "classId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const classIds = await myTeachingClassIds(tx, auth, ip);
      const out = await listTeachingPapers(tx, { tenantId: params.tenantId, classIds, classId, page });
      return { papers: out.items, page: out.page };
    });
  });
}
