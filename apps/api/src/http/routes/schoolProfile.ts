import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { attachDenialAudit } from "../../db/errors.js";
import { mayAdminister, requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import {
  ACCENT_PATTERN,
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_PHONE_PATTERN,
} from "../../modules/directory/contact.js";
import { getSchoolProfile, patchSchoolProfile } from "../../modules/directory/schoolProfile.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { clientIp } from "../clientIp.js";
import { forbidden, validationError } from "../errors.js";
import { withTenantRequest } from "../tenantRequest.js";
import { parseOrThrow } from "../validation.js";

const UuidParam = uuidString;

const PatchSchema = z
  .strictObject({
    name: z.string().min(1).max(200).optional(),
    timezone: z.string().min(1).max(64).optional(),
    county: z.string().min(1).max(120).nullable().optional(),
    country: z.string().min(1).max(120).nullable().optional(),
    level: z.string().min(1).max(64).nullable().optional(),
    institution_type: z.enum(["k12", "higher_ed"]).nullable().optional(),
    // P3-AUDIT-013: shape-checked, not length-checked. Same rules as every other directory
    // contact field; `accent` is restricted to a token that cannot extend a CSS declaration.
    contact_email: z
      .string()
      .max(CONTACT_EMAIL_MAX_LENGTH)
      .regex(new RegExp(CONTACT_EMAIL_PATTERN))
      .nullable()
      .optional(),
    contact_phone: z.string().regex(new RegExp(CONTACT_PHONE_PATTERN)).nullable().optional(),
    moe_registration: z.string().min(1).max(64).nullable().optional(),
    accent: z.string().regex(new RegExp(ACCENT_PATTERN)).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

export async function registerSchoolProfileRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/tenants/:tenantId/school-profile", async (request) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.school_profile.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return { schoolProfile: await getSchoolProfile(tx, { tenantId: params.tenantId }) };
    });
  });

  app.patch("/v1/tenants/:tenantId/school-profile", async (request) => {
    const params = request.params as { tenantId: string };
    if (!UuidParam.safeParse(params.tenantId).success) throw validationError("tenantId must be a UUID");
    if (request.body && typeof request.body === "object" && "permissions" in request.body) {
      throw forbidden("Client-supplied permissions are not accepted");
    }
    const parsed = parseOrThrow(PatchSchema, request.body, "At least one school profile field is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, params.tenantId);
      await requirePermission(tx, auth.authz, "resource.school_profile.write", {
        ip: clientIp(request),
        deferAudit: true,
      });
      // P3-AUDIT-002 (owner decision F-02): school name and timezone are full-administrator-only.
      // An org admin holding an explicit `school_profile.write` delegation may change the other
      // profile fields but not these two; the delegation never widens to school identity.
      if ((parsed.name !== undefined || parsed.timezone !== undefined) && !mayAdminister(auth.authz)) {
        const err = forbidden("Only a school administrator can change the school name or timezone");
        attachDenialAudit(err, {
          eventType: "rbac.permission.denied",
          actorUserId: auth.authz.userId,
          tenantId: auth.authz.tenantId,
          detail: { permission: "school.identity.write", role: auth.authz.role },
          ip: clientIp(request),
        });
        throw err;
      }
      // The school's identity and clock (name, timezone: the timezone defines every school-local date) need recent authentication.
      // Other profile fields (address, county, contacts, logo key) are ordinary content and are deliberately not gated.
      if (parsed.name !== undefined || parsed.timezone !== undefined) await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const schoolProfile = await patchSchoolProfile(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        ...parsed,
        ip: clientIp(request),
      });
      return { schoolProfile };
    });
  });
}
