import type pg from "pg";

const POWERFUL_PREDEFINED = [
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_execute_server_program",
  "pg_write_server_files",
  "pg_read_server_files",
  "pg_checkpoint",
  "pg_monitor",
  "pg_read_all_settings",
  "pg_read_all_stats",
  "pg_stat_scan_tables",
  "pg_signal_backend",
  "pg_database_owner",
] as const;

export interface RoleAssertionOptions {
  /** Expected runtime role name (usually figbloom_app). */
  expectedRole: string;
}

async function inTransaction(client: pg.Pool | pg.PoolClient): Promise<boolean> {
  const row = await client.query<{ id: string | null }>(
    `SELECT txid_current_if_assigned()::text AS id`,
  );
  return row.rows[0]?.id != null;
}

/**
 * Prove SET ROLE / SET SESSION AUTHORIZATION cannot assume `role`.
 * A failed statement inside a transaction is recovered with a savepoint.
 */
async function assertCannotAssume(
  client: pg.Pool | pg.PoolClient,
  role: string,
  statement: "ROLE" | "SESSION AUTHORIZATION",
): Promise<void> {
  const transactional = await inTransaction(client);
  if (transactional) await client.query("SAVEPOINT figbloom_role_probe");
  try {
    await client.query(`SET ${statement} ${role}`);
    try {
      await client.query("RESET ROLE");
    } catch {
      /* session authorization resets with RESET SESSION AUTHORIZATION */
      await client.query("RESET SESSION AUTHORIZATION").catch(() => undefined);
    }
    throw new Error(`Unsafe runtime role: SET ${statement} ${role} succeeded`);
  } catch (err) {
    if (transactional) {
      await client.query("ROLLBACK TO SAVEPOINT figbloom_role_probe");
      await client.query("RELEASE SAVEPOINT figbloom_role_probe").catch(() => undefined);
    }
    if (err instanceof Error && err.message.startsWith("Unsafe runtime role:")) throw err;
  }
}

/**
 * Startup assertion on the real runtime connection (AD-1).
 * Names the violated property. Never includes a credential or connection string.
 */
export async function assertRuntimeRole(
  client: pg.Pool | pg.PoolClient,
  opts: RoleAssertionOptions,
): Promise<void> {
  const identity = await client.query<{
    current_user: string;
    session_user: string;
  }>(`SELECT current_user::text AS current_user, session_user::text AS session_user`);
  const { current_user: currentUser, session_user: sessionUser } = identity.rows[0]!;

  if (currentUser !== sessionUser) {
    throw new Error(
      `Unsafe runtime role: current_user (${currentUser}) differs from session_user (${sessionUser})`,
    );
  }
  if (currentUser !== opts.expectedRole) {
    throw new Error(`Unsafe runtime role: expected ${opts.expectedRole}, got ${currentUser}`);
  }

  const flags = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
     FROM pg_roles WHERE rolname = current_user`,
  );
  const f = flags.rows[0];
  if (!f) throw new Error("Unsafe runtime role: role row missing from pg_roles");
  if (f.rolsuper) throw new Error("Unsafe runtime role: rolsuper is true");
  if (f.rolbypassrls) throw new Error("Unsafe runtime role: rolbypassrls is true");
  if (f.rolcreaterole) throw new Error("Unsafe runtime role: rolcreaterole is true");
  if (f.rolcreatedb) throw new Error("Unsafe runtime role: rolcreatedb is true");
  if (f.rolreplication) throw new Error("Unsafe runtime role: rolreplication is true");

  // Direct or transitive membership of any other role, including predefined ones.
  // GRANT figbloom_app TO the migrator is the safe direction and does not appear here.
  const members = await client.query<{ rolname: string }>(
    `WITH RECURSIVE membership AS (
       SELECT r.rolname, r.oid
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid
       WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       UNION
       SELECT r.rolname, r.oid
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid
       JOIN membership prev ON m.member = prev.oid
     )
     SELECT rolname FROM membership`,
  );
  if (members.rows.length > 0) {
    throw new Error(
      `Unsafe runtime role: member of other role(s): ${members.rows.map((r) => r.rolname).join(", ")}`,
    );
  }

  for (const role of POWERFUL_PREDEFINED) {
    const exists = await client.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS ok`,
      [role],
    );
    if (!exists.rows[0]?.ok) continue;
    for (const kind of ["MEMBER", "USAGE"] as const) {
      const check = await client.query<{ ok: boolean }>(
        `SELECT pg_has_role(current_user, $1, $2) AS ok`,
        [role, kind],
      );
      if (check.rows[0]?.ok) {
        throw new Error(`Unsafe runtime role: effective ${kind} of ${role}`);
      }
    }
  }

  const owned = await client.query<{ kind: string; name: string }>(
    `SELECT CASE c.relkind
              WHEN 'S' THEN 'sequence'
              WHEN 'f' THEN 'function'
              ELSE 'relation'
            END AS kind,
            c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     UNION ALL
     SELECT 'function', p.proname
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     UNION ALL
     SELECT 'schema', n.nspname
     FROM pg_namespace n
     WHERE n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND n.nspname = 'public'
     LIMIT 5`,
  );
  if (owned.rows.length > 0) {
    throw new Error(
      `Unsafe runtime role: owns application object(s): ${owned.rows
        .map((r) => `${r.kind}:${r.name}`)
        .join(", ")}`,
    );
  }

  const createSchema = await client.query<{ ok: boolean }>(
    `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok`,
  );
  if (createSchema.rows[0]?.ok) {
    throw new Error("Unsafe runtime role: CREATE privilege on schema public");
  }

  const createDb = await client.query<{ ok: boolean }>(
    `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok`,
  );
  if (createDb.rows[0]?.ok) {
    throw new Error("Unsafe runtime role: CREATE privilege on the database");
  }

  await assertCannotAssume(client, "postgres", "ROLE");
  await assertCannotAssume(client, "postgres", "SESSION AUTHORIZATION");
}
