import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../../db/pool.js";
import {
  gateMyHrRead,
  MyHrGateway,
  planAttendance,
  planMyHr,
  planPayslip,
  resolveMyHrStatus,
  type MyHrPlan,
} from "../../modules/hr/myHr.js";
import { forbidden } from "../errors.js";
import { inTenant } from "../routeKit.js";

/**
 * "My HR" (docs/MY-HR.md): the caller's OWN payslips, leave, attendance and KPIs from Figbloom HR. Read only.
 * The school and the person come from the verified session (the path's tenant must equal it); a request cannot name another
 * school or person, and anything but the fields below is ignored. Only a school's staff (teacher, driver, staff, school_admin)
 * are served, and only while the feature is on (MY_HR_ENABLED and the platform settings) and the school is linked.
 *
 * Three steps, as for Bloom AI: (1) the rule and the rate limit, in a short transaction that is committed before any network
 * call; (2) HR, with no database connection held; (3) HR's JSON is returned as it came.
 */
const P = "/v1/tenants/:tenantId/me/hr";

export async function registerMyHrRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const hr = new MyHrGateway(app.appConfig);

  const read = async (request: FastifyRequest, plan: MyHrPlan) => {
    const { tenantId } = request.params as { tenantId: string };
    const who = await inTenant(app, pool, request, tenantId, ({ tx, auth }) => gateMyHrRead(tx, { on: hr.on, auth }));
    return hr.read(plan, who, request.abortSignal);
  };

  // The rule on its own: what the page asks before it shows itself. Any member may ask; a non-staff member is told so (200).
  app.get(`${P}/status`, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return inTenant(app, pool, request, tenantId, async ({ tx, auth }) => {
      if (!auth.authz.tenantId) throw forbidden("Tenant context required");
      const status = await resolveMyHrStatus(tx, { on: hr.on, tenantId: auth.authz.tenantId, membership: auth.authz.membership });
      return { status };
    });
  });

  app.get(`${P}/summary`, async (request) => read(request, planMyHr("summary")));
  app.get(`${P}/payslips`, async (request) => read(request, planMyHr("payslips")));
  app.get(`${P}/payslips/:payslipId`, async (request) => read(request, planPayslip((request.params as { payslipId: string }).payslipId)));
  app.get(`${P}/leave`, async (request) => read(request, planMyHr("leave")));
  app.get(`${P}/attendance`, async (request) => read(request, planAttendance(request.query)));
  app.get(`${P}/kpis`, async (request) => read(request, planMyHr("kpis")));
}
