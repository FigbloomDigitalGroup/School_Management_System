import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import {
  deleteMyDeviceToken,
  getMyNotificationPreferences,
  listMyDeviceTokens,
  patchMyNotificationPreferences,
  registerDeviceToken,
} from "../../modules/communications/notificationPrefs.js";
import { clientIp } from "../clientIp.js";
import { notFound } from "../errors.js";
import { assertUuid } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const PrefsPatch = z.strictObject({
  fee_reminders: z.boolean().optional(),
  absence_today: z.boolean().optional(),
  results_published: z.boolean().optional(),
  general_notices: z.boolean().optional(),
  chat_messages: z.boolean().optional(),
});

const DeviceBody = z.strictObject({
  token: z.string().min(16).max(512),
  platform: z.enum(["android", "ios"]),
});

export async function registerMeNotificationRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/me/notification-preferences", async (request) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request));
    const preferences = await withIdentityUserScope(pool, auth.user.id, (db) =>
      getMyNotificationPreferences(db, auth.user.id),
    );
    return { preferences };
  });

  app.patch("/v1/me/notification-preferences", async (request) => {
    // Auth (incl. forced-password gate) before body validation — FIG-1604.
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request));
    const body = parseOrThrow(
      PrefsPatch.refine((v) => Object.keys(v).length > 0, { message: "at least one preference field is required" }),
      request.body,
      "at least one preference field is required",
    );
    const preferences = await withIdentityUserScope(pool, auth.user.id, (db) =>
      patchMyNotificationPreferences(db, auth.user.id, body, clientIp(request)),
    );
    return { preferences };
  });

  app.get("/v1/me/device-tokens", async (request) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request));
    const device_tokens = await withIdentityUserScope(pool, auth.user.id, (db) => listMyDeviceTokens(db, auth.user.id));
    return { device_tokens };
  });

  app.post("/v1/me/device-tokens", async (request, reply) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request));
    const body = parseOrThrow(DeviceBody, request.body, "token and platform are required");
    const device = await withIdentityUserScope(pool, auth.user.id, (db) =>
      registerDeviceToken(db, { userId: auth.user.id, token: body.token, platform: body.platform }),
    );
    return reply.status(201).send({ device_token: { id: device.id, platform: body.platform } });
  });

  app.delete("/v1/me/device-tokens/:tokenId", async (request, reply) => {
    const auth = await withIdentityAccess(pool, (db) => requireSessionAuth(db, request));
    const params = request.params as { tokenId: string };
    assertUuid(params.tokenId, "tokenId");
    const ok = await withIdentityUserScope(pool, auth.user.id, (db) => deleteMyDeviceToken(db, auth.user.id, params.tokenId));
    if (!ok) throw notFound("Device token not found");
    return reply.status(204).send();
  });
}
