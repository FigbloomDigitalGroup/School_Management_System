import type pg from "pg";
import { trackQuery } from "./clientHealth.js";

/**
 * Narrow query surface shared by identity and tenant handles.
 * Application modules must not hold a raw PoolClient for tenant work.
 */
export interface SqlClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    queryTextOrConfig: string | pg.QueryConfig,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

/** Branded tenant-scoped transaction handle (AD-3). */
export type Tx = SqlClient & {
  readonly __tx: "tenant";
  readonly tenantId: string;
  readonly userId: string;
};

/** Branded identity-plane handle — no tenant context (AD-3). */
export type IdentityDb = SqlClient & {
  readonly __tx: "identity";
};

/**
 * Polymorphic helper handle. Used only where a function legitimately runs on
 * either path (authorisation helpers and school_memberships reads, AD-4).
 * Tenant-table access through the identity member returns zero rows (RLS, no
 * tenant context); the architecture test lists each such exception explicitly.
 */
export type TxOrIdentity = Tx | IdentityDb;

/**
 * Query function over a pool or one pooled client. A pooled client's queries are tracked
 * (clientHealth.ts) so a timed-out or abandoned query gets the connection destroyed
 * instead of returned to the pool. pool.query already discards a failed client itself.
 */
function queryFunction(client: pg.Pool | pg.PoolClient): SqlClient["query"] {
  const raw = (queryTextOrConfig: string | pg.QueryConfig, values?: unknown[]) =>
    values === undefined
      ? client.query(queryTextOrConfig)
      : client.query(queryTextOrConfig as string, values);
  if (typeof (client as pg.PoolClient).release !== "function") return raw as SqlClient["query"];
  return ((queryTextOrConfig: string | pg.QueryConfig, values?: unknown[]) =>
    trackQuery(client, () => raw(queryTextOrConfig, values))) as SqlClient["query"];
}

export function createTxHandle(
  client: pg.PoolClient,
  meta: { tenantId: string; userId: string },
): Tx {
  return {
    __tx: "tenant",
    tenantId: meta.tenantId,
    userId: meta.userId,
    query: queryFunction(client),
  };
}

export function createIdentityHandle(client: pg.Pool | pg.PoolClient): IdentityDb {
  return {
    __tx: "identity",
    query: queryFunction(client),
  };
}
