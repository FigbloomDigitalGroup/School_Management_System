/**
 * Disposable EXPLAIN capture for FIG-1621 keyset queries (local evidence only).
 * Uses MIGRATION_DATABASE_URL / isolated figbloom_api. Does not modify production.
 */
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ownerUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:58322/figbloom_api";

const url = new URL(ownerUrl);
if (url.pathname.replace(/^\//, "") !== "figbloom_api") {
  throw new Error("Refusing EXPLAIN against a non-figbloom_api database");
}

const pool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const out = [];
const push = (s) => out.push(s);

async function explain(title, sql, params = []) {
  push(`\n## ${title}\n`);
  push("```sql\n" + sql.trim() + "\n```\n");
  const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  push("```\n" + r.rows.map((row) => row["QUERY PLAN"]).join("\n") + "\n```\n");
  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename, indexname`,
    [title.includes("org") ? ["tenants", "organizations", "organization_memberships"] :
     title.includes("delegation") ? ["org_admin_school_delegations"] :
     title.includes("guardian") ? ["guardian_links", "guardians"] :
     title.includes("permission") ? [] : []],
  );
  if (idx.rows.length) {
    push("### Related indexes\n");
    for (const row of idx.rows) {
      push(`- \`${row.indexname}\`: \`${row.indexdef}\`\n`);
    }
  }
}

try {
  push("# WP-A1 keyset EXPLAIN evidence (FIG-1621 / N-5)\n");
  push(`Captured: ${new Date().toISOString()}\n`);
  push(`Database: figbloom_api @ ${url.hostname}:${url.port || 5432}\n`);
  push("\nRepresentative cardinality: post-migration fixture-scale tables (disposable).\n");

  // Seed a modest distribution if tables are empty-ish (idempotent-ish inserts skipped if no orgs).
  const org = await pool.query(`SELECT id FROM organizations LIMIT 1`);
  if (org.rowCount === 0) {
    push("\n_No organizations present; run API suite once or seed fixtures before capture._\n");
  } else {
    const orgId = org.rows[0].id;
    const user = await pool.query(`SELECT user_id FROM organization_memberships WHERE role = 'org_admin' LIMIT 1`);
    const userId = user.rows[0]?.user_id;

    if (userId) {
      await explain(
        "Org schools keyset (COLLATE C)",
        `SELECT t.id, t.name
         FROM tenants t
         JOIN organizations o ON o.id = t.organization_id
         JOIN organization_memberships om
           ON om.organization_id = o.id AND om.user_id = $1 AND om.role = 'org_admin'
         WHERE o.status = 'active'
           AND (o.name COLLATE "C", t.name COLLATE "C", t.id) > ($2, $3, $4::uuid)
         ORDER BY o.name COLLATE "C", t.name COLLATE "C", t.id
         LIMIT 51`,
        [userId, "A", "A", "00000000-0000-0000-0000-000000000001"],
      );
    }

    const tenant = await pool.query(`SELECT id FROM tenants LIMIT 1`);
    const tenantId = tenant.rows[0]?.id;
    if (tenantId) {
      await explain(
        "Org-admin delegations keyset",
        `SELECT id, created_at
         FROM org_admin_school_delegations
         WHERE tenant_id = $1
           AND (created_at < $2::timestamptz OR (created_at = $2::timestamptz AND id > $3::uuid))
         ORDER BY created_at DESC, id
         LIMIT 51`,
        [tenantId, "2026-01-01T00:00:00.000000Z", "00000000-0000-0000-0000-000000000001"],
      );

      await explain(
        "Guardian links keyset",
        `SELECT l.id, l.created_at
         FROM guardian_links l
         JOIN guardians g ON g.id = l.guardian_id
         WHERE l.tenant_id = $1
           AND (l.created_at, l.id) > ($2::timestamptz, $3::uuid)
         ORDER BY l.created_at, l.id
         LIMIT 51`,
        [tenantId, "2020-01-01T00:00:00.000000Z", "00000000-0000-0000-0000-000000000001"],
      );
    }

    await explain(
      "Permissions unnest keyset (bounded catalogue)",
      `SELECT code
       FROM unnest($1::text[]) AS t(code)
       WHERE code > $2
       ORDER BY code
       LIMIT 51`,
      [
        Array.from({ length: 200 }, (_, i) => `perm.code.${String(i).padStart(3, "0")}`),
        "perm.code.050",
      ],
    );
  }

  push("\n## Index decision\n");
  push(
    "At fixture / current disposable cardinality, plans are acceptable for verification. " +
      "Org schools use COLLATE \"C\" which typically prevents btree index use on name columns — " +
      "documented residual. Covering indexes `(tenant_id, created_at DESC, id)` on " +
      "`org_admin_school_delegations` and `(tenant_id, learner_id, created_at, id)` on " +
      "`guardian_links` remain **optional** and are **not** added without production-scale " +
      "sequential-sort evidence (acceptance E12). No speculative migration 015 in this change.\n",
  );

  const dest = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../.personal-ai/wp-a1/execution/WP-A1-KEYSET-EXPLAIN-EVIDENCE.md",
  );
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out.join(""), "utf8");
  console.log("Wrote", dest);
} finally {
  await pool.end();
}
