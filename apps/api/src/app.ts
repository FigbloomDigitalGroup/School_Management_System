import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import type { AppPool } from "./db/pool.js";
import { toClientError, AppError } from "./http/errors.js";
import { registerHealthRoutes } from "./http/routes/health.js";
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

  const routeTable: RouteEntry[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      routeTable.push({ method, url: route.url });
    }
  });

  app.setErrorHandler((err, _request, reply) => {
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

  await registerHealthRoutes(app, pool);
  await registerAuthRoutes(app, pool, config);
  await registerTenancyRoutes(app, pool);
  await registerOrgRoutes(app, pool);
  await registerRbacRoutes(app, pool);
  await registerResourceRoutes(app, pool);
  await registerLearnerRoutes(app, pool);
  await registerGuardianRoutes(app, pool);

  return app;
}
