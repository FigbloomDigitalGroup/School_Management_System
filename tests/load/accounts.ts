/**
 * Load test, step 2: the throwaway school's accounts, made through the same Admin API the seeds use.
 * LOCAL SUPABASE ONLY (refuses any other address).
 *
 *   npx tsx --env-file=.env tests/load/accounts.ts          # 1 admin, 60 teachers, 500 parents
 *   TEACHERS=10 PARENTS=20 npx tsx --env-file=.env tests/load/accounts.ts
 *
 * Every login uses the local dev password, like the seeded demo accounts.
 */
import { createClient } from "@supabase/supabase-js";
import { loginIdEmail } from "../../packages/shared/src/auth";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (see .env)");
if (new URL(url).hostname !== "127.0.0.1") throw new Error(`Refusing to run against ${url}: local stack only`);

const SLUG = "load-test";
const PASSWORD = "figbloom-dev";
const TEACHERS = Number(process.env.TEACHERS ?? 60);
const PARENTS = Number(process.env.PARENTS ?? 500);
const db = createClient(url, key, { auth: { persistSession: false } });
const pad = (n: number, w: number) => String(n).padStart(w, "0");

interface Person { loginId: string; email?: string; role: "school_admin" | "teacher" | "parent"; name: string; title?: string }

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const { data: tenant, error: tErr } = await db.from("tenants").select("id").eq("slug", SLUG).single();
if (tErr) throw new Error(`school ${SLUG} not found: run school-1-tenant.sql first (${tErr.message})`);

const people: Person[] = [
  { loginId: "ADM-L001", email: "principal@load-test.sc.ke", role: "school_admin", name: "Load Principal", title: "Principal" },
  ...Array.from({ length: TEACHERS }, (_, i): Person => ({ loginId: `TC-L${pad(i + 1, 3)}`, role: "teacher", name: `Load Teacher ${i + 1}`, title: "Teacher" })),
  ...Array.from({ length: PARENTS }, (_, i): Person => ({ loginId: `PT-L${pad(i + 1, 4)}`, role: "parent", name: `Load Parent ${i + 1}` })),
];

const t0 = Date.now();
const created = await inBatches(people, 10, async (p) => {
  const { data, error } = await db.auth.admin.createUser({ email: p.email ?? loginIdEmail(p.loginId, SLUG), password: PASSWORD, email_confirm: true });
  if (error) { console.warn(`  ! ${p.loginId}: ${error.message}`); return null; }
  return { ...p, id: data.user.id };
});
const ok = created.filter((p): p is NonNullable<typeof p> => p !== null);
console.log(`auth users created: ${ok.length} of ${people.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const rows = ok.map((p) => ({
  id: p.id, tenant_id: tenant.id, role: p.role, full_name: p.name,
  email: p.email ?? null, login_id: p.email ? null : p.loginId, staff_title: p.title ?? null,
}));
for (let i = 0; i < rows.length; i += 200) {
  const { error } = await db.from("profiles").insert(rows.slice(i, i + 200));
  if (error) throw new Error(`profiles: ${error.message}`);
}
console.log(`profiles inserted: ${rows.length}`);
