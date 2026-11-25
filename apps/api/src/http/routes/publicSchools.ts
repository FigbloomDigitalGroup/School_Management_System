import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { consumeAuthToken } from "../../modules/auth/rateLimit.js";
import { rateLimitBucketForIp } from "../../modules/auth/rateLimitBuckets.js";
import { findSchoolBySlug, SCHOOL_SLUG_RE } from "../../modules/tenancy/publicSchoolLookup.js";
import { clientIp } from "../clientIp.js";
import { notFound } from "../errors.js";
import { parseOrThrow } from "../validation.js";
import { junkBucketAddress } from "./mpesa.js";

const SlugParams = z.strictObject({ slug: z.string().regex(SCHOOL_SLUG_RE) });

/**
 * Public school lookup by its exact address (docs/PUBLIC-SCHOOL-LOOKUP.md). No session, no tenant header: a learner, parent
 * or driver who was handed a login id needs the school's id before they can sign in.
 *
 *   1. The address must look like one (lower-case letters, digits, hyphens, 3 to 40): otherwise 400, before the database.
 *   2. One token from the caller's own bucket (`school_lookup:ip:<address>`; an IPv6 caller is accounted per /64, as for the
 *      M-Pesa junk bucket), with the login limiter's numbers (AUTH_RATE_*): a hit and a miss cost the same.
 *   3. One indexed read. A school nobody has and a school that is not open for sign-in are the same 404 (the standard
 *      not-found body, byte for byte the answer of an unknown route) and the same security event, so neither the answer nor
 *      the work says which. Only `tenant_id` and `name` are ever returned.
 * Each miss is written to the operator-only security log (`auth.school_lookup.missed`, the slug and the address; never shown
 * to a school), bounded by the same bucket, so a scan is slow and leaves a trail.
 */
export async function registerPublicSchoolRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/public/schools/:slug", async (request) => {
    const { slug } = parseOrThrow(SlugParams, request.params, "Invalid school address");
    const ip = clientIp(request);
    const config = app.appConfig;
    return withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, config, rateLimitBucketForIp("school_lookup:ip", junkBucketAddress(ip)));
        const school = await findSchoolBySlug(db, slug);
        if (!school) {
          // Autocommit (no transaction here), so the event stays although the request ends in a 404.
          await recordSecurityEvent(db, { eventType: "auth.school_lookup.missed", detail: { slug }, ip });
          throw notFound();
        }
        return { tenant_id: school.tenant_id, name: school.name };
      },
      { acquireTimeoutMs: config.poolAcquireTimeoutMs },
    );
  });
}
