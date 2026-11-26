import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import {
  alreadyConnected,
  assertHandoffRateLimit,
  gateHandoff,
  HandoffGateway,
  handoffOff,
  handoffPerson,
  HR_TARGET,
  readHandoffState,
  recordHrAnswer,
  recordHrRequest,
  schoolNotLinked,
} from "../../modules/hr/handoff.js";
import { describeError, logWarn } from "../../log.js";
import { inTenant } from "../routeKit.js";

/**
 * "HR & Payroll" (docs/HR-HANDOFF.md, slice H1): the API's port of the Supabase function `open-hr`, under the prefix My HR
 * uses. The school and the person come from the verified session (the path's school must be the session's school); nothing in
 * a body or header can name another. Who: `resource.hr.handoff` (the school's administrators and anyone holding the Fees
 * area), never a platform super administrator.
 *
 * As My HR: (1) the rule, the switch and the rate limit in a short transaction committed before any network call; (2) the
 * platform, with no database connection held; (3) a second short transaction that re-checks the rule and records the answer
 * and the audit row. The one-time link is returned only after its audit row is committed, and is never logged or audited.
 */
const P = "/v1/tenants/:tenantId/me/hr";

export async function registerHrHandoffRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const handoff = new HandoffGateway(app.appConfig);
  const tenantOf = (request: FastifyRequest) => (request.params as { tenantId: string }).tenantId;

  // open-hr {action: "status"}: whether HR is there for the school. Asked by the menu and the HR & Payroll page.
  app.get(`${P}/handoff-status`, async (request) => {
    const step = await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const school = await gateHandoff(tx, { auth, ip });
      if (!handoff.on) return null;
      const state = await readHandoffState(tx, school);
      const asks = Boolean(state.link?.platformTenantId) && handoff.cachedConnection(school) === null;
      if (asks) await assertHandoffRateLimit(tx, { tenantId: school, platform: true });
      return { school, state };
    });
    if (!step) return { enabled: false, connection: null, requested_at: null, can_request_hr: false };
    const connection = await handoff.connection(step.school, step.state);
    return { enabled: true, connection, requested_at: step.state.requestedAt, can_request_hr: true };
  });

  // open-hr {action: "request"}: the school asks Figbloom for HR. The first request is kept; 409 while HR is there.
  app.post(`${P}/handoff-request`, async (request) => {
    const step = await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const school = await gateHandoff(tx, { auth, ip });
      if (!handoff.on) throw handoffOff("request");
      const state = await readHandoffState(tx, school);
      const asks = Boolean(state.link?.platformTenantId) && handoff.cachedConnection(school) === null;
      await assertHandoffRateLimit(tx, { userId: auth.user.id, tenantId: school, platform: asks });
      return { school, state };
    });
    const connection = await handoff.connection(step.school, step.state);
    if (connection === "connected" || connection === "setting_up") throw alreadyConnected();
    const result = await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const school = await gateHandoff(tx, { auth, ip });
      const recorded = await recordHrRequest(tx);
      if (recorded.recorded) {
        await recordSecurityEvent(tx, { eventType: "hr.handoff.requested", actorUserId: auth.user.id, tenantId: school, detail: { target: HR_TARGET }, ip });
      }
      return recorded;
    });
    if (result.recorded) handoff.forget(step.school);
    return { requested_at: result.requestedAt };
  });

  // open-hr {action: "open"}: a one-time sign-in link into HR for the caller ({url, expires_at}, https only).
  app.post(`${P}/handoff`, async (request) => {
    const who = await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const school = await gateHandoff(tx, { auth, ip });
      if (!handoff.on) throw handoffOff("open");
      const state = await readHandoffState(tx, school);
      if (!state.link) throw schoolNotLinked();
      await assertHandoffRateLimit(tx, { userId: auth.user.id, tenantId: school, platform: true });
      return { school, person: handoffPerson(auth) };
    });
    const opened = await handoff.open(who, request.abortSignal);
    if (!opened.ok) {
      const no = opened.recordNo;
      if (no) {
        // the platform's "no" is remembered (My HR hides itself for an hour on two of them); failing to record it changes nothing
        try {
          await inTenant(app, pool, request, tenantOf(request), async ({ tx }) => recordHrAnswer(tx, who.school, false, no));
        } catch (err) {
          logWarn("hr_handoff_record_failed", { tenant_id: who.school, ...describeError(err) });
        }
      }
      throw opened.error;
    }
    await inTenant(app, pool, request, tenantOf(request), async ({ tx, auth, ip }) => {
      const school = await gateHandoff(tx, { auth, ip });
      await recordHrAnswer(tx, school, true, null);
      await recordSecurityEvent(tx, { eventType: "hr.handoff.opened", actorUserId: auth.user.id, tenantId: school, detail: { target: HR_TARGET }, ip });
    });
    return { url: opened.url, expires_at: opened.expiresAt };
  });
}
