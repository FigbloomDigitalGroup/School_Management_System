import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import {
  listMessages,
  listMyConversations,
  listStaffChatContacts,
  markConversationRead,
  sendMessage,
  startConversation,
} from "../../modules/communications/chat.js";
import { assertUuid, inTenant, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const StartBody = z.strictObject({
  peer_user_id: z.guid(),
});

const MessageBody = z.strictObject({
  body: z.string().min(1).max(4000),
});

const P = "/v1/tenants/:tenantId/chat";

export async function registerChatRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.post(`${P}/conversations`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(StartBody, request.body, "peer_user_id is required");
    const conversation = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      startConversation(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        peerUserId: body.peer_user_id,
      }),
    );
    return reply.status(201).send({ conversation });
  });

  app.get(`${P}/conversations`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      listMyConversations(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        limit: page.limit,
        rawCursor: page.rawCursor,
      }),
    );
  });

  // Teacher reads (docs/TEACHER-READS.md): the staff a staff member may start a chat with, named. Empty for anyone else.
  app.get(`${P}/contacts`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      listStaffChatContacts(tx, {
        tenantId: params.tenantId,
        userId: auth.user.id,
        callerRole: auth.authz.membership?.role ?? null,
        page,
      }),
    );
  });

  app.get(`${P}/conversations/:conversationId/messages`, async (request) => {
    const params = request.params as { tenantId: string; conversationId: string };
    assertUuid(params.conversationId, "conversationId");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      listMessages(tx, {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        userId: auth.user.id,
        limit: page.limit,
        rawCursor: page.rawCursor,
      }),
    );
  });

  app.post(`${P}/conversations/:conversationId/messages`, async (request, reply) => {
    const params = request.params as { tenantId: string; conversationId: string };
    assertUuid(params.conversationId, "conversationId");
    const body = parseOrThrow(MessageBody, request.body, "body is required");
    const message = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) =>
      sendMessage(tx, {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        senderId: auth.user.id,
        body: body.body,
      }),
    );
    return reply.status(201).send({ message });
  });

  app.post(`${P}/conversations/:conversationId/read`, async (request, reply) => {
    const params = request.params as { tenantId: string; conversationId: string };
    assertUuid(params.conversationId, "conversationId");
    await inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      await markConversationRead(tx, {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        userId: auth.user.id,
      });
    });
    return reply.status(204).send();
  });
}
