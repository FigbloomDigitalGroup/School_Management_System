#!/usr/bin/env node
// Step 1 of the Supabase -> apps/api move: copy what the schools have in Supabase into a snapshot on disk.
//
//   SOURCE_DATABASE_URL=postgresql://... node scripts/supabase-to-api/extract.mjs --out <dir> [--school <slug>]...
//
// READ ONLY. The connection is opened in a READ ONLY, REPEATABLE READ transaction, so the snapshot is one
// consistent moment and the script cannot change Supabase even by mistake. It never reads `auth.*`, so no
// password hash leaves the database (people get an invitation or a password reset in the API instead).
//
// The snapshot holds real people, children among them. `--out` must be OUTSIDE this repository, and the log
// prints counts only, never names.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertOutsideRepo } from "./lib/safety.mjs";

// A `date` column (term start, date of birth) must stay the text Postgres wrote ("2026-01-05"). By default `pg`
// turns it into a Date at local midnight, which JSON.stringify then shifts a day back east of Greenwich.
pg.types.setTypeParser(1082, (v) => v);

function parseArgs(argv) {
  const out = { schools: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") out.out = argv[(i += 1)];
    else if (a === "--school") out.schools.push(argv[(i += 1)]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

/** The tables, in the order the loader needs them. Each query takes the list of tenant ids as $1. */
export const EXTRACTS = [
  {
    name: "organizations",
    sql: `select * from public.organizations
          where id in (select organization_id from public.tenants where id = any($1))
          order by created_at, id`,
  },
  {
    name: "tenants",
    sql: `select * from public.tenants where id = any($1) order by created_at, id`,
  },
  {
    name: "terms",
    sql: `select * from public.terms where tenant_id = any($1) order by tenant_id, year, index`,
  },
  {
    name: "classes",
    sql: `select * from public.classes where tenant_id = any($1) order by tenant_id, form_level, stream nulls first, name`,
  },
  {
    // Staff, parents, students with a login and the drivers/guards: everyone with a profile at the school.
    name: "profiles",
    sql: `select * from public.profiles where tenant_id = any($1) order by tenant_id, role, created_at, id`,
  },
  {
    name: "students",
    sql: `select * from public.students where tenant_id = any($1) order by tenant_id, admission_no, id`,
  },
  {
    name: "guardians",
    sql: `select * from public.guardians where tenant_id = any($1) order by tenant_id, student_id, profile_id`,
  },
  {
    name: "teaching_assignments",
    sql: `select * from public.teaching_assignments where tenant_id = any($1) order by tenant_id, id`,
  },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SOURCE_DATABASE_URL;
  if (!url) throw new Error("Set SOURCE_DATABASE_URL (a READ-ONLY role on the Supabase database is best).");
  if (!args.out) throw new Error("Pass --out <directory>, outside this repository.");

  const outDir = assertOutsideRepo(args.out, "--out");
  mkdirSync(outDir, { recursive: true });

  const host = new URL(url).host;
  const client = new pg.Client({ connectionString: url, application_name: "supabase-to-api-extract" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout = '60s'");

    const wanted = args.schools;
    const tenants = (
      await client.query(
        `select id, slug, status from public.tenants
         where ($1::text[] is null or slug = any($1::text[])) order by created_at, id`,
        [wanted.length ? wanted : null],
      )
    ).rows;
    if (wanted.length) {
      const missing = wanted.filter((s) => !tenants.some((t) => t.slug === s));
      if (missing.length) throw new Error(`No school with slug: ${missing.join(", ")}`);
    }
    const ids = tenants.map((t) => t.id);
    console.log(`source ${host}: ${tenants.length} school(s)`);

    const counts = {};
    for (const { name, sql } of EXTRACTS) {
      const { rows } = await client.query(sql, [ids]);
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(rows, null, 2));
      counts[name] = rows.length;
      console.log(`  ${name.padEnd(22)} ${String(rows.length).padStart(7)}`);
    }
    await client.query("ROLLBACK");

    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({ takenAt: new Date().toISOString(), sourceHost: host, schools: tenants, counts }, null, 2),
    );
    console.log(`snapshot written to ${outDir}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  // Not process.exit(): on Windows it can trip a libuv assertion while sockets are still closing.
  process.exitCode = 1;
});
