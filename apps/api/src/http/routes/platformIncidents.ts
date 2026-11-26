import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import type { IdentityDb } from "../../db/sql.js";
import { notFound, validationError } from "../errors.js";
import { pageFromKeysetRows, parseListQuery } from "../pagination.js";
import { asPlatformActor, requirePlatformActor } from "../platformAccess.js";
import { assertUuid } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

/**
 * The platform incident list (apps/api/docs/PLATFORM-CONSOLE.md section 3.4, owner decision D5: keep a hand-typed list).
 *
 * Figbloom staff declare an incident and resolve it by hand; nothing writes one automatically and no school sees them.
 * `platform_incidents` (migration 121) has no `tenant_id` and no privilege for the runtime role: every read and write goes
 * through its SECURITY DEFINER functions, which re-check the super administrator and write the audit row
 * (`platform.incident.declared`, `platform.incident.resolved`) in the same transaction.
 *
 * Permission `platform.incidents.manage` (super_admin only), checked with no school. Declaring and resolving also need a
 * recent sign-in (`assertRecentAuth`). Resolving an incident that is already resolved changes nothing and answers
 * `changed: false`.
 */

const SORT = "opened_at_desc";
const STATES = ["open", "resolved"] as const;

const DeclareBody = z.strictObject({
  severity: z.enum(["SEV-1", "SEV-2", "SEV-3"]),
  title: z.string().min(1).max(200).regex(/\S/),
  summary: z.string().min(1).max(2000).regex(/\S/),
  affected_schools: z.number().int().min(0).max(100000),
});

export const PLATFORM_INCIDENT_REQUEST_SCHEMAS = {
  "POST /v1/platform/incidents": DeclareBody,
} as const;

interface IncidentRow {
  id: string;
  severity: string;
  title: string;
  summary: string;
  affected_schools: number;
  status: string;
  opened_at_text: string;
  opened_by: string | null;
  opened_by_name: string | null;
  resolved_at_text: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
}

function toIncident(r: IncidentRow) {
  return {
    id: r.id,
    severity: r.severity,
    title: r.title,
    summary: r.summary,
    affectedSchools: r.affected_schools,
    status: r.status,
    openedAt: r.opened_at_text,
    openedBy: r.opened_by,
    openedByName: r.opened_by_name,
    resolvedAt: r.resolved_at_text,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
  };
}

const LIST_SQL = `SELECT * FROM public.platform_incidents_list($1::uuid, $2::text, $3::timestamptz, $4::uuid, $5::integer)`;

async function readOne(db: IdentityDb, id: string) {
  const res = await db.query<IncidentRow>(LIST_SQL, [id, null, null, null, 1]);
  const row = res.rows[0];
  if (!row) throw notFound("Incident not found");
  return toIncident(row);
}

function parseState(query: Record<string, unknown>): (typeof STATES)[number] | null {
  const raw = query.state;
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !(STATES as readonly string[]).includes(raw)) {
    throw validationError("state must be open or resolved", [{ field: "state", code: "invalid_value", message: "Invalid value" }]);
  }
  return raw as (typeof STATES)[number];
}

export async function registerPlatformIncidentRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const PERMISSION = "platform.incidents.manage";

  app.get("/v1/platform/incidents", async (request) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const query = request.query as Record<string, unknown>;
    const state = parseState(query);
    const { limit, cursor, fingerprint } = parseListQuery(query, {
      sort: SORT,
      filter: { scope: "platform_incidents", state },
      keySpecs: [{ kind: "timestamptz_micros" }, { kind: "uuid" }],
    });
    const rows = await asPlatformActor(
      app,
      pool,
      actor,
      async (db) =>
        (await db.query<IncidentRow>(LIST_SQL, [null, state, cursor ? cursor.k[0]! : null, cursor ? cursor.k[1]! : null, limit + 1])).rows,
      { sensitive: false },
    );
    const paged = pageFromKeysetRows(rows, { limit, sort: SORT, fingerprint, keysOf: (r) => [r.opened_at_text, r.id] });
    return { items: paged.items.map(toIncident), page: paged.page };
  });

  app.post("/v1/platform/incidents", async (request, reply) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const body = parseOrThrow(DeclareBody, request.body, "severity, title, summary and affected_schools are required");
    const incident = await asPlatformActor(
      app,
      pool,
      actor,
      async (db) => {
        const res = await db.query<{ id: string }>(
          `SELECT public.platform_incident_declare($1::text, $2::text, $3::text, $4::integer) AS id`,
          [body.severity, body.title, body.summary, body.affected_schools],
        );
        return readOne(db, res.rows[0]!.id);
      },
      { sensitive: true },
    );
    return reply.status(201).send({ incident });
  });

  app.post("/v1/platform/incidents/:incidentId/resolve", async (request) => {
    const actor = await requirePlatformActor(app, pool, request, PERMISSION);
    const { incidentId } = request.params as { incidentId: string };
    assertUuid(incidentId, "incidentId");
    return asPlatformActor(
      app,
      pool,
      actor,
      async (db) => {
        let changed: boolean;
        try {
          const res = await db.query<{ changed: boolean }>(`SELECT public.platform_incident_resolve($1::uuid) AS changed`, [incidentId]);
          changed = res.rows[0]!.changed === true;
        } catch (err) {
          if ((err as { code?: string } | null)?.code === "P0002") throw notFound("Incident not found");
          throw err;
        }
        return { incident: await readOne(db, incidentId), changed };
      },
      { sensitive: true },
    );
  });
}
