/**
 * A believable 2026 behaviour log for the Kijani Ridge Academy demo school (made by seed-cbe.ts and
 * seed-kijani-full.ts), on 20261124400000_behaviour_log:
 *
 *   - behaviour settings: points on, mode "both", reset every term, parents see demerits (for the demo);
 *     incidents stay hidden from families (the default). Only written when the school has none yet.
 *   - the suggested categories (Helping others +2 ... Exam malpractice -10 serious), those it lacks.
 *   - for every term of 2026 that has started: 6-10 entries per learner (fewer for the term under way,
 *     in step with how much of it has passed), more merits than demerits, each recorded by a teacher of
 *     the learner's class (the class teacher or one with a teaching assignment there) on a school day;
 *   - a class merit ("Clean classroom duty") for a few classes each term;
 *   - ~20 serious incidents (Fighting, Bullying, Exam malpractice) with the action taken, most resolved;
 *   - two learners over the "Parent meeting" threshold (-15) this term, nobody else;
 *   - the showcase learner (ST-2001) has merits only.
 *
 *   npm run db:seed-kijani-behaviour -- --dry-run     # counts only, writes nothing
 *   npm run db:seed-kijani-behaviour
 *
 * SAFETY (production holds this school), as seed-kijani-full.ts:
 *   - Writes only rows of the tenant with slug kijani-ridge (EXPECT_TENANT_ID pins its id too).
 *     Refuses a non-local SUPABASE_URL unless ALLOW_REMOTE_SEED=1.
 *   - Every row has a deterministic id (or natural key) and is only inserted when missing: running it
 *     again changes nothing. Settings a school already has are left as they are.
 *   - Sends nothing: no edge function is called, no announcement or message is written. Entries are
 *     inserted by the server (service role, no one signed in), which the database's serious-incident
 *     notice skips by design. No accounts are created; no email addresses are written.
 */

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------- safety and set-up
const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:58321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required (supabase status shows it)");
const HOST = new URL(url).hostname;
const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]", "host.docker.internal"].includes(HOST);
if (!LOCAL && process.env.ALLOW_REMOTE_SEED !== "1") {
  throw new Error(`Refusing to seed ${HOST}: not a local Supabase. Set ALLOW_REMOTE_SEED=1 if you really mean it.`);
}
const SLUG = "kijani-ridge";
// "today" in Nairobi; SEED_TODAY=YYYY-MM-DD pins it (tests)
const TODAY = process.env.SEED_TODAY ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- small helpers
type Row = Record<string, unknown>;
let TENANT = "";
/** A stable uuid for this school and key: the same row gets the same id on every run. */
function uid(k: string): string {
  const h = createHash("sha1").update(`kijani-behaviour:${TENANT}:${k}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
/** A stable pseudo-random number in [0, 1) for these parts. */
function hr(...parts: (string | number)[]): number {
  return createHash("sha1").update(parts.join("|")).digest().readUInt32BE(0) / 2 ** 32;
}
const pickH = <T,>(xs: readonly T[], ...parts: (string | number)[]): T => xs[Math.floor(hr(...parts) * xs.length)]!;
function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const at = (d: string, hm: string) => new Date(`${d}T${hm}:00+03:00`).toISOString();
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function all<T = any>(what: string, q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await q(from, from + 999);
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    const page = (r.data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const STATS = new Map<string, { planned: number; added: number }>();
function stat(table: string, planned: number, added: number) {
  const s = STATS.get(table) ?? { planned: 0, added: 0 };
  s.planned += planned; s.added += added;
  STATS.set(table, s);
}

/** Inserts the rows (keyed by `idCol`, deterministic) that aren't there yet. Returns the new ones. */
async function insertMissing(table: string, rows: Row[], idCol = "id", size = 500): Promise<Row[]> {
  if (!rows.length) { stat(table, 0, 0); return []; }
  const have = new Set<string>();
  for (const ids of chunks(rows.map((r) => r[idCol] as string), 150)) {
    const { data, error } = await db.from(table).select(idCol).in(idCol, ids);
    if (error) throw new Error(`${table} (existing ids): ${error.message}`);
    for (const r of (data ?? []) as unknown as Row[]) have.add(r[idCol] as string);
  }
  const fresh = rows.filter((r) => !have.has(r[idCol] as string));
  stat(table, rows.length, fresh.length);
  if (DRY) return fresh;
  for (const part of chunks(fresh, size)) {
    const { error } = await db.from(table).insert(part, { defaultToNull: false });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return fresh;
}

// ---------------------------------------------------------------- what the school has
const DEFAULT_CATEGORIES: { kind: "merit" | "demerit"; name: string; points: number; severity: string | null; ord: number }[] = [
  { kind: "merit", name: "Helping others", points: 2, severity: null, ord: 1 },
  { kind: "merit", name: "Leadership", points: 3, severity: null, ord: 2 },
  { kind: "merit", name: "Academic effort", points: 2, severity: null, ord: 3 },
  { kind: "merit", name: "Clean classroom duty", points: 1, severity: null, ord: 4 },
  { kind: "merit", name: "Sportsmanship", points: 2, severity: null, ord: 5 },
  { kind: "demerit", name: "Late to class", points: 1, severity: "minor", ord: 11 },
  { kind: "demerit", name: "Incomplete homework", points: 1, severity: "minor", ord: 12 },
  { kind: "demerit", name: "Uniform not proper", points: 1, severity: "minor", ord: 13 },
  { kind: "demerit", name: "Disrupting class", points: 2, severity: "minor", ord: 14 },
  { kind: "demerit", name: "Disrespect", points: 3, severity: "major", ord: 15 },
  { kind: "demerit", name: "Vandalism", points: 5, severity: "major", ord: 16 },
  { kind: "demerit", name: "Fighting", points: 5, severity: "serious", ord: 17 },
  { kind: "demerit", name: "Bullying", points: 10, severity: "serious", ord: 18 },
  { kind: "demerit", name: "Exam malpractice", points: 10, severity: "serious", ord: 19 },
];

const NOTES: Record<string, string[]> = {
  "Helping others": ["Helped a new classmate find their way around.", "Stayed behind to help tidy the library.", "Helped a classmate who was unwell get to the sick bay.", "Shared revision notes with the group."],
  "Leadership": ["Led the group project and kept everyone on task.", "Organised the class for the cleaning rota.", "Spoke well for the class at assembly.", "Took charge of the class when the teacher was called away."],
  "Academic effort": ["Big improvement in the last CAT.", "Handed in extra practice work.", "Asked thoughtful questions all lesson.", "Very neat and complete exercise book."],
  "Clean classroom duty": ["Classroom left spotless.", "Did the cleaning duty without being reminded."],
  "Sportsmanship": ["Encouraged the other team after the match.", "Played fairly and helped an injured opponent.", "Great team spirit on sports day."],
  "Late to class": ["Arrived after the bell from break.", "Late to the first lesson.", "Came in 15 minutes late after lunch."],
  "Incomplete homework": ["Homework not handed in.", "Only half of the homework done.", "Forgot the homework book at home."],
  "Uniform not proper": ["No tie.", "Wrong shoes.", "Shirt not tucked in after a reminder."],
  "Disrupting class": ["Talking while the teacher was explaining.", "Kept distracting the learners nearby.", "Playing with a phone in class."],
  "Disrespect": ["Answered the teacher rudely.", "Refused to follow an instruction.", "Rude to the prefect on duty."],
  "Vandalism": ["Wrote on the desk.", "Damaged a library book."],
  "Fighting": ["Fight with another learner at break.", "Pushing and fighting in the dining hall."],
  "Bullying": ["Repeatedly taking a younger learner's snacks.", "Name-calling a classmate over several days."],
  "Exam malpractice": ["Notes found during the CAT.", "Copying from a neighbour in the exam."],
};
const STAFF_NOTES = ["Spoke to the learner; they were remorseful.", "Witnesses confirm the account.", "Mother called; she will talk to them at home.", "Follow up with the counsellor next week."];
const ACTIONS = ["warning", "detention", "parent_called", "parent_meeting", "suspension", "counsellor"] as const;

interface Term { id: string; index: number; starts_on: string; ends_on: string }
interface Learner { id: string; full_name: string; class_id: string | null; profile_id: string | null }

async function main() {
  const t0 = Date.now();
  console.log(`${DRY ? "DRY RUN (nothing is written): " : ""}Kijani Ridge Academy, the 2026 behaviour log. ${LOCAL ? "Local" : `REMOTE ${HOST}`}, today ${TODAY}.`);

  const { data: tenant, error: tErr } = await db.from("tenants").select("id, name, slug").eq("slug", SLUG).maybeSingle();
  if (tErr) throw new Error(`tenants: ${tErr.message}`);
  if (!tenant) throw new Error(`No school with slug ${SLUG} here. Run seed-cbe.ts and seed-kijani-full.ts first.`);
  if (process.env.EXPECT_TENANT_ID && tenant.id !== process.env.EXPECT_TENANT_ID) {
    throw new Error(`${SLUG} is ${tenant.id}, not EXPECT_TENANT_ID ${process.env.EXPECT_TENANT_ID}; refusing.`);
  }
  TENANT = tenant.id;
  const T = TENANT;
  console.log(`  school: ${tenant.name} (${T})`);
  {
    const { error } = await db.from("behaviour_entries").select("id").limit(1);
    if (error) throw new Error(`behaviour_entries is not there (${error.message}): apply 20261124400000_behaviour_log first.`);
  }

  // ---------------------------------------------------------------- settings
  const { data: existingSettings, error: sErr } = await db.from("behaviour_settings").select("tenant_id").eq("tenant_id", T).maybeSingle();
  if (sErr) throw new Error(`behaviour_settings: ${sErr.message}`);
  if (!existingSettings) {
    stat("behaviour_settings", 1, 1);
    if (!DRY) {
      const { error } = await db.from("behaviour_settings").insert({
        tenant_id: T, points_enabled: true, mode: "both", reset: "term", starting_points: 100, max_points_per_entry: 10,
        thresholds: [{ points: -15, label: "Parent meeting" }, { points: 30, label: "Certificate" }],
        parents_see_demerits: true, parents_see_incidents: false,
      });
      if (error) throw new Error(`behaviour_settings: ${error.message}`);
    }
  } else {
    stat("behaviour_settings", 1, 0);
    console.log("  settings: the school already has its own; left as they are");
  }

  // ---------------------------------------------------------------- categories (the school's own, plus the suggested ones it lacks)
  const haveCats = await all<{ id: string; kind: string; name: string }>("behaviour_categories", (a, b) =>
    db.from("behaviour_categories").select("id, kind, name").eq("tenant_id", T).order("id").range(a, b));
  const catKey = (kind: string, name: string) => `${kind}:${name.trim().toLowerCase()}`;
  const catId = new Map(haveCats.map((c) => [catKey(c.kind, c.name), c.id]));
  const newCats = DEFAULT_CATEGORIES.filter((c) => !catId.has(catKey(c.kind, c.name)))
    .map((c) => ({ id: uid(`cat:${c.kind}:${c.name}`), tenant_id: T, kind: c.kind, name: c.name, points: c.points, severity: c.severity, sort_order: c.ord }));
  for (const c of newCats) catId.set(catKey(c.kind, c.name), c.id);
  await insertMissing("behaviour_categories", newCats);
  const cat = (name: string) => {
    const d = DEFAULT_CATEGORIES.find((c) => c.name === name)!;
    return { id: catId.get(catKey(d.kind, d.name))!, ...d };
  };

  // ---------------------------------------------------------------- the school
  const terms = await all<Term>("terms", (a, b) => db.from("terms").select("id, index, starts_on, ends_on").eq("tenant_id", T).eq("year", 2026).order("index").range(a, b));
  const started = terms.filter((t) => t.starts_on <= TODAY);
  if (!started.length) throw new Error("No 2026 term has started at Kijani Ridge; nothing to seed.");
  const learners = await all<Learner>("students", (a, b) => db.from("students").select("id, full_name, class_id, profile_id")
    .eq("tenant_id", T).is("archived_at", null).not("class_id", "is", null).order("id").range(a, b));
  const classes = await all<{ id: string; name: string; class_teacher_id: string | null }>("classes", (a, b) =>
    db.from("classes").select("id, name, class_teacher_id").eq("tenant_id", T).order("name").range(a, b));
  const assignments = await all<{ teacher_id: string; class_id: string }>("teaching_assignments", (a, b) =>
    db.from("teaching_assignments").select("teacher_id, class_id").eq("tenant_id", T).order("id").range(a, b));
  const teachersOf = new Map<string, string[]>();
  for (const c of classes) teachersOf.set(c.id, c.class_teacher_id ? [c.class_teacher_id] : []);
  for (const a of assignments) {
    const list = teachersOf.get(a.class_id) ?? [];
    if (!list.includes(a.teacher_id)) list.push(a.teacher_id);
    teachersOf.set(a.class_id, list);
  }
  const { data: showProfile } = await db.from("profiles").select("id").eq("tenant_id", T).eq("login_id", "ST-2001").maybeSingle();
  const showcase = learners.find((l) => showProfile && l.profile_id === (showProfile as { id: string }).id)?.id ?? null;
  console.log(`  plan: ${learners.length} learners in ${classes.length} classes, ${started.length} term(s) started, showcase learner ${showcase ? "found" : "not found"}`);

  const schoolDays = (t: Term) => {
    const out: string[] = [];
    const last = t.ends_on < TODAY ? t.ends_on : TODAY;
    for (let d = t.starts_on; d <= last; d = addDays(d, 1)) if (dow(d) !== 0 && dow(d) !== 6) out.push(d);
    return out;
  };
  const current = started.find((t) => t.starts_on <= TODAY && TODAY <= t.ends_on) ?? started[started.length - 1]!;

  const entries: Row[] = [];
  const staffNotes: Row[] = [];
  const recorderFor = (l: Learner, ...k: (string | number)[]) => {
    const list = teachersOf.get(l.class_id!) ?? [];
    return list.length ? pickH(list, "rec", l.id, ...k) : null;
  };
  const add = (id: string, l: Learner, name: string, day: string, recorder: string | null, extra: Row = {}) => {
    const c = cat(name);
    entries.push({
      id, tenant_id: T, student_id: l.id, category_id: c.id, kind: c.kind, points: c.kind === "merit" ? c.points : -c.points,
      note: pickH(NOTES[name]!, "note", id), occurred_on: day, class_id: l.class_id, recorded_by: recorder,
      created_at: at(day, `${String(8 + Math.floor(hr("h", id) * 8)).padStart(2, "0")}:${String(Math.floor(hr("m", id) * 60)).padStart(2, "0")}`),
      ...extra,
    });
  };

  // the two learners over the parent-meeting threshold this term (not the showcase learner, in two different classes)
  const pool = learners.filter((l) => l.id !== showcase).sort((a, b) => hr("over", a.id) - hr("over", b.id));
  const over: Learner[] = [];
  for (const l of pool) { if (over.length < 2 && !over.some((o) => o.class_id === l.class_id)) over.push(l); }
  const overIds = new Set(over.map((l) => l.id));
  // ~20 serious incidents, all in finished terms or early this term, on other learners
  // (in Grade 4 and up: no fights or exam malpractice for the little ones)
  const gradeOf = new Map(classes.map((c) => [c.id, Number(/^Grade (\d+)/.exec(c.name)?.[1] ?? 0)]));
  const serious = pool.filter((l) => !overIds.has(l.id) && (gradeOf.get(l.class_id!) ?? 0) >= 4).slice(2, 22);

  // ---------------------------------------------------------------- everyday entries
  const merits = DEFAULT_CATEGORIES.filter((c) => c.kind === "merit" && c.name !== "Clean classroom duty").map((c) => c.name);
  const minor = ["Late to class", "Late to class", "Incomplete homework", "Incomplete homework", "Uniform not proper", "Disrupting class", "Disrespect"];
  for (const t of started) {
    const days = schoolDays(t);
    if (!days.length) continue;
    // the term under way gets entries in step with how much of it has passed
    let weekdays = 0;
    for (let d = t.starts_on; d <= t.ends_on; d = addDays(d, 1)) if (dow(d) !== 0 && dow(d) !== 6) weekdays++;
    const share = Math.min(1, days.length / Math.max(1, weekdays));
    for (const l of learners) {
      const n = Math.max(1, Math.round((6 + Math.floor(hr("n", l.id, t.index) * 5)) * share));
      const merit = l.id === showcase ? n : Math.round(n * (0.62 + hr("mix", l.id) * 0.2));
      for (let i = 0; i < n; i++) {
        const day = pickH(days, "day", l.id, t.index, i);
        const name = i < merit ? pickH(merits, "m", l.id, t.index, i) : pickH(minor, "d", l.id, t.index, i);
        add(uid(`e:${l.id}:${t.index}:${i}`), l, name, day, recorderFor(l, t.index, i));
      }
    }
  }

  // keep everyone but the two chosen learners above -15 this term (a demerit too many is simply dropped)
  const curDemerits = new Map<string, number>();
  const kept: Row[] = [];
  for (const e of entries.sort((a, b) => String(a.occurred_on).localeCompare(String(b.occurred_on)))) {
    const inCurrent = (e.occurred_on as string) >= current.starts_on;
    if (inCurrent && (e.points as number) < 0) {
      const sum = (curDemerits.get(e.student_id as string) ?? 0) + (e.points as number);
      if (sum <= -9) continue;   // leave room for one serious incident (-5) and stay well above -15
      curDemerits.set(e.student_id as string, sum);
    }
    kept.push(e);
  }
  entries.length = 0;
  entries.push(...kept);

  // ---------------------------------------------------------------- class merits
  const classMeritClasses = [...classes].sort((a, b) => hr("cm", a.id) - hr("cm", b.id)).slice(0, 5);
  for (const t of started) {
    const days = schoolDays(t);
    if (!days.length) continue;
    for (const c of classMeritClasses) {
      const day = pickH(days, "cmday", c.id, t.index);
      for (const l of learners.filter((x) => x.class_id === c.id)) {
        add(uid(`cm:${c.id}:${t.index}:${l.id}`), l, "Clean classroom duty", day, c.class_teacher_id ?? recorderFor(l, "cm", t.index),
          { note: "Class merit: the cleanest classroom on the inspection." });
      }
    }
  }

  // ---------------------------------------------------------------- serious incidents
  const seriousNames = ["Fighting", "Fighting", "Fighting", "Bullying", "Exam malpractice"];
  serious.forEach((l, i) => {
    // the first 16 in finished terms (resolved), the last 4 this term (the first 2 of those still open)
    const finished = started.filter((t) => t.id !== current.id);
    const thisTerm = i >= 16 || !finished.length;
    const t = thisTerm ? current : pickH(finished, "st", l.id);
    const days = schoolDays(t);
    if (!days.length) return;
    const name = thisTerm ? "Fighting" : pickH(seriousNames, "sn", l.id);
    const day = pickH(days, "sday", l.id);
    const open = thisTerm && i < 18;
    const action = pickH(ACTIONS, "act", l.id);
    const id = uid(`s:${l.id}`);
    add(id, l, name, day, recorderFor(l, "s"), {
      follow_up_status: open ? "open" : "resolved",
      action_taken: open ? (i === 16 ? "parent_called" : null) : action,
      resolved_at: open ? null : at(addDays(day, 2 + Math.floor(hr("rd", l.id) * 5)), "15:00"),
      parent_notified_at: action === "parent_called" || action === "parent_meeting" || action === "suspension" || (open && i === 16) ? at(addDays(day, 1), "11:00") : null,
    });
    staffNotes.push({ entry_id: id, tenant_id: T, note: pickH(STAFF_NOTES, "sn2", l.id), created_at: at(day, "17:00") });
  });

  // ---------------------------------------------------------------- the two learners over the threshold this term
  const curDays = schoolDays(current);
  for (const l of over) {
    const plan = ["Disrespect", "Disrespect", "Disrupting class", "Disrupting class", "Late to class", "Late to class", "Incomplete homework", "Uniform not proper", "Late to class"];
    plan.forEach((name, i) => add(uid(`over:${l.id}:${i}`), l, name, curDays[Math.min(curDays.length - 1, Math.floor((i + 1) * curDays.length / (plan.length + 1)))]!, recorderFor(l, "over", i)));
  }
  // staff notes on a few everyday demerits too (teachers' private context)
  for (const e of entries.filter((x) => (x.points as number) < 0 && hr("snote", x.id as string) < 0.04)) {
    if (staffNotes.some((n) => n.entry_id === e.id)) continue;
    staffNotes.push({ entry_id: e.id, tenant_id: T, note: pickH(STAFF_NOTES, "sn3", e.id as string), created_at: e.created_at });
  }

  // ---------------------------------------------------------------- writes
  console.log(`  plan: ${entries.length} entries (${entries.filter((e) => (e.points as number) > 0).length} merits), ${serious.length} serious incidents, ${staffNotes.length} staff notes`);
  await insertMissing("behaviour_entries", entries);
  await insertMissing("behaviour_staff_notes", staffNotes, "entry_id");

  // ---------------------------------------------------------------- report
  console.log(`\n${DRY ? "Would add" : "Added"} (planned / new):`);
  for (const [table, s] of STATS) console.log(`  ${table.padEnd(24)} ${String(s.planned).padStart(7)} / ${String(s.added).padStart(7)}`);
  console.log(`  over the parent-meeting threshold this term: ${over.map((l) => l.full_name).join(", ")}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
