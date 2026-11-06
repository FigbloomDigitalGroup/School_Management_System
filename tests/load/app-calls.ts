/**
 * Times the apps' own calls as ONE signed-in user against the load school, and logs every request (status and
 * milliseconds). It runs the shared loaders the phone and web apps use (loadParentData, the teacher register
 * functions), so what it reports is what a person waits for. LOCAL SUPABASE ONLY.
 *
 *   npx tsx --env-file=.env tests/load/app-calls.ts            # admin, teacher and parent
 *   npx tsx --env-file=.env tests/load/app-calls.ts parent     # just one
 *
 * The teacher part saves a register for 2026-11-02 and then saves it again (a correction): both rows go away
 * with the school (tests/load/cleanup.sh). Results: test-results/load/app_calls.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const url = process.env.SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error("SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required (see .env)");
if (new URL(url).hostname !== "127.0.0.1") throw new Error(`Refusing ${url}: local stack only`);

interface Hit { who: string; step: string; method: string; path: string; status: number; ms: number }
const hits: Hit[] = [];
let who = "";
let step = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const t0 = performance.now();
  const res = await realFetch(input, init);
  const u = new URL(typeof input === "string" ? input : input.url);
  hits.push({ who, step, method: init?.method ?? "GET", path: u.pathname + u.search, status: res.status, ms: Math.round(performance.now() - t0) });
  return res;
}) as typeof fetch;

const { initSupabase, supabase } = await import("../../packages/shared/src/supabase");
const { loadParentData } = await import("../../packages/shared/src/parentData");
const teacher = await import("../../packages/shared/src/teacherData");
const { newRegister } = await import("../../packages/shared/src/attendance");

initSupabase({ url, anonKey: anon, detectSessionInUrl: false });
const PASSWORD = "figbloom-dev";
const email = (id: string) => `${id.toLowerCase()}@login.load-test.figbloom.internal`;

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  step = label;
  const t0 = performance.now();
  try { return await fn(); } finally { console.log(`  ${label.padEnd(48)} ${String(Math.round(performance.now() - t0)).padStart(6)} ms`); }
}
async function signIn(loginEmail: string, label: string): Promise<string> {
  await supabase().auth.signOut({ scope: "local" });
  who = label;
  const { data, error } = await time(`${label}: sign in`, async () => supabase().auth.signInWithPassword({ email: loginEmail, password: PASSWORD }));
  if (error) throw error;
  return data.user.id;
}

const wanted = process.argv.slice(2);
const want = (n: string) => wanted.length === 0 || wanted.includes(n);

if (want("admin")) {
  console.log("ADMIN opens the Dashboard");
  const uid = await signIn("principal@load-test.sc.ke", "admin");
  const { data: prof } = await supabase().from("profiles").select("tenant_id").eq("id", uid).single();
  const tenantId = prof!.tenant_id as string;
  const term = await time("admin: current term", async () => (await supabase().from("terms").select("id").eq("is_current", true).single()).data!);
  await time("admin: Dashboard first four reads (parallel)", async () => Promise.all([
    supabase().from("classes").select("id,name,class_teacher_id").eq("tenant_id", tenantId).order("name"),
    supabase().from("students").select("id,class_id").eq("tenant_id", tenantId).eq("active", true),
    supabase().from("profiles").select("id").eq("tenant_id", tenantId).in("role", ["school_admin", "teacher"]),
    supabase().from("fee_invoices").select("total_cents,paid_cents").eq("tenant_id", tenantId).eq("term_id", term.id),
  ]));
  const latest = await time("admin: latest register date (Dashboard)", async () =>
    supabase().from("attendance").select("taken_on").eq("tenant_id", tenantId).eq("term_id", term.id).order("taken_on", { ascending: false }).limit(1));
  console.log(`     -> status ${latest.status}${latest.error ? ` ${latest.error.code} ${latest.error.message}` : ""}`);
  await time("admin: that day for the whole school", async () =>
    supabase().from("attendance").select("class_id,mark").eq("tenant_id", tenantId).eq("term_id", term.id).eq("taken_on", "2026-10-30"));
  await time("admin: Reports attendance (whole term, capped at 1,000)", async () =>
    supabase().from("attendance").select("class_id,mark").eq("tenant_id", tenantId).eq("term_id", term.id));
}

if (want("teacher")) {
  console.log("TEACHER (class teacher TC-L001) opens a register and submits it");
  const uid = await signIn(email("TC-L001"), "teacher");
  const { data: prof } = await supabase().from("profiles").select("tenant_id").eq("id", uid).single();
  const tenantId = prof!.tenant_id as string;
  const classes = await time("teacher: my classes", () => teacher.fetchTeacherClasses(uid));
  const term = await time("teacher: current term", () => teacher.fetchCurrentTerm());
  const classId = classes[0]!.id as string;
  const roster = await time("teacher: class roster", () => teacher.fetchClassRoster(classId));
  await time("teacher: today's marks already saved", () => teacher.fetchTodayAttendanceMarks(classId));
  const reg = newRegister(classId, term!.id, roster.map((s) => s.id), "2026-11-02");
  await time(`teacher: SUBMIT register (${roster.length} learners)`, () => teacher.writeAttendance(reg, tenantId, uid));
  await time("teacher: submit again (a correction)", () => teacher.writeAttendance(reg, tenantId, uid));
}

if (want("parent")) {
  console.log("PARENT (PT-L0001) opens the app");
  const uid = await signIn(email("PT-L0001"), "parent");
  await time("parent: loadParentData (the whole home screen)", () => loadParentData(uid));
}

const out = "test-results/load";
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/app_calls.json`, JSON.stringify(hits, null, 1));
console.log(`\n${hits.length} requests logged to ${out}/app_calls.json; the slow ones (300 ms or more):`);
for (const h of hits.filter((x) => x.ms >= 300).sort((a, b) => b.ms - a.ms)) {
  console.log(`  ${String(h.ms).padStart(6)} ms  ${h.status}  ${h.method} ${h.path.slice(0, 140)}`);
}
