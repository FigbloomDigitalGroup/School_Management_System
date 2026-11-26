import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { getAccountNotifier } from "../../modules/account/notifier.js";
import {
  approveOrgSignup,
  listOrgSignups,
  ORG_SIGNUP_STATUSES,
  readOrgSignup,
  rejectOrgSignup,
  reissueOrgSetup,
  type OrgSignupRow,
  type OrgSignupStatus,
} from "../../modules/account/orgSignup.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { conflict, validationError } from "../errors.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { asPlatformActor, requirePlatformActor } from "../platformAccess.js";
import { assertUuid } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

/**
 * Organisation sign-up requests, the platform half (docs/ORG-SIGNUP.md; owner decisions D2: this console approves and rejects,
 * D8: the platform approves). `organization_signups` (migration 124) is owner-only and has no school: every read and write
 * goes through its SECURITY DEFINER functions, which re-check the super administrator and write the audit row in the same
 * transaction.
 *
 * Permission `platform.org_signups.manage` (super_admin only), checked with no school (`X-Tenant-Id` is ignored), BEFORE any
 * parameter or body is read. Approving, rejecting and re-issuing need a recent sign-in (`assertRecentAuth`). Reading the list
 * shows personal data (names, addresses, phones), so each read is audited (`platform.org_signup.listed`, the count only).
 *
 * Approve creates the organisation (active), the administrator's account (invited) and an org_admin membership, and issues a
 * password-setup link that is e-mailed to the CONFIRMED address (never returned, unless e-mail is not configured: then it is
 * returned once to the reviewer, as invitations are). An address that already has an account cannot be approved (409).
 */

const SORT = "created_at_desc";

const ApproveBody = z.strictObject({ slug: z.string().min(3).max(40).optional() });
const RejectBody = z.strictObject({ reason: z.string().max(500).optional() });

export const PLATFORM_ORG_SIGNUP_REQUEST_SCHEMAS = {
  "POST /v1/platform/org-signups/{signupId}/approve": ApproveBody,
  "POST /v1/platform/org-signups/{signupId}/reject": RejectBody,
} as const;

function toSignup(r: OrgSignupRow) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    county: r.county,
    contactPhone: r.contact_phone,
    adminFullName: r.admin_full_name,
    adminEmail: r.admin_email,
    status: r.status,
    createdAt: r.created_at_text,
    verifiedAt: r.verified_at_text,
    decidedAt: r.decided_at_text,
    decidedByName: r.decided_by_name,
    decisionReason: r.decision_reason,
    organizationId: r.organization_id,
    organizationSlug: r.organization_slug,
  };
}

function parseStatus(query: Record<string, unknown>): OrgSignupStatus | null {
  const raw = query.status;
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !(ORG_SIGNUP_STATUSES as readonly string[]).includes(raw)) {
    throw validationError("status is not a sign-up status", [{ field: "status", code: "invalid_value", message: "Invalid value" }]);
  }
  return raw as OrgSignupStatus;
}

function setupOf(delivery: "sent" | "not_configured", token: string, expiresAt: Date) {
  return { expiresAt: expiresAt.toISOString(), delivery, ...(delivery === "not_configured" ? { token } : {}) };
}

export async function registerPlatformOrgSignupRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const PERMISSION = "platform.org_signups.manage";

  app.get("/v1/platform/org-signups", async (request) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const query = request.query as Record<string, unknown>;
    const status = parseStatus(query);
    const { limit, cursor, fingerprint } = parseListQuery(query, {
      sort: SORT,
      filter: { scope: "platform_org_signups", status },
      keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
    });
    const rows = await asPlatformActor(
      app,
      pool,
      actor,
      async (db) => {
        const found = await listOrgSignups(db, {
          status,
          beforeAt: cursor ? cursor.k[0]! : null,
          beforeId: cursor ? cursor.k[1]! : null,
          limit: limit + 1,
        });
        await recordSecurityEvent(db, {
          eventType: "platform.org_signup.listed",
          actorUserId: actor.userId,
          tenantId: null,
          detail: { count: Math.min(found.length, limit) },
          ip: actor.ip,
        });
        return found;
      },
      { sensitive: false },
    );
    const paged = pageFromKeysetRows(rows, { limit, sort: SORT, fingerprint, keysOf: (r) => [r.created_at_text, r.id] });
    return { items: paged.items.map(toSignup), page: paged.page };
  });

  app.post("/v1/platform/org-signups/:signupId/approve", async (request) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const { signupId } = request.params as { signupId: string };
    assertUuid(signupId, "signupId");
    const body = parseOrThrow(ApproveBody, request.body ?? {}, "slug must be 3 to 40 characters");
    const done = await asPlatformActor(
      app,
      pool,
      actor,
      async (db) => {
        const approved = await approveOrgSignup(db, { id: signupId, slug: body.slug ?? null });
        return { approved, signup: await readOrgSignup(db, signupId) };
      },
      { sensitive: true },
    );
    const delivery = await getAccountNotifier().send({ kind: "org_signup_approved", email: done.approved.adminEmail, token: done.approved.token });
    return {
      signup: toSignup(done.signup),
      organization: { id: done.approved.organizationId, slug: done.approved.organizationSlug },
      setup: setupOf(delivery, done.approved.token, done.approved.expiresAt),
    };
  });

  app.post("/v1/platform/org-signups/:signupId/reject", async (request) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const { signupId } = request.params as { signupId: string };
    assertUuid(signupId, "signupId");
    const body = parseOrThrow(RejectBody, request.body ?? {}, "reason must be at most 500 characters");
    const done = await asPlatformActor(
      app,
      pool,
      actor,
      async (db) => {
        const rejected = await rejectOrgSignup(db, { id: signupId, reason: body.reason ?? null });
        return { rejected, signup: await readOrgSignup(db, signupId) };
      },
      { sensitive: true },
    );
    // A rejection notice goes only to a mailbox whose owner confirmed it: an unconfirmed address may be somebody else's.
    let notified = false;
    if (done.rejected.wasVerified) {
      notified = (await getAccountNotifier().send({ kind: "org_signup_rejected", email: done.rejected.adminEmail, token: "" })) === "sent";
    }
    return { signup: toSignup(done.signup), notified };
  });

  app.post("/v1/platform/org-signups/:signupId/reissue-setup", async (request) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const { signupId } = request.params as { signupId: string };
    assertUuid(signupId, "signupId");
    const issued = await asPlatformActor(app, pool, actor, (db) => reissueOrgSetup(db, signupId), { sensitive: true });
    // The person has already chosen a password: nothing was issued.
    if (!issued) throw conflict("The administrator has already set a password");
    const delivery = await getAccountNotifier().send({ kind: "org_signup_approved", email: issued.adminEmail, token: issued.token });
    return { setup: setupOf(delivery, issued.token, issued.expiresAt) };
  });
}
