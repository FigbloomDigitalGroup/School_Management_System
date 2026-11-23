import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

/**
 * Workstream 4: index review. A redundant index is one whose key definition equals another index's on the same table (same
 * columns, same predicate, same method, no uniqueness the other lacks). It costs writes and storage and serves no plan the other
 * does not. Prefix-redundant indexes are NOT dropped without evidence (they may back foreign-key delete guards or different
 * predicates), so this test only fails on exact duplicates.
 */
describe("index review (workstream 4)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("no table carries two indexes with an identical key definition", async () => {
    const r = await ctx.pool.query<{ tablename: string; key: string; names: string[] }>(
      `SELECT tablename,
              regexp_replace(indexdef, 'CREATE (UNIQUE )?INDEX \\S+ ON ', '') AS key,
              array_agg(indexname ORDER BY indexname) AS names
         FROM pg_indexes WHERE schemaname = 'public'
        GROUP BY tablename, regexp_replace(indexdef, 'CREATE (UNIQUE )?INDEX \\S+ ON ', '')
       HAVING count(*) > 1`,
    );
    expect(r.rows, "identical duplicate indexes: drop the non-unique twin in a forward migration").toEqual([]);
  });

  it("he_grades: the dropped plain index is gone and lookups by enrolment are served by the unique index (EXPLAIN)", async () => {
    const idx = await ctx.pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'he_grades' AND indexname IN ('he_grades_enrolment_idx', 'he_grades_current_uidx')`);
    expect(idx.rows.map((x) => x.indexname)).toEqual(["he_grades_current_uidx"]);
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan = off"); // an empty table would otherwise pick a seq scan; we ask which INDEX can serve it
      const plan = await c.query(`EXPLAIN SELECT * FROM he_grades WHERE tenant_id = '00000000-0000-4000-8000-000000000001' AND enrolment_id = '00000000-0000-4000-8000-000000000002'`);
      expect(plan.rows.map((x) => x["QUERY PLAN"]).join("\n")).toContain("he_grades_current_uidx");
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});
