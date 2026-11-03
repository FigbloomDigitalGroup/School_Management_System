/**
 * Load test, step 4: what k6 reads. Writes three files to test-results/load/ (git-ignored):
 *   accounts.json  every account of the load school
 *   payables.json  100 invoices of the current term with at least KSh 1,000 still owing
 *   tokens.json    a signed access token per account, made with the LOCAL dev JWT secret (a public default)
 *
 * k6 sends these straight to the API, so the test measures the API and the database, not the sign-in
 * rate limit. Sign-in itself is measured by its own scenario. LOCAL SUPABASE ONLY.
 *
 *   npx tsx --env-file=.env tests/load/tokens.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const url = process.env.SUPABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("local stack only: SUPABASE_URL must be http://127.0.0.1:...");
const SECRET = process.env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_figbloom";
const OUT = "test-results/load";

const psql = (sql: string) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const tenant = "(select id from tenants where slug = 'load-test')";
const accounts = JSON.parse(psql(
  `select json_agg(json_build_object('id', p.id, 'login', coalesce(p.login_id, 'ADM-L001'), 'role', p.role, 'email', u.email) order by p.login_id)
   from profiles p join auth.users u on u.id = p.id where p.tenant_id = ${tenant}`)) as { id: string; login: string; role: string; email: string }[];
const payables = JSON.parse(psql(
  `select json_agg(x.id) from (select i.id from fee_invoices i join terms t on t.id = i.term_id
    where t.tenant_id = ${tenant} and t.is_current and i.total_cents - i.paid_cents >= 100000
    order by abs(hashtext(i.id::text)) limit 100) x`)) as string[];

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const tokens: Record<string, { id: string; email: string; role: string; token: string }> = {};
for (const a of accounts) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    iss: `${url}/auth/v1`, aud: "authenticated", sub: a.id, role: "authenticated", email: a.email, iat: now, exp: now + 4 * 3600,
    aal: "aal1", amr: [{ method: "password", timestamp: now }], session_id: randomUUID(), is_anonymous: false, app_metadata: {}, user_metadata: {},
  });
  tokens[a.login] = { id: a.id, email: a.email, role: a.role, token: `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}` };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/accounts.json`, JSON.stringify(accounts));
writeFileSync(`${OUT}/payables.json`, JSON.stringify(payables ?? []));
writeFileSync(`${OUT}/tokens.json`, JSON.stringify(tokens));
console.log(`${accounts.length} accounts, ${(payables ?? []).length} payable invoices, ${Object.keys(tokens).length} tokens (valid 4 h) written to ${OUT}/`);
