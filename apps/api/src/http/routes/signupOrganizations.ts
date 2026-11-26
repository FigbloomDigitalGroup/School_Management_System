import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";
import { getAccountNotifier } from "../../modules/account/notifier.js";
import { ORG_KINDS, submitOrgSignup, verifyOrgSignup } from "../../modules/account/orgSignup.js";
import { consumeAuthToken } from "../../modules/auth/rateLimit.js";
import { rateLimitBucketForIp } from "../../modules/auth/rateLimitBuckets.js";
import { clientIp } from "../clientIp.js";
import { serviceUnavailable, validationError } from "../errors.js";
import { parseOrThrow } from "../validation.js";
import { junkBucketAddress } from "./mpesa.js";

/**
 * Organisation self-service sign-up, the public half (docs/ORG-SIGNUP.md, owner decisions D2 and D8).
 *
 * The one public route that leads to a privileged account, so it creates nothing: it stores a REQUEST and e-mails a link to the
 * address the person typed. Following the link proves the mailbox; a super administrator then approves or rejects the request
 * (`platformOrgSignups.ts`). Until then there is no organisation, no account and no school.
 *
 *  - No account or request is revealed: a new address, an address with a waiting request and an address that already has an
 *    account all get the same 202 (the route never reads `users`). The only different answers are ones every caller gets:
 *    400 (the body is wrong), 429 (the caller's own limits), 503 (e-mail is not set up, or the day's cap is reached).
 *  - Limits, in addition to the body size (4 KiB): 5 requests at once then 5 an hour for a person (an IPv6 caller counts per
 *    /64), 3 at once then 1 an hour for one address (the bucket holds a hash, never the address), and
 *    ORG_SIGNUP_DAILY_CAP new requests a day for everyone together (the Supabase function allowed 5 an hour and 50 a day).
 *  - The confirmation token is never returned to the caller. The route ships CLOSED (ORG_SIGNUP_ENABLED, off by default) and
 *    answers 503 while there is no e-mail provider, instead of storing requests nobody could confirm.
 *  - Nothing typed by the person is logged or put in an audit row; the audit row names the request's id and kind only.
 */

const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const SubmitBody = z.strictObject({
  name: z.string().min(2).max(160).refine(noControl),
  kind: z.enum(ORG_KINDS),
  county: z.string().max(80).refine(noControl).optional(),
  contact_phone: z.string().max(40).optional(),
  admin_full_name: z.string().min(1).max(160).refine(noControl),
  admin_email: z.string().min(3).max(254),
});
const VerifyBody = z.strictObject({ token: z.string().min(20).max(200) });

export const ORG_SIGNUP_REQUEST_SCHEMAS = {
  "POST /v1/signup/organizations": SubmitBody,
  "POST /v1/signup/organizations/verify": VerifyBody,
} as const;

/** A person: 5 at once, then 5 an hour. One address: 3 at once, then 1 an hour. */
const PER_PERSON = { authRateCapacity: 5, authRateRefill: 1, authRateIntervalMs: 12 * 60_000 } as const;
const PER_ADDRESS = { authRateCapacity: 3, authRateRefill: 1, authRateIntervalMs: 60 * 60_000 } as const;
const PHONE_SHAPE = /^[0-9+()\s-]{6,40}$/;

export async function registerSignupOrganizationRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.post("/v1/signup/organizations", { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const body = parseOrThrow(SubmitBody, request.body, "Check the details and try again");
    const email = body.admin_email.trim().toLowerCase();
    const county = body.county?.trim() || null;
    const phone = body.contact_phone?.trim() || null;
    if (!EMAIL_SHAPE.test(email) || email.length > 254) throw validationError("Enter a valid e-mail address", [{ field: "admin_email", code: "invalid_value", message: "Invalid value" }]);
    if (phone && !PHONE_SHAPE.test(phone)) throw validationError("Enter a valid phone number", [{ field: "contact_phone", code: "invalid_value", message: "Invalid value" }]);
    if (body.name.trim().length < 2 || body.admin_full_name.trim().length < 1) throw validationError("Check the details and try again");

    const notifier = getAccountNotifier();
    // Closed until the owner opens it (ORG_SIGNUP_ENABLED), and while there is nothing to send the link with (the only proof is an
    // e-mailed link; the Supabase function was closed the same way). The same 503 for everyone.
    if (!app.appConfig.orgSignupEnabled || !notifier.configured) throw serviceUnavailable("Sign-up is not available right now", 300);

    const ip = clientIp(request);
    const result = await withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, PER_PERSON, rateLimitBucketForIp("org_signup:ip", junkBucketAddress(ip)));
        await consumeAuthToken(db, PER_ADDRESS, `org_signup:email:${createHash("sha256").update(email, "utf8").digest("hex")}`);
        return submitOrgSignup(
          db,
          { name: body.name.trim(), kind: body.kind, county, contactPhone: phone, adminFullName: body.admin_full_name.trim(), adminEmail: email },
          app.appConfig.orgSignupDailyCap,
        );
      },
      opts(),
    );
    if (result.outcome === "capped") throw serviceUnavailable("Sign-up is busy right now. Try again tomorrow.", 3600);
    if (result.token) await notifier.send({ kind: "org_signup_verify", email, token: result.token });
    return reply.status(202).send({ status: "received" });
  });

  app.post("/v1/signup/organizations/verify", { bodyLimit: 1024 }, async (request) => {
    const body = parseOrThrow(VerifyBody, request.body, "The link is invalid or has expired");
    const ip = clientIp(request);
    return withIdentityAccess(
      pool,
      async (db) => {
        await consumeAuthToken(db, app.appConfig, rateLimitBucketForIp("org_signup_verify:ip", junkBucketAddress(ip)));
        if (!(await verifyOrgSignup(db, body.token))) throw validationError("The link is invalid or has expired");
        return { status: "confirmed" };
      },
      opts(),
    );
  });
}
