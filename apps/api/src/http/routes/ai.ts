import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { attachDenialAudit } from "../../db/errors.js";
import type { Tx } from "../../db/sql.js";
import { forbidden } from "../errors.js";
import {
  assertSharedBloomRateLimit,
  bloomCircuitState,
  getBloomAiProvider,
  resolveAllowedScopes,
  type KnowledgeScope,
} from "../../modules/ai/bloomProvider.js";
import { ALLOWED_TOOLS, CONTRACT_NAME, CONTRACT_VERSION } from "../../modules/ai/contract.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { inTenant } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const QueryBody = z.strictObject({
  scope: z.enum(["public", "school", "internal_figbloom"]),
  prompt: z.string().min(1).max(4000),
  conversation_id: z.guid().optional(),
});

export const AI_REQUEST_SCHEMAS = {
  "POST /v1/tenants/{tenantId}/ai/query": QueryBody,
} as const;

/** Server-side facts only: the client's `scope` is a request, never an entitlement. */
async function callerScopes(
  tx: Tx,
  tenantId: string,
  isSuperAdmin: boolean,
  role: string,
): Promise<{ enabled: boolean; scopes: KnowledgeScope[] }> {
  const settings = await tx.query(`SELECT 1 FROM finance_ai_helper_settings WHERE tenant_id = $1`, [tenantId]);
  const schoolAiEnabled = (settings.rowCount ?? 0) > 0;
  const enabled = schoolAiEnabled || isSuperAdmin;
  return { enabled, scopes: resolveAllowedScopes({ isSuperAdmin, schoolAiEnabled, role }) };
}

export async function registerAiRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/tenants/:tenantId/ai/status", async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      const { enabled, scopes } = await callerScopes(tx, params.tenantId, auth.authz.isSuperAdmin, auth.authz.role);
      const provider = getBloomAiProvider(app.appConfig);
      return {
        contract: `${CONTRACT_NAME}/${CONTRACT_VERSION}`,
        enabled_for_school: enabled,
        provider_configured: provider.configured,
        circuit: bloomCircuitState(app.appConfig.bloomAiBaseUrl),
        allowed_scopes: scopes,
        tools: [...ALLOWED_TOOLS],
      };
    });
  });

  app.post("/v1/tenants/:tenantId/ai/query", async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(QueryBody, request.body, "scope and prompt are required");
    // 1) Authorise and consume the shared rate-limit tokens in a SHORT transaction that commits before any network call:
    //    holding the bucket row locks across the provider HTTP call would serialise every Bloom query platform-wide.
    const gate = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const { enabled, scopes } = await callerScopes(tx, params.tenantId, auth.authz.isSuperAdmin, auth.authz.role);
      if (!enabled || !scopes.includes(body.scope)) {
        const err = forbidden(enabled ? "The requested knowledge scope is not available to this account" : "Bloom AI is not enabled for this school");
        attachDenialAudit(err, {
          eventType: "ai.bloom.denied",
          actorUserId: auth.user.id,
          tenantId: params.tenantId,
          detail: { requested_scope: body.scope, school_enabled: enabled, role: auth.authz.role },
          ip,
        });
        throw err;
      }
      await assertSharedBloomRateLimit(tx, { userId: auth.user.id, tenantId: params.tenantId });
      return { scopes, actorUserId: auth.user.id, role: auth.authz.role, isSuperAdmin: auth.authz.isSuperAdmin };
    });
    // 2) Provider call: no database transaction or connection is held.
    const out = await getBloomAiProvider(app.appConfig).generate({
      tenantId: params.tenantId,
      actorUserId: gate.actorUserId,
      actorRole: gate.role,
      isSuperAdmin: gate.isSuperAdmin,
      requestedScope: body.scope,
      allowedScopes: gate.scopes,
      prompt: body.prompt,
      conversationId: body.conversation_id,
    });
    // 3) Audit (the prompt and the answer are never written to the audit trail).
    const result = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await recordSecurityEvent(tx, {
        eventType: "ai.bloom.queried",
        actorUserId: auth.user.id,
        tenantId: params.tenantId,
        detail: {
          scope: body.scope,
          status: out.status,
          ...("reason" in out ? { reason: out.reason } : {}),
          ...("request_id" in out && out.request_id ? { requestId: out.request_id } : {}),
        },
        ip,
      });
      return out;
    });
    if (result.status !== "ok") {
      if (result.status === "unavailable") reply.header("retry-after", String(result.retry_after_seconds));
      return reply.status(503).send(result);
    }
    return reply.status(200).send(result);
  });
}
