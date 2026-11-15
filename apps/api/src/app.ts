import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import type { AppPool } from "./db/pool.js";
import { toClientError, AppError } from "./http/errors.js";
import { registerHealthRoutes, type Lifecycle } from "./http/routes/health.js";
import { RequestAbortedError } from "./db/cancel.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerTenancyRoutes } from "./http/routes/tenancy.js";
import { registerRbacRoutes } from "./http/routes/rbac.js";
import { registerOrgRoutes } from "./http/routes/org.js";
import { registerResourceRoutes } from "./http/routes/resources.js";
import { registerLearnerRoutes } from "./http/routes/learners.js";
import { registerGuardianRoutes } from "./http/routes/guardians.js";

export interface RouteEntry {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every registered route, for the OpenAPI parity test. */
    routeTable: RouteEntry[];
    appConfig: AppConfig;
    /** Readiness state: flipped by the shutdown sequence (FIG-1617). */
    lifecycle: Lifecycle;
  }
  interface FastifyRequest {
    /** Aborts when the client goes away before the response is finished (F-C3). */
    abortSignal: AbortSignal;
  }
}

export async function buildApp(config: AppConfig, pool: AppPool) {
  const app = Fastify({
    logger: false,
    // R2-01: hop-count trust only when configured; never boolean `true`.
    // Fastify 5 typings accept a predicate (address, hop) rather than a bare number.
    trustProxy:
      config.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < config.trustProxyHops
        : false,
    bodyLimit: 64 * 1024,
  });

  app.decorate("appConfig", config);
  const lifecycle: Lifecycle = { draining: false };
  app.decorate("lifecycle", lifecycle);

  // F-C3: one AbortSignal per request. ServerResponse 'close' fires when the response
  // finished OR the socket died early; only the early case aborts.
  app.decorateRequest("abortSignal", undefined as unknown as AbortSignal);
  app.addHook("onRequest", async (request, reply) => {
    const controller = new AbortController();
    request.abortSignal = controller.signal;
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
  });

  const routeTable: RouteEntry[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      routeTable.push({ method, url: route.url });
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    // The client is gone; nothing to deliver and nothing to alarm on.
    if (err instanceof RequestAbortedError) return reply.status(499).send();
    const mapped = toClientError(err);
    if (!(err instanceof AppError) && mapped.statusCode >= 500) {
      const sqlstate = (err as { code?: unknown } | null)?.code;
      console.error(
        "[api]",
        typeof sqlstate === "string" ? `database error ${sqlstate}` : err instanceof Error ? err.message : err,
      );
    }
    if (mapped.retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(mapped.retryAfterSeconds));
    }
    return reply.status(mapped.statusCode).send(mapped.body);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Not found" } }),
  );

  await registerHealthRoutes(app, pool, lifecycle);
  await registerAuthRoutes(app, pool, config);
  await registerTenancyRoutes(app, pool);
  await registerOrgRoutes(app, pool);
  await registerRbacRoutes(app, pool);
  await registerResourceRoutes(app, pool);
  await registerLearnerRoutes(app, pool);
  await registerGuardianRoutes(app, pool);

  return app;
}
