import type pg from "pg";

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

export function createTxHandle(
  client: pg.PoolClient,
  meta: { tenantId: string; userId: string },
): Tx {
  return {
    __tx: "tenant",
    tenantId: meta.tenantId,
    userId: meta.userId,
    query: ((queryTextOrConfig: string | pg.QueryConfig, values?: unknown[]) =>
      values === undefined
        ? client.query(queryTextOrConfig)
        : client.query(queryTextOrConfig as string, values)) as SqlClient["query"],
  };
}

export function createIdentityHandle(client: pg.Pool | pg.PoolClient): IdentityDb {
  return {
    __tx: "identity",
    query: ((queryTextOrConfig: string | pg.QueryConfig, values?: unknown[]) =>
      values === undefined
        ? client.query(queryTextOrConfig)
        : client.query(queryTextOrConfig as string, values)) as SqlClient["query"],
  };
}
