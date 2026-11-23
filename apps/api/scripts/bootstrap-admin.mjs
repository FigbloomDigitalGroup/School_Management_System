#!/usr/bin/env node
// Controlled, auditable bootstrap of the FIRST platform (super) administrator. Operator action, run once per environment:
//
//   MIGRATION_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//   BOOTSTRAP_ADMIN_EMAIL=admin@example.org BOOTSTRAP_ADMIN_NAME="Platform Admin" FIGBLOOM_BOOTSTRAP_CONFIRM=yes \
//   node scripts/bootstrap-admin.mjs
//
// * There is NO default administrator and NO default password. The account is created with an UNUSABLE credential and the
//   script prints a single-use, 30-minute SETUP TOKEN once to the operator's terminal (never to a log file by this script).
//   The administrator completes setup with POST /v1/auth/password-reset/complete {token, password} and chooses their own password.
// * Refuses to run when ANY super administrator already exists (use the authenticated provisioning API afterwards), when the
//   confirmation variable is not exactly "yes", or when the e-mail already belongs to a user.
// * The whole operation is one transaction and writes a 'platform.bootstrap' audit event. Nothing destructive is performed.
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const url = process.env.MIGRATION_DATABASE_URL;
const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
const name = (process.env.BOOTSTRAP_ADMIN_NAME ?? "").trim() || email;
if (!url) fail("MIGRATION_DATABASE_URL (the migrator/owner connection) is required");
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) fail("BOOTSTRAP_ADMIN_EMAIL must be a valid e-mail address");
if (process.env.FIGBLOOM_BOOTSTRAP_CONFIRM !== "yes") fail("set FIGBLOOM_BOOTSTRAP_CONFIRM=yes to confirm creating the first platform administrator");

const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("LOCK TABLE public.platform_roles IN SHARE ROW EXCLUSIVE MODE");
  const existing = await client.query("SELECT 1 FROM public.platform_roles WHERE role = 'super_admin' LIMIT 1");
  if (existing.rowCount > 0) fail("a super administrator already exists; bootstrap is a one-time operation");
  const dupe = await client.query("SELECT 1 FROM public.users WHERE lower(email) = $1", [email]);
  if (dupe.rowCount > 0) fail("that e-mail already belongs to a user");
  const user = await client.query(
    "INSERT INTO public.users (email, password_hash, full_name, status, must_change_password) VALUES ($1, '!', $2, 'invited', false) RETURNING id",
    [email, name],
  );
  const userId = user.rows[0].id;
  await client.query("INSERT INTO public.platform_roles (user_id, role) VALUES ($1, 'super_admin')", [userId]);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  await client.query(
    "INSERT INTO public.account_tokens (kind, token_hash, user_id, email, created_by, expires_at) VALUES ('password_reset', $1, $2, $3, NULL, now() + interval '30 minutes')",
    [hash, userId, email],
  );
  await client.query(
    "INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail) VALUES ($1, NULL, 'platform.bootstrap', $2::jsonb)",
    [userId, JSON.stringify({ via: "bootstrap-admin.mjs" })],
  );
  await client.query("COMMIT");
  console.log(`Platform administrator created for ${email}.`);
  console.log("SETUP TOKEN (shown once, valid 30 minutes, single use):");
  console.log(token);
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw err;
} finally {
  client.release();
  await pool.end();
}

function fail(message) {
  console.error(`bootstrap refused: ${message}`);
  process.exit(2);
}
