import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { acceptableRequestId, describeError, logError, logInfo } from "./log.js";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import type { AppConfig } from "./config.js";
import type { AppPool } from "./db/pool.js";
import { toClientError } from "./http/errors.js";
import { registerHealthRoutes, type Lifecycle } from "./http/routes/health.js";
import { RequestAbortedError } from "./db/cancel.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerTenancyRoutes } from "./http/routes/tenancy.js";
import { registerRbacRoutes } from "./http/routes/rbac.js";
import { registerOrgRoutes } from "./http/routes/org.js";
import { registerResourceRoutes } from "./http/routes/resources.js";
import { registerLearnerRoutes } from "./http/routes/learners.js";
import { registerGuardianRoutes } from "./http/routes/guardians.js";
import { registerSchoolProfileRoutes } from "./http/routes/schoolProfile.js";
import { registerStaffRoutes } from "./http/routes/staff.js";
import { registerDocumentRoutes } from "./http/routes/documents.js";
import { registerStorageRoutes } from "./http/routes/storage.js";
import { registerAcademicsStructureRoutes } from "./http/routes/academicsStructure.js";
import { registerAcademicsAssessmentRoutes } from "./http/routes/academicsAssessments.js";
import { registerAcademicsCbeRoutes } from "./http/routes/academicsCbe.js";
import { registerCurriculumCatalogueRoutes } from "./http/routes/curriculumCatalogue.js";
import { registerAcademicsHigherRoutes } from "./http/routes/academicsHigher.js";
import { registerAttendanceRoutes } from "./http/routes/attendance.js";
import { registerFinanceRoutes } from "./http/routes/finance.js";
import { registerMpesaRoutes } from "./http/routes/mpesa.js";
import { registerCommunicationsRoutes } from "./http/routes/communications.js";
import { registerMeNotificationRoutes } from "./http/routes/meNotifications.js";
import { registerNotificationRoutes } from "./http/routes/notifications.js";
import { registerVisitRoutes } from "./http/routes/visits.js";
import { registerSchoolHealthRoutes } from "./http/routes/schoolHealth.js";
import { registerMedicationRoutes } from "./http/routes/medication.js";
import { registerChatRoutes } from "./http/routes/chat.js";
import { registerInventoryRoutes } from "./http/routes/inventory.js";
import { registerLeaveRoutes } from "./http/routes/leave.js";
import { registerActivitiesRoutes } from "./http/routes/activities.js";
import { registerTransportRoutes } from "./http/routes/transport.js";
import { registerTransportOperationsRoutes } from "./http/routes/transportOperations.js";
import { registerReportingRoutes } from "./http/routes/reporting.js";
import { registerTeacherReportRoutes } from "./http/routes/teacherReports.js";
import { registerImportRoutes } from "./http/routes/imports.js";
import { registerOpsStatusRoutes } from "./http/routes/opsStatus.js";
import { registerUnmatchedCallbackRoutes } from "./http/routes/unmatchedCallbacks.js";
import { registerAccountRoutes } from "./http/routes/accounts.js";
import { registerGuardianInvitationRoutes } from "./http/routes/guardianInvitations.js";
import { registerAiRoutes } from "./http/routes/ai.js";
import { mpesaProviderFromConfig, type MpesaProvider } from "./modules/finance/mpesaProvider.js";

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
    /** Stage 11 M-Pesa provider (Daraja when configured; a fake in tests). */
    mpesaProvider: MpesaProvider;
  }
  interface FastifyRequest {
    /** Aborts when the client goes away before the response is finished (F-C3). */
    abortSignal: AbortSignal;
  }
}

export interface AppDependencies {
  /** Overrides the provider built from config (tests use a deterministic fake). */
  mpesaProvider?: MpesaProvider;
}

export async function buildApp(config: AppConfig, pool: AppPool, deps: AppDependencies = {}) {
  const app = Fastify({
    logger: false,
    // R2-01: hop-count trust only when configured; never boolean `true`.
    // Fastify 5 typings accept a predicate (address, hop) rather than a bare number.
    trustProxy:
      config.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < config.trustProxyHops
        : false,
    bodyLimit: 64 * 1024,
    // Correlation id: an inbound X-Request-Id is honoured only if it is a short safe token.
    requestIdHeader: false,
    genReqId: (req) => acceptableRequestId(req.headers["x-request-id"]) ?? randomUUID(),
    // Connection hygiene (FIG-1622). keep-alive must outlive the load balancer's idle timeout,
    // otherwise the balancer reuses a connection the server has just closed and returns 502.
    keepAliveTimeout: config.serverKeepAliveTimeoutMs,
    requestTimeout: config.serverRequestTimeoutMs,
  });
  app.server.headersTimeout = config.serverHeadersTimeoutMs;

  // Security headers for a JSON API: nothing is renderable, framed, or cacheable.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    // HSTS only where this host terminates TLS (an HTTP-only listener must not send it).
    strictTransportSecurity: config.hstsEnabled
      ? { maxAge: 15_552_000, includeSubDomains: true }
      : false,
  });
  // Explicit allowlist only. No configured origin = no CORS headers. Never "*", never credentials
  // (bearer tokens, not cookies).
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      cb(null, config.corsAllowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id", "X-Tenant-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After", "Idempotent-Replayed"],
    credentials: false,
    maxAge: config.corsMaxAgeSeconds,
  });
  // Authenticated and error responses must never be stored by a shared cache.
  app.addHook("onSend", async (request, reply) => {
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
    reply.header("X-Request-Id", request.id);
  });

  // One access-log line per request: allowlisted identifiers and facts only (see src/log.ts).
  app.addHook("onResponse", async (request, reply) => {
    logInfo("request", {
      request_id: request.id,
      method: request.method,
      route: request.routeOptions?.url ?? "unmatched",
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
      tenant_id: request.auth?.authz.tenantId ?? null,
      user_id: request.auth?.user.id ?? null,
    });
  });

  app.decorate("appConfig", config);
  app.decorate("mpesaProvider", deps.mpesaProvider ?? mpesaProviderFromConfig(config));
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

  app.setErrorHandler((err, request, reply) => {
    // The client is gone; nothing to deliver and nothing to alarm on.
    if (err instanceof RequestAbortedError) {
      logInfo("request_aborted", { request_id: request.id, outcome: "client_disconnect" });
      return reply.status(499).send();
    }
    const mapped = toClientError(err);
    if (mapped.statusCode >= 500) {
      // Class and SQLSTATE only: never the exception or driver message.
      logError("request_failed", {
        request_id: request.id,
        status: mapped.statusCode,
        error_code: mapped.body.error.code,
        ...describeError(err),
      });
    }
    if (mapped.retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(mapped.retryAfterSeconds));
    }
    return reply
      .status(mapped.statusCode)
      .send({ error: { ...mapped.body.error, request_id: request.id } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Not found", request_id: request.id } }),
  );

  await registerHealthRoutes(app, pool, lifecycle);
  await registerAuthRoutes(app, pool, config);
  await registerTenancyRoutes(app, pool);
  await registerOrgRoutes(app, pool);
  await registerRbacRoutes(app, pool);
  await registerResourceRoutes(app, pool);
  await registerLearnerRoutes(app, pool);
  await registerGuardianRoutes(app, pool);
  await registerSchoolProfileRoutes(app, pool);
  await registerStaffRoutes(app, pool);
  await registerDocumentRoutes(app, pool);
  await registerStorageRoutes(app, pool);
  await registerAcademicsStructureRoutes(app, pool);
  await registerAcademicsAssessmentRoutes(app, pool);
  await registerAcademicsCbeRoutes(app, pool);
  await registerCurriculumCatalogueRoutes(app, pool);
  await registerAcademicsHigherRoutes(app, pool);
  await registerAttendanceRoutes(app, pool);
  await registerFinanceRoutes(app, pool);
  await registerMpesaRoutes(app, pool);
  await registerCommunicationsRoutes(app, pool);
  await registerMeNotificationRoutes(app, pool);
  await registerNotificationRoutes(app, pool);
  await registerVisitRoutes(app, pool);
  await registerSchoolHealthRoutes(app, pool);
  await registerMedicationRoutes(app, pool);
  await registerChatRoutes(app, pool);
  await registerInventoryRoutes(app, pool);
  await registerLeaveRoutes(app, pool);
  await registerActivitiesRoutes(app, pool);
  await registerTransportRoutes(app, pool);
  await registerTransportOperationsRoutes(app, pool);
  await registerReportingRoutes(app, pool);
  await registerTeacherReportRoutes(app, pool);
  await registerImportRoutes(app, pool);
  await registerOpsStatusRoutes(app, pool);
  await registerUnmatchedCallbackRoutes(app, pool);
  await registerAccountRoutes(app, pool);
  await registerGuardianInvitationRoutes(app, pool);
  await registerAiRoutes(app, pool);

  return app;
}
