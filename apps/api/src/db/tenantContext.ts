import type pg from "pg";

/**
 * Transaction-local tenant / user context for hybrid RLS (D-3).
 * Always use SET LOCAL so pooled connections cannot leak context.
 */
export async function setTenantContext(
  client: pg.PoolClient,
  input: { tenantId?: string | null; userId?: string | null; mode?: "app" | "bypass" | "owner" },
): Promise<void> {
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [input.tenantId ?? ""]);
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.userId ?? ""]);
  await client.query(`SELECT set_config('app.authz_mode', $1, true)`, [
    input.mode === "bypass" ? "bypass" : input.mode === "owner" ? "owner" : "",
  ]);
}

export async function clearTenantContext(client: pg.PoolClient): Promise<void> {
  await setTenantContext(client, {});
}
