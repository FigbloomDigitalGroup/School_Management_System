/**
 * Grows the Kijani Ridge Academy demo school (made by seed-cbe.ts) into a full, living school for 2026:
 * PP1-Grade 12 in two streams (28 classes, ~1,000 learners), ~1,450 parents and guardians, ~55 teachers,
 * ~20 support staff, clash-free timetables, a fee structure per band with three terms of invoices,
 * payments, transport and uniform charges, CATs / mid-term / end-term exams with marks, CBE rubric
 * assessments, a year of registers, inventory (textbooks, stationery, uniforms, kitchen), clubs and
 * a year of announcements. If inventory_movements exists (stock in/out), also a year of kitchen and
 * stationery deliveries and daily use, with the demo anomalies the stock flags look for.
 *
 *   npm run db:seed-kijani-full -- --dry-run     # counts only, writes nothing
 *   npm run db:seed-kijani-full
 *
 * KEEP AND EXTEND. Everything seed-cbe.ts made (Grace, Daniel, Lucy and her children, the buses, the
 * five classes, their learners and records) stays. Every row this script writes has a deterministic
 * id (or a natural key) and is only inserted when missing, so running it again changes nothing.
 * Two deliberate changes to seed-cbe's rows, both idempotent: Term 3's five school-wide fee items are
 * replaced by the per-band structure (and the invoices billed from them re-totalled, with a top-up
 * payment where a family had paid in full), and each class/subject's teacher and the timetables are
 * set to the new staffing (teaching_assignments / timetable_slots are upserted on their natural keys).
 *
 * SAFETY (production holds this school):
 *   - Writes only rows of the tenant with slug kijani-ridge (EXPECT_TENANT_ID pins its id too).
 *     Refuses a non-local SUPABASE_URL unless ALLOW_REMOTE_SEED=1.
 *   - Every email is @kijaniridge-demo.invalid (RFC 2606); sign-in addresses are the synthetic
 *     login-ID kind (@login.kijani-ridge.figbloom.internal). Every phone is +254 000 NNN NNN: a
 *     Kenyan number can't start with 0 after the country code, so none can reach a person.
 *   - Sends nothing: no edge function is called (push, SMS, email and visit/medical notifications are
 *     all sent by edge functions the apps call after a write, never by a database trigger), auth users
 *     are created confirmed with the admin API (no invitation or confirmation email), announcements
 *     go out in_app only. The only outbound effect is the one asked for: new staff profiles queue
 *     schools.staff.created events for Figbloom HR (when PLATFORM_STAFF_EVENTS_ENABLED is on and the
 *     school is linked), which HR turns into DRAFT employees. Their .invalid emails are sent as null.
 *   - Only six new showcase accounts can sign in, all with one shared password (SEED_PASSWORD, or a
 *     random one generated on the first run). It is never printed: it is written, with the logins, to
 *     LOGINS_FILE (default ~/kijani-ridge-demo-logins.txt). Everyone else gets a random password that
 *     is thrown away. Existing accounts keep their passwords. RESET_SHOWCASE_PASSWORDS=1 sets the
 *     shared password on the showcase accounts again (with SEED_PASSWORD, or a new random one).
 *   - A staff manifest for the HR seeder (person ids, names, roles, emails, phones, fake TSC numbers)
 *     is written next to the logins file (STAFF_MANIFEST, default ~/kijani-ridge-staff-manifest.json).
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loginIdEmail } from "../packages/shared/src/auth";

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
const DOMAIN = "kijaniridge-demo.invalid";
const LOGINS_FILE = process.env.LOGINS_FILE ?? join(homedir(), "kijani-ridge-demo-logins.txt");
const STAFF_MANIFEST = process.env.STAFF_MANIFEST ?? join(homedir(), "kijani-ridge-staff-manifest.json");
// "today" in Nairobi; SEED_TODAY=YYYY-MM-DD pins it (tests)
const TODAY = process.env.SEED_TODAY ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const YESTERDAY = addDays(TODAY, -1);
const NOW_ISO = new Date().toISOString();

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- small helpers
type Row = Record<string, unknown>;
let TENANT = "";
/** A stable uuid for this school and key: the same row gets the same id on every run. */
function uid(k: string): string {
  const h = createHash("sha1").update(`kijani-full:${TENANT}:${k}`).digest();
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
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();   // 0 Sunday
const at = (d: string, hm: string) => new Date(`${d}T${hm}:00+03:00`).toISOString();
const hm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const kes = (shillings: number) => Math.round(shillings) * 100;   // cents, whole shillings

function ok<T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (r.error || r.data == null) throw new Error(`${what}: ${r.error?.message ?? "no data"}`);
  return r.data as NonNullable<T>;
}

/** Every row of a query, a page at a time (PostgREST returns at most 1,000 per request). */
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

/** Inserts the rows (each with a deterministic id) that aren't there yet. Returns the new ones. */
async function insertMissing(table: string, rows: Row[], size = 500): Promise<Row[]> {
  if (!rows.length) return [];
  const have = new Set<string>();
  for (const ids of chunks(rows.map((r) => r.id as string), 150)) {
    const { data, error } = await db.from(table).select("id").in("id", ids);
    if (error) throw new Error(`${table} (existing ids): ${error.message}`);
    for (const r of data ?? []) have.add((r as { id: string }).id);
  }
  const fresh = rows.filter((r) => !have.has(r.id as string));
  stat(table, rows.length, fresh.length);
  if (DRY) return fresh;
  for (const part of chunks(fresh, size)) {
    const { error } = await db.from(table).insert(part, { defaultToNull: false });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return fresh;
}

/** Inserts on a natural key, skipping rows already there (INSERT ... ON CONFLICT DO NOTHING). */
async function insertIgnore(table: string, rows: Row[], onConflict: string, size = 1000) {
  stat(table, rows.length, 0);
  if (DRY || !rows.length) return;
  let i = 0;
  for (const part of chunks(rows, size)) {
    const { error } = await db.from(table).upsert(part, { onConflict, ignoreDuplicates: true, defaultToNull: false });
    if (error) throw new Error(`${table}: ${error.message}`);
    if (rows.length > 20_000 && ++i % 20 === 0) console.log(`    ${table}: ${Math.min(i * size, rows.length)}/${rows.length}`);
  }
}

/** Inserts or overwrites on a natural key (teaching assignments, timetable slots). */
async function upsertOn(table: string, rows: Row[], onConflict: string) {
  stat(table, rows.length, 0);
  if (DRY || !rows.length) return;
  for (const part of chunks(rows, 500)) {
    const { error } = await db.from(table).upsert(part, { onConflict, defaultToNull: false });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

// ---------------------------------------------------------------- names
const F_FIRST = ["Faith", "Grace", "Mercy", "Joy", "Esther", "Naomi", "Ruth", "Sharon", "Cynthia", "Purity", "Winnie", "Beatrice",
  "Caroline", "Lucy", "Ann", "Mary", "Jane", "Rose", "Diana", "Gladys", "Irene", "Lilian", "Margaret", "Nancy", "Phyllis", "Susan",
  "Tabitha", "Valentine", "Abigail", "Brenda", "Charity", "Doreen", "Eunice", "Hellen", "Joyce", "Lydia", "Maureen", "Pauline",
  "Rachel", "Sylvia", "Tracy", "Wendy", "Yvonne", "Amina", "Fatuma", "Halima", "Zawadi", "Neema", "Imani", "Achieng", "Akinyi",
  "Atieno", "Wanjiru", "Wambui", "Njeri", "Nyambura", "Wairimu", "Muthoni", "Wanjiku", "Chebet", "Chepkoech", "Jepchirchir",
  "Nafula", "Nekesa", "Naliaka", "Kemunto", "Moraa", "Kwamboka", "Mwende", "Mumbua", "Ndanu", "Makena", "Kendi", "Nkatha",
  "Shiro", "Wangari", "Adhiambo", "Awino", "Jebet", "Cherono", "Kagendo", "Precious", "Blessing", "Gift", "Hope", "Patience"];
const M_FIRST = ["Brian", "Kevin", "Dennis", "Victor", "Collins", "Felix", "Alex", "Peter", "Michael", "Emmanuel", "Isaac", "Timothy",
  "George", "Samuel", "John", "James", "Joseph", "David", "Stephen", "Paul", "Mark", "Moses", "Eric", "Edwin", "Kelvin", "Ian",
  "Ryan", "Allan", "Caleb", "Elijah", "Francis", "Geoffrey", "Henry", "Joel", "Kennedy", "Lawrence", "Martin", "Nicholas", "Oscar",
  "Patrick", "Robert", "Simon", "Tony", "Vincent", "Wilson", "Hassan", "Omar", "Juma", "Baraka", "Jabari", "Amani", "Kamau",
  "Kiprono", "Kipchumba", "Kibet", "Cheruiyot", "Otieno", "Odhiambo", "Ochieng", "Wekesa", "Wafula", "Mutua", "Musyoka", "Kioko",
  "Mwangi", "Njoroge", "Gitau", "Mugo", "Nyaga", "Murimi", "Mwiti", "Kirimi", "Barack", "Austin", "Brandon", "Derrick", "Elvis",
  "Fidel", "Gideon", "Hillary", "Ivan", "Jesse", "Kipkemoi", "Liam", "Nathan", "Abdi", "Salim"];
const SURNAMES = ["Kamau", "Mwangi", "Njoroge", "Kariuki", "Kimani", "Ngugi", "Gitau", "Macharia", "Waweru", "Mugo", "Ndungu",
  "Wainaina", "Githinji", "Muriuki", "Kinyua", "Maina", "Njenga", "Gichuki", "Otieno", "Odhiambo", "Onyango", "Ochieng", "Omondi",
  "Owino", "Okoth", "Ouma", "Oduor", "Okello", "Opiyo", "Wafula", "Wekesa", "Barasa", "Wanyama", "Simiyu", "Juma", "Makokha",
  "Shikuku", "Masinde", "Khaemba", "Kiprop", "Kiptoo", "Kirui", "Koech", "Rotich", "Langat", "Cheruiyot", "Kipkemboi", "Bett",
  "Sang", "Kosgei", "Mutua", "Musyoka", "Kioko", "Mutiso", "Muthama", "Ndolo", "Kilonzo", "Mwendwa", "Nyamweya", "Ondieki",
  "Ogeto", "Nyakundi", "Onsongo", "Mwiti", "Kirimi", "Murithi", "Gitonga", "Kinoti", "Mwamba", "Kazungu", "Karisa", "Baya",
  "Charo", "Hassan", "Abdi", "Lemayian", "Sankale", "Nyaga", "Mbugua", "Kahindi", "Wambua", "Ruto", "Chege", "Kagwe", "Mburu"];
const ESTATES = ["South B", "South C", "Imara Daima", "Lang'ata", "Madaraka", "Nairobi West", "Syokimau", "Embakasi", "Kileleshwa",
  "Nyayo Estate", "Fedha", "Mlolongo", "Industrial Area", "Hazina", "Kibera Drive", "Highrise", "Mugoya", "Golden Gate"];

// ---------------------------------------------------------------- the school's shape
type Level = "pre_primary" | "primary" | "junior_secondary" | "senior_school";
type Band = "PP1" | "PP2" | "LP" | "UP" | "JS" | "SS";
type Pathway = "stem" | "social_sciences" | "arts_sports";
const YEARS: { label: string; level: Level; year: number; band: Band; streams: [string, Pathway?][] }[] = [
  { label: "PP1", level: "pre_primary", year: 1, band: "PP1", streams: [["Daisy"], ["Lily"]] },
  { label: "PP2", level: "pre_primary", year: 2, band: "PP2", streams: [["Sunflower"], ["Tulip"]] },
  { label: "Grade 1", level: "primary", year: 1, band: "LP", streams: [["Jacaranda"], ["Mvule"]] },
  { label: "Grade 2", level: "primary", year: 2, band: "LP", streams: [["Mugumo"], ["Nandi Flame"]] },
  { label: "Grade 3", level: "primary", year: 3, band: "LP", streams: [["Acacia"], ["Neem"]] },
  { label: "Grade 4", level: "primary", year: 4, band: "UP", streams: [["Olive"], ["Podo"]] },
  { label: "Grade 5", level: "primary", year: 5, band: "UP", streams: [["Baobab"], ["Mango"]] },
  { label: "Grade 6", level: "primary", year: 6, band: "UP", streams: [["Croton"], ["Camphor"]] },
  { label: "Grade 7", level: "junior_secondary", year: 7, band: "JS", streams: [["Cypress"], ["Mahogany"]] },
  { label: "Grade 8", level: "junior_secondary", year: 8, band: "JS", streams: [["Cedar"], ["Meru Oak"]] },
  { label: "Grade 9", level: "junior_secondary", year: 9, band: "JS", streams: [["Elgon Teak"], ["Muhugu"]] },
  { label: "Grade 10", level: "senior_school", year: 10, band: "SS", streams: [["Fig", "stem"], ["Palm", "social_sciences"]] },
  { label: "Grade 11", level: "senior_school", year: 11, band: "SS", streams: [["Bamboo", "stem"], ["Coconut", "arts_sports"]] },
  { label: "Grade 12", level: "senior_school", year: 12, band: "SS", streams: [["Eucalyptus", "stem"], ["Wattle", "social_sciences"]] },
];

/** KICD learning areas per class (codes from the catalogue the migrations seed) and lessons a week. */
const AREAS: Record<Band, [string, number][]> = {
  PP1: [["PP-LANG", 7], ["PP-MATH", 7], ["PP-ENV", 6], ["PP-PCA", 6], ["PP-RE", 4]],
  PP2: [["PP-LANG", 7], ["PP-MATH", 7], ["PP-ENV", 6], ["PP-PCA", 6], ["PP-RE", 4]],
  LP: [["LP-ENG", 6], ["LP-KIS", 5], ["LP-MATH", 7], ["LP-ENV", 5], ["LP-RE", 3], ["LP-CRA", 6]],
  UP: [["UP-ENG", 5], ["UP-KIS", 4], ["UP-MATH", 5], ["UP-RE", 3], ["UP-SCT", 4], ["UP-AGN", 4], ["UP-SST", 3], ["UP-CRA", 5]],
  JS: [["JS-ENG", 5], ["JS-KIS", 4], ["JS-MATH", 5], ["JS-RE", 3], ["JS-SST", 4], ["JS-ISC", 5], ["JS-PTS", 4], ["JS-AGN", 4], ["JS-CAS", 4]],
  SS: [["SS-ENG", 5], ["SS-KIS", 4], ["SS-MATH", 5], ["SS-CSL", 2], ["SS-PE", 2]],
};
const ELECTIVES: Record<Pathway, string[]> = {
  stem: ["SS-BIO", "SS-CHEM", "SS-PHY", "SS-COMP"],
  social_sciences: ["SS-HIS", "SS-GEO", "SS-CRE", "SS-BST"],
  arts_sports: ["SS-SPR", "SS-MUS", "SS-FIA", "SS-THF"],
};
/** Subject teachers come in departments; each department's lessons are shared out between its teachers. */
const DEPARTMENTS: { name: string; codes: string[] }[] = [
  { name: "Mathematics", codes: ["JS-MATH", "UP-MATH", "SS-MATH"] },       // JS first: Daniel (TC-0001) keeps Grade 8 Cedar
  { name: "English", codes: ["UP-ENG", "JS-ENG", "SS-ENG"] },
  { name: "Kiswahili", codes: ["LP-KIS", "UP-KIS", "JS-KIS", "SS-KIS"] },
  { name: "Sciences", codes: ["UP-SCT", "JS-ISC", "SS-BIO", "SS-CHEM", "SS-PHY"] },
  { name: "Humanities", codes: ["UP-SST", "JS-SST", "SS-HIS", "SS-GEO", "SS-BST", "SS-CSL"] },
  { name: "Religious Education", codes: ["UP-RE", "JS-RE", "SS-CRE"] },
  { name: "Agriculture and Nutrition", codes: ["UP-AGN", "JS-AGN"] },
  { name: "Creative Arts and Sports", codes: ["UP-CRA", "JS-CAS", "SS-PE", "SS-SPR", "SS-MUS", "SS-FIA", "SS-THF"] },
  { name: "Technical Studies", codes: ["JS-PTS", "SS-COMP"] },
];
const TEACHER_LOAD = 17;   // lessons a week a subject teacher is planned around

// the school day: 8 lessons, break 10:00-10:20, lunch 12:20-14:00, games/clubs at 15:20
const PERIODS = ["08:00", "08:40", "09:20", "10:20", "11:00", "11:40", "14:00", "14:40"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const FILLERS: Record<Band, string[]> = {
  PP1: [], PP2: [],
  LP: ["Reading time", "Physical activities", "Reading time", "Pastoral programme", "Physical activities", "Library", "Reading time", "Physical activities"],
  UP: ["Physical Education", "Library", "Pastoral programme", "Physical Education", "Library", "Physical Education", "Private study"],
  JS: ["Pastoral programme", "Library", "Private study"],
  SS: ["Pastoral programme", "Private study", "Library"],
};
const ROOM_FOR: Record<string, string> = {
  "JS-ISC": "Junior science lab", "SS-BIO": "Biology lab", "SS-CHEM": "Chemistry lab", "SS-PHY": "Physics lab",
  "SS-COMP": "Computer lab", "JS-PTS": "Pre-technical workshop", "SS-PE": "Field", "SS-SPR": "Field", "SS-MUS": "Music room",
  "SS-FIA": "Art room", "SS-THF": "School hall", "UP-AGN": "School garden", "JS-AGN": "School garden",
};

// ---------------------------------------------------------------- calendar 2026
const HOLIDAYS = new Set(["2026-01-01", "2026-03-20", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-27", "2026-06-01", "2026-10-20", "2026-12-12"]);
const HALF_TERMS: [string, string][] = [["2026-02-25", "2026-02-27"], ["2026-06-24", "2026-06-26"], ["2026-10-21", "2026-10-23"]];
const isSchoolDay = (d: string) => dow(d) !== 0 && dow(d) !== 6 && !HOLIDAYS.has(d) && !HALF_TERMS.some(([a, b]) => d >= a && d <= b);
type Term = { id: string; name: string; index: number; starts_on: string; ends_on: string; is_current: boolean };
function termDays(t: Term, until: string, filter = isSchoolDay): string[] {
  const out: string[] = [];
  for (let d = t.starts_on; d <= t.ends_on && d <= until; d = addDays(d, 1)) if (filter(d)) out.push(d);
  return out;
}
const TERM_DEFAULTS: Record<number, [string, string]> = { 1: ["2026-01-05", "2026-03-27"], 2: ["2026-05-04", "2026-07-31"], 3: ["2026-08-31", "2026-11-27"] };
const FEE_DUE: Record<number, string> = { 1: "2026-01-23", 2: "2026-05-22", 3: "2026-09-18" };
// exam weeks: [CAT, mid-term, end-term] start dates per term (Monday), written over three days
const EXAM_WEEKS: Record<number, [string, string, string]> = {
  1: ["2026-01-27", "2026-02-18", "2026-03-16"],
  2: ["2026-05-26", "2026-06-16", "2026-07-20"],
  3: ["2026-09-22", "2026-10-13", "2026-11-16"],
};

// ---------------------------------------------------------------- fees (KES per term)
const FEES: Record<Band, [string, number][]> = {
  PP1: [["Tuition", 17_500], ["Meals (snack and lunch)", 6_000], ["Learning materials", 1_500], ["Music and movement", 1_200], ["Swimming", 1_800]],
  PP2: [["Tuition", 18_500], ["Meals (snack and lunch)", 6_000], ["Learning materials", 1_800], ["Music and movement", 1_200], ["Swimming", 1_800]],
  LP: [["Tuition", 21_000], ["Lunch programme", 7_500], ["ICT and class tablets", 1_500], ["Swimming", 1_800], ["Chess club", 1_000]],
  UP: [["Tuition", 24_000], ["Lunch programme", 7_500], ["ICT and class tablets", 1_500], ["Science and technology materials", 1_000], ["Scouts and Girl Guides", 1_200], ["Music (instrument lessons)", 1_500]],
  JS: [["Tuition", 28_000], ["Lunch programme", 8_000], ["ICT", 1_500], ["Integrated science lab", 1_500], ["Robotics club", 2_500], ["Drama club", 1_200], ["Football", 1_000]],
  SS: [["Tuition", 32_000], ["Lunch programme", 8_500], ["Laboratory and pathway materials", 2_500], ["Rugby", 1_800], ["Coding club", 2_000], ["Debate club", 800]],
};
const BOARDING_FEE: [string, number] = ["Boarding (accommodation, breakfast and supper)", 24_000];
// seed-cbe.ts's school-wide Term 3 items, replaced by the per-band structure
const OLD_ITEMS = ["Tuition", "Lunch programme", "Boarding and meals", "Activity and clubs", "ICT and digital learning"];
const transportFee = (route: string) => (/lang'ata/i.test(route) ? 7_500 : 9_000);

// ---------------------------------------------------------------- staff
type SupportSpec = { key: string; title: string; areas?: string[]; visitors?: boolean; match: RegExp; showcase?: string; alt?: string };
const SUPPORT: SupportSpec[] = [
  { key: "bursar", title: "Bursar", areas: ["fees"], match: /bursar/i, showcase: "bursar", alt: "Accounts clerk" },
  { key: "accounts", title: "Accounts clerk", areas: ["fees"], match: /accounts? (clerk|assistant)/i },
  { key: "store", title: "Storekeeper", areas: ["inventory"], match: /store ?keeper/i, showcase: "storekeeper", alt: "Assistant storekeeper" },
  { key: "headcook", title: "Head cook", match: /head cook|catering/i },
  { key: "cook1", title: "Cook", match: /^cook$/i },
  { key: "cook2", title: "Cook", match: /^cook$/i },
  { key: "cook3", title: "Cook", match: /^cook$/i },
  { key: "matron", title: "Matron", areas: ["medical"], match: /matron/i },
  { key: "secretary", title: "School secretary", areas: ["communication"], match: /secretary/i },
  { key: "reception", title: "Receptionist", areas: ["visitors"], visitors: true, match: /reception/i },
  { key: "librarian", title: "Librarian", match: /librar/i },
  { key: "nurse", title: "School nurse", areas: ["medical"], match: /nurse/i },
  { key: "labtech", title: "Laboratory technician", match: /lab(oratory)? tech/i },
  { key: "ict", title: "ICT technician", match: /\bict\b/i },
  { key: "guard1", title: "Security guard", areas: ["visitors"], visitors: true, match: /guard|security/i },
  { key: "guard2", title: "Security guard", areas: ["visitors"], visitors: true, match: /guard|security/i },
  { key: "cleaner1", title: "Cleaner", match: /cleaner/i },
  { key: "cleaner2", title: "Cleaner", match: /cleaner/i },
  { key: "cleaner3", title: "Cleaner", match: /cleaner/i },
  { key: "cleaner4", title: "Cleaner", match: /cleaner/i },
  { key: "grounds", title: "Groundsman", match: /grounds/i },
];

type Person = {
  id: string; login_id: string; role: "teacher" | "staff" | "parent" | "student"; full_name: string;
  email: string | null; phone: string | null; staff_title?: string | null; handles_visitors?: boolean;
  showcase?: string; areas?: string[]; gender?: "male" | "female"; tsc?: string; joined?: string;
};

function personName(gender: "male" | "female", surname: string, ...k: (string | number)[]) {
  const first = pickH(gender === "female" ? F_FIRST : M_FIRST, "first", ...k);
  return first === surname ? `${pickH(gender === "female" ? F_FIRST : M_FIRST, "first2", ...k)} ${surname}` : `${first} ${surname}`;
}
const emails = new Set<string>();
function emailFor(fullName: string): string {
  const base = fullName.toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".");
  let e = `${base}@${DOMAIN}`;
  for (let n = 2; emails.has(e); n++) e = `${base}${n}@${DOMAIN}`;
  emails.add(e);
  return e;
}
/** +254 000 NNN NNN: shaped like a Kenyan mobile, but no Kenyan number starts with 0 after 254. */
const fakePhone = (n: number) => `+254000${String(n).padStart(6, "0")}`;

// ---------------------------------------------------------------- the learner model
/** How strong a learner is (0-1), steady across the year, with a few at each end. */
const ability = (sid: string) => clamp(((hr("ab1", sid) + hr("ab2", sid)) / 2 - 0.5) * 1.5 + 0.5, 0.02, 0.98);
const oftenAbsent = (sid: string) => hr("often-absent", sid) < 0.05;
/** A score out of 100 for a learner in a subject in an assessment. */
function score(sid: string, code: string, termIdx: number, kind: string): number {
  const a = ability(sid);
  const affinity = (hr("aff", sid, code) - 0.5) * 22;
  const trend = (hr("trend", sid) - 0.5) * 7 * (termIdx - 2);
  const difficulty = (hr("diff", code, termIdx, kind) - 0.5) * 10 + (kind === "End-term exam" ? -3 : kind === "CAT" ? 3 : 0);
  const noise = (hr("noise", sid, code, termIdx, kind) - 0.5) * 14;
  return Math.round(clamp(26 + 66 * a + affinity + trend + difficulty + noise, 3, 99));
}
const RUBRIC4: [number, string][] = [[75, "EE"], [50, "ME"], [30, "AE"], [0, "BE"]];
const RUBRIC8: [number, string][] = [[90, "EE1"], [75, "EE2"], [62, "ME1"], [50, "ME2"], [40, "AE1"], [30, "AE2"], [20, "BE1"], [0, "BE2"]];
const level = (lvl: Level, s: number) => (lvl === "pre_primary" || lvl === "primary" ? RUBRIC4 : RUBRIC8).find(([min]) => s >= min)![1];

const STRAND_NAMES: Record<string, string[]> = {
  LANG: ["Listening and Speaking", "Reading", "Writing"], ENG: ["Listening and Speaking", "Reading", "Writing"],
  KIS: ["Kusikiliza na Kuzungumza", "Kusoma", "Kuandika"], MATH: ["Numbers", "Measurement", "Geometry"],
  "SS-MATH": ["Numbers and Algebra", "Geometry and Measurement", "Statistics and Probability"],
  ENV: ["Social Environment", "Natural Environment", "Health Practices"], PCA: ["Movement Activities", "Creative Activities", "Music and Rhythm"],
  RE: ["Creation", "Sacred Scriptures", "Moral Living"], CRA: ["Art and Craft", "Music", "Physical Education"],
  SCT: ["Living Things and Their Environment", "Matter", "Energy"], AGN: ["Conservation of Resources", "Food Production", "Nutrition and Hygiene"],
  SST: ["Natural and Built Environments", "People and Population", "Political Systems"],
  ISC: ["Scientific Investigation", "Living Things and Their Environment", "Force and Energy"],
  PTS: ["Foundations of Pre-Technical Studies", "Communication in Technical Fields", "Materials and Tools"],
  CAS: ["Creating and Executing", "Performing and Displaying", "Sports Skills"], CSL: ["Citizenship", "Community Projects", "Reflection"],
  PE: ["Fitness", "Games", "Athletics"], BIO: ["Cell Biology", "Human Physiology", "Ecology"],
  CHEM: ["Matter and its Structure", "Chemical Reactions", "Acids, Bases and Salts"], PHY: ["Measurement", "Mechanics", "Electricity"],
  COMP: ["Computer Systems", "Programming", "Data and Networks"], HIS: ["Early Civilisations", "Kenyan History", "Citizenship and Governance"],
  GEO: ["Physical Geography", "Human Geography", "Map Work"], CRE: ["Old Testament", "New Testament", "Christian Ethics"],
  BST: ["Business Environment", "Entrepreneurship", "Financial Records"], SPR: ["Athletics", "Ball Games", "Sports Management"],
  MUS: ["Performance", "Composition", "Music History"], FIA: ["Drawing", "Painting", "Sculpture"], THF: ["Acting", "Script Writing", "Film Production"],
};
const COMMENTS: Record<"high" | "mid" | "low", string[]> = {
  high: ["Consistently exceeds the expected competencies in %s and helps classmates. Keep challenging yourself.",
    "Excellent work in %s this term; applies learning confidently in new situations.",
    "A confident, curious learner in %s. Ready for more demanding tasks."],
  mid: ["Meets the expected competencies in %s and is growing in confidence. Keep practising.",
    "Good, steady progress in %s; participates well in group tasks.",
    "Works well in %s. More reading around the topics will lift the results further."],
  low: ["Is developing the expected competencies in %s and needs more practice and support at home.",
    "Shows effort in %s; revisit the strands marked below expectations with the teacher.",
    "Needs closer follow-up in %s. Attendance and homework completion will make the biggest difference."],
};

type Cls = { key: string; name: string; level: Level; year: number; band: Band; stream: string; pathway: Pathway | null;
  idx: number; yi: number; id: string; existing: boolean; classTeacher: string | null; codes: [string, number][] };
type Teacher = Person & { lessons: number; teaches: { cls: Cls; code: string; n: number }[]; dept?: string };
type Guardian = Person & { relationship: "mother" | "father" | "guardian"; primary: boolean };
type DbStudent = { id: string; full_name: string; class_id: string | null; admission_no: string; boarding: boolean; gender: string | null; active: boolean; profile_id: string | null };
type Slot = { key: string; cls: Cls; i: number; id: string; adm: string };
type Family = { key: string; surname: string; kids: Slot[]; foreignKids: DbStudent[]; payer: "A" | "B" | "C" | "D"; guardians: Guardian[] };
type Prof = { id: string; role: string; login_id: string | null; full_name: string; email: string | null; staff_title: string | null };

// ---------------------------------------------------------------- accounts
let SHOWCASE_PASSWORD: string | null = null;
const showcaseCreated: Person[] = [];
/**
 * An auth user (confirmed, no email sent) and a profile for every person not there yet. A login ID
 * someone else at the school already uses is reported and that person is left out (p.skip).
 */
async function ensureAccounts(what: string, people: (Person & { skip?: boolean })[], byLogin: Map<string, Prof>, profileIds: Set<string>) {
  const create: Person[] = [];
  for (const p of people) {
    const ex = byLogin.get(p.login_id.toUpperCase());
    if (ex && ex.id !== p.id) { p.skip = true; console.log(`  ${p.login_id} already belongs to ${ex.full_name}; ${p.full_name} left out`); continue; }
    if (!ex && !profileIds.has(p.id)) create.push(p);
  }
  stat(`profiles (${what})`, people.length, create.length);
  if (DRY || !create.length) return;
  if (create.some((p) => p.showcase) && !SHOWCASE_PASSWORD) SHOWCASE_PASSWORD = process.env.SEED_PASSWORD ?? randomBytes(12).toString("base64url");
  let done = 0;
  await pool(create, 8, async (p) => {
    const password = p.showcase ? SHOWCASE_PASSWORD! : randomBytes(24).toString("base64url");
    const { error } = await db.auth.admin.createUser({ id: p.id, email: loginIdEmail(p.login_id, SLUG), password, email_confirm: true });
    if (error) {
      // left behind by a run that stopped before its profile was written
      const { data } = await db.auth.admin.getUserById(p.id);
      if (!data?.user) throw new Error(`auth user ${p.login_id}: ${error.message}`);
      if (p.showcase) await db.auth.admin.updateUserById(p.id, { password });
    }
    if (p.showcase) showcaseCreated.push(p);
    if (++done % 250 === 0) console.log(`    ${what}: ${done}/${create.length} sign-in accounts`);
  });
  const rows = create.map((p) => ({
    id: p.id, tenant_id: TENANT, role: p.role, full_name: p.full_name, email: p.email, phone: p.phone, login_id: p.login_id,
    staff_title: p.staff_title ?? null, ...(p.handles_visitors ? { handles_visitors: true } : {}),
  }));
  for (const part of chunks(rows, 200)) {
    const { error } = await db.from("profiles").upsert(part, { onConflict: "id", ignoreDuplicates: true, defaultToNull: false });
    if (error) throw new Error(`profiles (${what}): ${error.message}`);
  }
  for (const r of rows) profileIds.add(r.id);
}

// ---------------------------------------------------------------- the timetable
/**
 * One week for every class with no teacher in two places at once. Lessons are placed greedily
 * (busiest teachers first), spread over the week, with a one-swap repair when a lesson has no
 * free slot left; whatever still can't be placed becomes a private-study period.
 */
function buildTimetable(classes: Cls[], teacherOf: Map<string, string>) {
  const classBusy = new Map<string, string>();   // classId|day|p -> code
  const teacherBusy = new Map<string, string>(); // teacherId|day|p -> classId
  const load = new Map<string, number>();
  for (const t of teacherOf.values()) load.set(t, (load.get(t) ?? 0) + 1);
  type Lesson = { cls: Cls; code: string; teacher: string; n: number };
  const lessons: Lesson[] = [];
  for (const c of classes) for (const [code, n] of c.codes) for (let k = 0; k < n; k++) lessons.push({ cls: c, code, teacher: teacherOf.get(`${c.id}|${code}`)!, n: k });
  const tl = new Map<string, number>();
  for (const l of lessons) tl.set(l.teacher, (tl.get(l.teacher) ?? 0) + 1);
  lessons.sort((a, b) => (tl.get(b.teacher)! - tl.get(a.teacher)!) || hr("ord", a.cls.name, a.code, a.n) - hr("ord", b.cls.name, b.code, b.n));
  const periodsFor = (c: Cls) => (c.level === "pre_primary" ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7]);
  const onDay = (c: Cls, code: string, d: string) => periodsFor(c).filter((p) => classBusy.get(`${c.id}|${d}|${p}`) === code).length;
  let repaired = 0, dropped = 0;
  for (const l of lessons) {
    const free: [string, number, number][] = [];
    for (const d of DAYS) for (const p of periodsFor(l.cls)) {
      if (classBusy.has(`${l.cls.id}|${d}|${p}`) || teacherBusy.has(`${l.teacher}|${d}|${p}`)) continue;
      const same = onDay(l.cls, l.code, d);
      if (same >= 2) continue;
      free.push([d, p, same * 10 + hr("slot", l.cls.name, l.code, l.n, d, p)]);
    }
    free.sort((a, b) => a[2] - b[2]);
    const put = (d: string, p: number, x: Lesson) => { classBusy.set(`${x.cls.id}|${d}|${p}`, x.code); teacherBusy.set(`${x.teacher}|${d}|${p}`, x.cls.id); };
    if (free.length) { put(free[0]![0], free[0]![1], l); continue; }
    // repair: free a slot where the teacher is free but the class has another lesson that can move
    let done = false;
    for (const d of DAYS) for (const p of periodsFor(l.cls)) {
      if (done || teacherBusy.has(`${l.teacher}|${d}|${p}`)) continue;
      const other = classBusy.get(`${l.cls.id}|${d}|${p}`);
      if (!other) continue;
      const ot = teacherOf.get(`${l.cls.id}|${other}`)!;
      for (const d2 of DAYS) for (const p2 of periodsFor(l.cls)) {
        if (done || classBusy.has(`${l.cls.id}|${d2}|${p2}`) || teacherBusy.has(`${ot}|${d2}|${p2}`)) continue;
        classBusy.delete(`${l.cls.id}|${d}|${p}`); teacherBusy.delete(`${ot}|${d}|${p}`);
        put(d2, p2, { cls: l.cls, code: other, teacher: ot, n: 0 });
        put(d, p, l);
        done = true; repaired++;
      }
    }
    if (!done) dropped++;
  }
  const slots: { cls: Cls; day: string; start: string; code: string | null; label: string; room: string }[] = [];
  for (const c of classes) {
    const home = `${c.stream} room`;
    let f = 0;
    for (const d of DAYS) {
      PERIODS.forEach((start, p) => {
        const code = classBusy.get(`${c.id}|${d}|${p}`) ?? null;
        if (code) { slots.push({ cls: c, day: d, start, code, label: "", room: ROOM_FOR[code] ?? (c.level === "pre_primary" && code === "PP-PCA" ? "Playground" : home) }); return; }
        if (c.level === "pre_primary") { slots.push({ cls: c, day: d, start, code: null, label: p === 6 ? "Rest time" : "Outdoor play", room: p === 6 ? home : "Playground" }); return; }
        const fill = FILLERS[c.band];
        const label = fill.length ? fill[f++ % fill.length]! : "Private study";
        slots.push({ cls: c, day: d, start, code: null, label, room: /Physical/.test(label) ? "Field" : label === "Library" ? "Library" : home });
      });
      if (c.level !== "pre_primary") {
        const label = d === "Wed" || d === "Fri" ? "Clubs and societies" : "Games";
        slots.push({ cls: c, day: d, start: "15:20", code: null, label, room: label === "Games" ? "Field" : "Club rooms" });
      }
    }
  }
  return { slots, repaired, dropped };
}

// ---------------------------------------------------------------- main
async function main() {
  const t0 = Date.now();
  console.log(`${DRY ? "DRY RUN (nothing is written): " : ""}Kijani Ridge Academy, the full demo year. ${LOCAL ? "Local" : `REMOTE ${HOST}`}, today ${TODAY}.`);

  const { data: tenant, error: tErr } = await db.from("tenants").select("id, name, slug").eq("slug", SLUG).maybeSingle();
  if (tErr) throw new Error(`tenants: ${tErr.message}`);
  if (!tenant) throw new Error(`No school with slug ${SLUG} here. Run seed-cbe.ts first; this script only extends it.`);
  if (process.env.EXPECT_TENANT_ID && tenant.id !== process.env.EXPECT_TENANT_ID) {
    throw new Error(`${SLUG} is ${tenant.id}, not EXPECT_TENANT_ID ${process.env.EXPECT_TENANT_ID}; refusing.`);
  }
  TENANT = tenant.id;
  const T = TENANT;
  console.log(`  school: ${tenant.name} (${T})`);

  // ---------------------------------------------------------------- what is there already
  const profiles = await all<Prof>("profiles", (a, b) => db.from("profiles").select("id, role, login_id, full_name, email, staff_title").eq("tenant_id", T).order("id").range(a, b));
  const byLogin = new Map(profiles.filter((p) => p.login_id).map((p) => [p.login_id!.toUpperCase(), p]));
  const profileIds = new Set(profiles.map((p) => p.id));
  const head = profiles.find((p) => p.role === "school_admin" && p.email === "head@kijaniridge.sc.ke") ?? profiles.find((p) => p.role === "school_admin");
  if (!head) throw new Error("No head teacher (school_admin) at Kijani Ridge; run seed-cbe.ts first.");
  const daniel = byLogin.get("TC-0001");

  // ---------------------------------------------------------------- terms
  let terms = await all<Term>("terms", (a, b) => db.from("terms").select("id, name, index, starts_on, ends_on, is_current").eq("tenant_id", T).eq("year", 2026).order("index").range(a, b));
  const anyCurrent = terms.some((t) => t.is_current);
  const newTerms = [1, 2, 3].filter((i) => !terms.some((t) => t.index === i)).map((i) => ({
    id: uid(`term:${i}`), tenant_id: T, name: `Term ${i}, 2026`, year: 2026, index: i,
    starts_on: TERM_DEFAULTS[i]![0], ends_on: TERM_DEFAULTS[i]![1], is_current: i === 3 && !anyCurrent,
  }));
  await insertMissing("terms", newTerms);
  terms = [...terms, ...newTerms].sort((a, b) => a.index - b.index);
  const termOf = (i: number) => terms.find((t) => t.index === i)!;
  const termOn = (d: string) => terms.find((t) => d >= t.starts_on && d <= t.ends_on) ?? null;

  // ---------------------------------------------------------------- subjects from the KICD catalogue
  const wanted = [...new Set([...Object.values(AREAS).flat().map(([c]) => c), ...Object.values(ELECTIVES).flat()])];
  const catalogue = ok(await db.from("learning_areas").select("id, code, name, level, min_grade, max_grade, is_core").in("code", wanted), "learning_areas");
  if (catalogue.length !== wanted.length) throw new Error(`The KICD catalogue lacks ${wanted.filter((c) => !catalogue.some((a) => a.code === c)).join(", ")}`);
  const subjects = await all<{ id: string; code: string }>("subjects", (a, b) => db.from("subjects").select("id, code").eq("tenant_id", T).order("id").range(a, b));
  const newSubjects = catalogue.filter((a) => !subjects.some((s) => s.code === a.code)).map((a) => ({
    id: uid(`subject:${a.code}`), tenant_id: T, name: a.name, code: a.code, is_core: a.is_core, learning_area_id: a.id,
    level: a.level, min_form_level: a.min_grade, max_form_level: a.max_grade,
  }));
  await insertMissing("subjects", newSubjects);
  const subjectId = (code: string) => (subjects.find((s) => s.code === code) ?? newSubjects.find((s) => s.code === code))!.id;
  const subjectName = (code: string) => catalogue.find((a) => a.code === code)!.name;
  const areaId = (code: string) => catalogue.find((a) => a.code === code)!.id;

  // ---------------------------------------------------------------- classes
  type DbClass = { id: string; name: string; class_teacher_id: string | null };
  const dbClasses = await all<DbClass>("classes", (a, b) => db.from("classes").select("id, name, class_teacher_id").eq("tenant_id", T).order("name").range(a, b));
  const CLASSES: Cls[] = [];
  YEARS.forEach((y, yi) => {
    for (const [stream, pathway] of y.streams) {
      const name = `${y.label} ${stream}`;
      const found = dbClasses.find((c) => c.name === name);
      const codes: [string, number][] = y.band === "SS" ? [...AREAS.SS, ...ELECTIVES[pathway!].map((c): [string, number] => [c, 5])] : AREAS[y.band];
      CLASSES.push({ key: name, name, level: y.level, year: y.year, band: y.band, stream, pathway: pathway ?? null, idx: CLASSES.length, yi,
        id: found?.id ?? uid(`class:${name}`), existing: !!found, classTeacher: found?.class_teacher_id ?? null, codes });
    }
  });
  const classById = new Map(CLASSES.map((c) => [c.id, c]));

  // ---------------------------------------------------------------- teachers: who teaches what
  const teachers: Teacher[] = [];
  const staffNames = new Set(profiles.map((p) => p.full_name));
  const uniqueName = (gender: "male" | "female", ...k: (string | number)[]) => {
    let full = "";
    for (let salt = 0; !full || staffNames.has(full); salt++) full = personName(gender, pickH(SURNAMES, "sur", ...k, salt), ...k, salt);
    staffNames.add(full);
    return full;
  };
  let tcount = 0;
  const newTeacher = (key: string, title: string, female: number): Teacher => {
    const gender = hr("g", key) < female ? "female" : "male";
    const full = uniqueName(gender, key);
    const n = ++tcount;
    const login_id = `TC-${String(100 + n).padStart(4, "0")}`;
    const t: Teacher = { id: uid(`person:${login_id}`), login_id, role: "teacher", full_name: full, email: emailFor(full), phone: fakePhone(100_000 + n),
      staff_title: title, gender, tsc: String(300_000 + Math.floor(hr("tsc", key) * 600_000)),
      joined: `${2008 + Math.floor(hr("joined", key) * 17)}-${String(1 + Math.floor(hr("jm", key) * 12)).padStart(2, "0")}-01`,
      lessons: 0, teaches: [] };
    teachers.push(t);
    return t;
  };
  // pre-primary and lower primary: the class teacher teaches the class nearly everything (Kiswahili is a department's)
  for (const c of CLASSES.filter((x) => x.band === "PP1" || x.band === "PP2" || x.band === "LP")) {
    const t = newTeacher(`ct:${c.name}`, c.level === "pre_primary" ? "Pre-primary teacher" : "Lower primary teacher", 0.85);
    for (const [code, n] of c.codes) if (code !== "LP-KIS") { t.teaches.push({ cls: c, code, n }); t.lessons += n; }
    if (!c.classTeacher) c.classTeacher = t.id;
  }
  for (const d of DEPARTMENTS) {
    const pairs = d.codes.flatMap((code) => CLASSES.filter((c) => c.codes.some(([k]) => k === code)).map((cls) => ({ cls, code, n: cls.codes.find(([k]) => k === code)![1] })));
    const total = pairs.reduce((s, p) => s + p.n, 0);
    const k = Math.max(1, Math.ceil(total / TEACHER_LOAD));
    const target = total / k;
    const dept: Teacher[] = [];
    for (let j = 0; j < k; j++) {
      if (d.name === "Mathematics" && j === 0 && daniel && daniel.role === "teacher") {
        // Daniel Kiprop (seed-cbe's TC-0001) keeps his account and record; only what he teaches is replanned
        const t: Teacher = { id: daniel.id, login_id: "TC-0001", role: "teacher", full_name: daniel.full_name, email: daniel.email, phone: null,
          staff_title: daniel.staff_title, lessons: 0, teaches: [], dept: d.name };
        teachers.push(t); dept.push(t);
        continue;
      }
      const title = j === 0 ? `Head of ${d.name}` : d.name === "English" && j === 1 ? "Deputy head teacher" : d.name === "Sciences" && j === 1 ? "Senior teacher" : "Teacher";
      const t = newTeacher(`dept:${d.name}:${j}`, title, 0.55);
      t.dept = d.name;
      dept.push(t);
    }
    let j = 0;
    for (const p of pairs) {
      if (dept[j]!.lessons > 0 && dept[j]!.lessons + p.n > target * 1.12 && j < dept.length - 1) j++;
      dept[j]!.teaches.push(p); dept[j]!.lessons += p.n;
    }
  }
  const teacherOf = new Map<string, string>();   // "classId|code" -> teacher id
  for (const t of teachers) for (const p of t.teaches) teacherOf.set(`${p.cls.id}|${p.code}`, t.id);
  // class teachers for Grade 4-12: the teacher with most lessons in the class who isn't one already
  const isClassTeacher = new Set(CLASSES.map((c) => c.classTeacher).filter(Boolean) as string[]);
  const lessonsIn = (t: Teacher, c: Cls) => t.teaches.filter((p) => p.cls === c).reduce((s, p) => s + p.n, 0);
  for (const c of CLASSES.filter((x) => !x.classTeacher)) {
    const cands = teachers.filter((t) => !isClassTeacher.has(t.id) && t.id !== daniel?.id && lessonsIn(t, c) > 0)
      .sort((a, b) => lessonsIn(b, c) - lessonsIn(a, c) || a.login_id.localeCompare(b.login_id));
    const t = cands[0] ?? teachers.find((x) => !isClassTeacher.has(x.id) && x.id !== daniel?.id)!;
    c.classTeacher = t.id; isClassTeacher.add(t.id);
  }
  const newTeachers = teachers.filter((t) => t.id !== daniel?.id);
  const deputy = newTeachers.find((t) => t.staff_title === "Deputy head teacher");
  if (deputy) deputy.areas = ["people", "academics", "attendance", "communication", "leave", "activities"];
  const gamesMaster = newTeachers.find((t) => t.staff_title === "Head of Creative Arts and Sports");
  if (gamesMaster) gamesMaster.areas = ["activities"];
  const showClassTeacher = newTeachers.find((t) => t.id === CLASSES.find((c) => c.name === "Grade 4 Olive")!.classTeacher);
  const showSubjectTeacher = newTeachers.find((t) => !isClassTeacher.has(t.id) && t.teaches.some((p) => ["SS-BIO", "SS-CHEM", "SS-PHY"].includes(p.code)));
  if (showClassTeacher) showClassTeacher.showcase = "class teacher";
  if (showSubjectTeacher) showSubjectTeacher.showcase = "subject teacher";
  const teacherById = new Map(teachers.map((t) => [t.id, t]));
  console.log(`  plan: ${CLASSES.length} classes, ${teachers.length} teachers (${newTeachers.length} new), ${teachers.reduce((s, t) => s + t.lessons, 0)} lessons a week`);

  // ---------------------------------------------------------------- support staff (around any the school already has)
  const foreignStaff = profiles.filter((p) => p.role === "staff");
  const usedForeign = new Set<string>();
  const support: Person[] = [];
  SUPPORT.forEach((s, i) => {
    const login_id = `SF-${String(101 + i).padStart(4, "0")}`;
    const id = uid(`person:${login_id}`);
    const taken = foreignStaff.find((p) => p.id !== id && !usedForeign.has(p.id) && !!p.staff_title && s.match.test(p.staff_title)
      && !SUPPORT.some((x, xi) => uid(`person:SF-${String(101 + xi).padStart(4, "0")}`) === p.id));
    let title = s.title;
    if (taken) {
      usedForeign.add(taken.id);
      if (!s.showcase || !s.alt) return;   // the school already has one
      title = s.alt;                        // the showcase login is still made: the bursar's or storekeeper's assistant
    }
    const female = /cook|matron|secretary|reception|nurse|librar|cleaner/i.test(s.title) ? 0.8 : /guard|grounds/i.test(s.title) ? 0.1 : 0.5;
    const gender = hr("g", s.key) < female ? "female" : "male";
    const full = uniqueName(gender, s.key);
    support.push({ id, login_id, role: "staff", full_name: full, email: emailFor(full), phone: fakePhone(150_000 + i), staff_title: title,
      handles_visitors: !!s.visitors, areas: s.areas, showcase: s.showcase, gender,
      joined: `${2012 + Math.floor(hr("joined", s.key) * 13)}-${String(1 + Math.floor(hr("jm", s.key) * 12)).padStart(2, "0")}-01` });
  });
  const bursarId = support.find((p) => p.showcase === "bursar")?.id ?? head.id;
  const storeId = support.find((p) => p.showcase === "storekeeper")?.id ?? head.id;
  console.log(`  plan: ${support.length} support staff (${SUPPORT.length - support.length} roles already filled at the school)`);

  // ---------------------------------------------------------------- learners: every class topped up to ~35
  const dbStudents = await all<DbStudent>("students", (a, b) => db.from("students").select("id, full_name, class_id, admission_no, boarding, gender, active, profile_id").eq("tenant_id", T).order("id").range(a, b));
  const admTaken = new Map(dbStudents.map((s) => [s.admission_no, s.id]));
  const slots: Slot[] = [];
  for (const c of CLASSES) {
    const mineIds = new Set(Array.from({ length: 50 }, (_, i) => uid(`learner:${c.name}:${i}`)));
    const foreign = dbStudents.filter((s) => s.class_id === c.id && !mineIds.has(s.id)).length;
    const target = 32 + Math.floor(hr("size", c.name) * 7);
    for (let i = 0; i < Math.max(0, target - foreign); i++) {
      const id = uid(`learner:${c.name}:${i}`);
      const adm = String(8001 + c.idx * 50 + i);
      if (admTaken.has(adm) && admTaken.get(adm) !== id) { console.log(`  admission no. ${adm} is someone else's; slot skipped`); continue; }
      slots.push({ key: `${c.name}:${i}`, cls: c, i, id, adm });
    }
  }
  // families: siblings across the school, and one showcase family with children in three bands
  const families: Family[] = [];
  const assigned = new Set<string>();
  const slotAt = (cls: string, i: number) => slots.find((s) => s.cls.name === cls && s.i === i);
  const showKids = [slotAt("Grade 2 Mugumo", 0), slotAt("Grade 7 Mahogany", 0), slotAt("Grade 11 Bamboo", 0)].filter(Boolean) as Slot[];
  const fam = (key: string, kids: Slot[], foreignKids: DbStudent[] = []): Family => {
    for (const k of kids) assigned.add(k.key);
    const r = hr("payer", key);
    const f: Family = { key, surname: pickH(SURNAMES, "fam", key), kids, foreignKids, guardians: [], payer: r < 0.55 ? "A" : r < 0.83 ? "B" : r < 0.96 ? "C" : "D" };
    families.push(f);
    return f;
  };
  const showFamily = fam("showcase", showKids);
  showFamily.surname = "Kamau"; showFamily.payer = "B";
  for (const s of slots) {
    if (assigned.has(s.key)) continue;
    const f = fam(`f:${s.key}`, [s]);
    const r = hr("sib", s.key);
    const extra = r < 0.03 ? 2 : r < 0.24 ? 1 : 0;
    for (let e = 0; e < extra; e++) {
      const cands = slots.filter((x) => !assigned.has(x.key) && f.kids.every((k) => Math.abs(k.cls.yi - x.cls.yi) >= 2));
      if (!cands.length) break;
      const x = cands[Math.floor(hr("sibpick", s.key, e) * cands.length)]!;
      f.kids.push(x); assigned.add(x.key);
    }
  }
  // seed-cbe's learners without a guardian (other than one this script gave them) get a family of their own
  const loginOf = new Map(profiles.map((p) => [p.id, p.login_id]));
  const guarded = new Set((await all<{ student_id: string; profile_id: string }>("guardians", (a, b) => db.from("guardians").select("student_id, profile_id").eq("tenant_id", T).order("id").range(a, b)))
    .filter((g) => { const l = loginOf.get(g.profile_id); return !l || g.profile_id !== uid(`person:${l}`) || !/^PT-\d{4}$/.test(l) || Number(l.slice(3)) < 2001; }).map((g) => g.student_id));
  const slotIds = new Set(slots.map((s) => s.id));
  for (const s of dbStudents.filter((x) => !slotIds.has(x.id) && !guarded.has(x.id) && x.active && x.class_id && classById.has(x.class_id))) {
    const f = fam(`fs:${s.id}`, [], [s]);
    f.surname = s.full_name.split(" ").pop()!;
  }
  // learner records
  const learnerRows: Row[] = [];
  for (const f of families) for (const k of f.kids) {
    const gender = hr("lg", k.key) < 0.5 ? "female" : "male";
    const middle = hr("mid", k.key) < 0.45 ? ` ${pickH(gender === "female" ? F_FIRST.slice(47) : M_FIRST.slice(51), "mn", k.key)}` : "";
    let name = `${pickH(gender === "female" ? F_FIRST.slice(0, 47) : M_FIRST.slice(0, 51), "lf", k.key)}${middle} ${f.surname}`;
    if (f === showFamily) name = ["Wanjiru Kamau", "Brian Kamau", "Imani Wanjiku Kamau"][f.kids.indexOf(k)] ?? name;
    const g2 = f === showFamily ? (["female", "male", "female"][f.kids.indexOf(k)] as "male" | "female") : gender;
    const age = k.cls.level === "pre_primary" ? 3 + k.cls.year : k.cls.year + 5;
    const birthYear = 2026 - age - (hr("by", k.key) < 0.35 ? 1 : 0);
    const rel = hr("rel", f.key);
    learnerRows.push({
      id: k.id, tenant_id: T, admission_no: k.adm, full_name: name, class_id: k.cls.id, active: true, gender: g2,
      date_of_birth: addDays(`${birthYear}-01-01`, Math.floor(hr("dob", k.key) * 364)),
      boarding: k.cls.band === "SS" && hr("board", k.key) < 0.38,
      nationality: rel < 0.96 ? "Kenyan" : rel < 0.98 ? "Ugandan" : "Tanzanian",
      religion: rel < 0.78 ? "Christian" : rel < 0.93 ? "Muslim" : rel < 0.96 ? "Hindu" : "Other",
      home_address: `${pickH(ESTATES, "estate", f.key)}, Nairobi`,
    });
  }
  // guardians: mostly both parents, some a single parent or a grandparent
  let pt = 0;
  for (const f of families) {
    const r = hr("gshape", f.key);
    const shape: Guardian["relationship"][] = f === showFamily ? ["mother", "father"] : r < 0.06 ? ["guardian"] : r < 0.2 ? ["mother"] : r < 0.25 ? ["father"] : ["mother", "father"];
    const payer = shape.length > 1 && hr("pp", f.key) < 0.4 ? 1 : 0;
    shape.forEach((rel, gi) => {
      pt++;
      const login_id = `PT-${String(2000 + pt).padStart(4, "0")}`;
      const gender = rel === "father" ? "male" : "female";
      const surname = rel === "father" || hr("ms", f.key) < 0.7 ? f.surname : pickH(SURNAMES, "maiden", f.key);
      const full = f === showFamily ? (rel === "mother" ? "Beatrice Wanjiku Kamau" : "Joseph Kamau Njuguna") : personName(gender, surname, "parent", f.key, rel);
      f.guardians.push({ id: uid(`person:${login_id}`), login_id, role: "parent", full_name: full, email: emailFor(full),
        phone: fakePhone(200_000 + pt), relationship: rel, primary: gi === payer, gender,
        showcase: f === showFamily && rel === "mother" ? "parent" : undefined });
    });
  }
  const parents = families.flatMap((f) => f.guardians);
  // the showcase learner (Grade 11) signs in too
  const showLearnerSlot = showKids.find((k) => k.cls.year === 11);
  const showLearner: Person | null = showLearnerSlot ? { id: uid("person:ST-2001"), login_id: "ST-2001", role: "student",
    full_name: learnerRows.find((r) => r.id === showLearnerSlot.id)!.full_name as string, email: null, phone: null, showcase: "learner" } : null;
  console.log(`  plan: ${learnerRows.length} new learners (${dbStudents.length} there already), ${families.length} families, ${parents.length} parents and guardians`);

  // ================================================================ writes
  // ---------------------------------------------------------------- classes
  await insertMissing("classes", CLASSES.filter((c) => !c.existing).map((c) => ({
    id: c.id, tenant_id: T, name: c.name, form_level: c.year, level: c.level, pathway: c.pathway, stream: c.stream, room: `${c.stream} room`,
  })));

  // ---------------------------------------------------------------- staff accounts, then class teachers and permissions
  console.log("  staff accounts…");
  await ensureAccounts("teachers", newTeachers, byLogin, profileIds);
  await ensureAccounts("support staff", support, byLogin, profileIds);
  const skipped = new Set([...newTeachers, ...support].filter((p) => (p as { skip?: boolean }).skip).map((p) => p.id));
  if (skipped.size) throw new Error(`${skipped.size} staff login IDs are taken by other people at this school; resolve that first.`);
  if (!DRY) {
    for (const c of CLASSES) {
      const cur = dbClasses.find((x) => x.id === c.id)?.class_teacher_id;
      if (c.classTeacher && !cur) ok(await db.from("classes").update({ class_teacher_id: c.classTeacher }).eq("id", c.id).eq("tenant_id", T).is("class_teacher_id", null).select("id"), `class teacher ${c.name}`);
    }
  }
  const perms = [...newTeachers, ...support].flatMap((p) => (p.areas ?? []).map((area) => ({ tenant_id: T, profile_id: p.id, area, granted_by: head.id })));
  await insertIgnore("staff_permissions", perms, "profile_id,area");

  // ---------------------------------------------------------------- teaching assignments and the timetable
  await upsertOn("teaching_assignments", [...teacherOf.entries()].map(([k, teacher_id]) => {
    const [class_id, code] = k.split("|") as [string, string];
    return { tenant_id: T, class_id, subject_id: subjectId(code), teacher_id };
  }), "class_id,subject_id");
  const tt = buildTimetable(CLASSES, teacherOf);
  await upsertOn("timetable_slots", tt.slots.map((s) => ({
    tenant_id: T, class_id: s.cls.id, day: s.day, start_time: s.start, label: s.code ? subjectName(s.code) : s.label, room: s.room,
    subject_id: s.code ? subjectId(s.code) : null,
  })), "class_id,day,start_time");
  console.log(`  timetable: ${tt.slots.length} slots, ${tt.repaired} lessons moved to avoid a clash, ${tt.dropped} could not be placed (private study instead)`);

  // ---------------------------------------------------------------- learners, parents, guardians
  console.log("  learners and families…");
  await insertMissing("students", learnerRows);
  await ensureAccounts("parents", parents, byLogin, profileIds);
  if (showLearner) await ensureAccounts("learner", [showLearner], byLogin, profileIds);
  if (showLearner && showLearnerSlot && !DRY && !(showLearner as { skip?: boolean }).skip) {
    await db.from("students").update({ profile_id: showLearner.id }).eq("id", showLearnerSlot.id).is("profile_id", null);
  }
  const guardianRows = families.flatMap((f) => f.guardians.filter((g) => !(g as { skip?: boolean }).skip).flatMap((g) =>
    [...f.kids.map((k) => k.id), ...f.foreignKids.map((k) => k.id)].map((sid) => ({
      id: uid(`guardian:${g.id}:${sid}`), tenant_id: T, profile_id: g.id, student_id: sid, relationship: g.relationship, is_primary_payer: g.primary,
    }))));
  await insertIgnore("guardians", guardianRows, "profile_id,student_id");

  // everyone the rest of the year is about: the planned learners plus those already there
  const learners = [
    ...learnerRows.map((r) => ({ id: r.id as string, name: r.full_name as string, cls: classById.get(r.class_id as string)!, gender: r.gender as string, boarding: r.boarding as boolean, mine: true })),
    ...dbStudents.filter((s) => !slotIds.has(s.id) && s.active && s.class_id && classById.has(s.class_id)).map((s) => ({
      id: s.id, name: s.full_name, cls: classById.get(s.class_id!)!, gender: s.gender ?? (hr("lg", s.id) < 0.5 ? "female" : "male"), boarding: s.boarding, mine: false })),
  ];
  const learnersOf = new Map<string, typeof learners>();
  for (const l of learners) learnersOf.set(l.cls.id, [...(learnersOf.get(l.cls.id) ?? []), l]);
  const familyOf = new Map<string, Family>();
  for (const f of families) for (const k of [...f.kids.map((x) => x.id), ...f.foreignKids.map((x) => x.id)]) familyOf.set(k, f);

  await seedYear({ T, terms, termOf, termOn, CLASSES, learners, learnersOf, familyOf, teacherOf, teacherById, head, bursarId, storeId,
    subjectId, subjectName, areaId, deputyId: deputy?.id ?? head.id, gamesId: gamesMaster?.id ?? head.id, staffCount: profiles.filter((p) => !["parent", "student"].includes(p.role)).length + newTeachers.length + support.length });

  // ---------------------------------------------------------------- logins file and staff manifest
  if (!DRY) await writeOutputs({ showcase: [...newTeachers, ...support, ...parents, ...(showLearner ? [showLearner] : [])].filter((p) => p.showcase),
    staff: [...teachers, ...support], head, CLASSES, teacherById });

  console.log(`\n${DRY ? "Would write" : "Done"} (${((Date.now() - t0) / 1000).toFixed(0)} s). Rows ${DRY ? "planned / missing now" : "planned / inserted"}:`);
  for (const [table, s] of [...STATS.entries()].sort()) console.log(`  ${table.padEnd(34)} ${String(s.planned).padStart(7)}  ${s.added ? String(s.added).padStart(7) : "      -"}`);
  console.log("  (tables written with ON CONFLICT DO NOTHING show only the planned count: rows already there are skipped)");
}

// ================================================================ the year
type L = { id: string; name: string; cls: Cls; gender: string; boarding: boolean; mine: boolean };
type Ctx = {
  T: string; terms: Term[]; termOf: (i: number) => Term; termOn: (d: string) => Term | null; CLASSES: Cls[];
  learners: L[]; learnersOf: Map<string, L[]>; familyOf: Map<string, Family>; teacherOf: Map<string, string>; teacherById: Map<string, Teacher>;
  head: Prof; bursarId: string; storeId: string; deputyId: string; gamesId: string; staffCount: number;
  subjectId: (code: string) => string; subjectName: (code: string) => string; areaId: (code: string) => string;
};

const UNIFORMS: { group: "PP" | "PR" | "JS" | "SS" | "ALL"; name: string; kes: number; who?: "male" | "female" }[] = [
  { group: "PP", name: "Pre-primary sweater (red)", kes: 1_100 }, { group: "PP", name: "Pre-primary T-shirt (white)", kes: 550 },
  { group: "PP", name: "Pre-primary shorts (grey)", kes: 650, who: "male" }, { group: "PP", name: "Pre-primary skirt (grey)", kes: 700, who: "female" },
  { group: "PR", name: "Primary sweater (green)", kes: 1_200 }, { group: "PR", name: "Primary shirt (white)", kes: 650 },
  { group: "PR", name: "Primary shorts (grey)", kes: 750, who: "male" }, { group: "PR", name: "Primary skirt (grey)", kes: 850, who: "female" },
  { group: "JS", name: "Junior school sweater (maroon)", kes: 1_400 }, { group: "JS", name: "Junior school shirt (light blue)", kes: 750 },
  { group: "JS", name: "Junior school trousers (grey)", kes: 1_100, who: "male" }, { group: "JS", name: "Junior school skirt (grey)", kes: 1_000, who: "female" },
  { group: "SS", name: "Senior school sweater (navy)", kes: 1_500 }, { group: "SS", name: "Senior school shirt (white)", kes: 800 },
  { group: "SS", name: "Senior school trousers (black)", kes: 1_300, who: "male" }, { group: "SS", name: "Senior school skirt (black)", kes: 1_200, who: "female" },
  { group: "ALL", name: "School tracksuit (green and white)", kes: 2_600 }, { group: "ALL", name: "Games kit (house T-shirt and shorts)", kes: 1_200 },
];
const uniformGroup = (b: Band) => (b === "PP1" || b === "PP2" ? "PP" : b === "LP" || b === "UP" ? "PR" : b);
const PUBLISHERS = ["Savannah Learners Press", "Jamhuri Educational Publishers", "Mlima Books", "Tausi Publishing"];
const BOOK_SUBJECTS: Record<Band, string[]> = {
  PP1: ["Language Activities", "Mathematical Activities"], PP2: ["Language Activities", "Mathematical Activities"],
  LP: ["English Activities", "Mathematical Activities", "Kiswahili Activities", "Environmental Activities"],
  UP: ["English", "Mathematics", "Kiswahili", "Science and Technology", "Social Studies"],
  JS: ["English", "Mathematics", "Kiswahili", "Integrated Science", "Pre-Technical Studies"],
  SS: ["English", "Mathematics", "Kiswahili", "Biology", "History and Citizenship"],
};

async function seedYear(c: Ctx) {
  const { T, terms, CLASSES, learners } = c;
  const started = terms.filter((t) => t.starts_on <= TODAY);
  const schoolDaysOf = new Map(terms.map((t) => [t.id, termDays(t, "2026-12-31")]));

  // ---------------------------------------------------------------- transport riders (the three bus routes seed-cbe made)
  const routes = ok(await db.from("routes").select("id, name").eq("tenant_id", T), "routes");
  const stops = routes.length ? ok(await db.from("route_stops").select("id, route_id, sequence").in("route_id", routes.map((r) => r.id)), "route_stops") : [];
  const route = (re: RegExp) => routes.find((r) => re.test(r.name)) ?? routes[0];
  const riderRows: Row[] = [];
  if (routes.length) for (const l of learners.filter((x) => x.mine && !x.boarding && hr("ride", x.id) < 0.11)) {
    const primary = ["PP1", "PP2", "LP", "UP"].includes(l.cls.band);
    const r = primary ? (hr("rr", l.id) < 0.6 ? route(/route 1/i) : route(/route 2/i)) : (hr("rr", l.id) < 0.6 ? route(/route 3/i) : route(/route 2/i));
    const rs = stops.filter((s) => s.route_id === r!.id && s.sequence > 1);
    if (!rs.length) continue;
    riderRows.push({ tenant_id: T, student_id: l.id, route_id: r!.id, stop_id: pickH(rs, "stop", l.id).id });
  }
  await insertIgnore("student_transport", riderRows, "student_id");
  const riders: { student_id: string; route_id: string }[] = DRY ? (riderRows as never)
    : await all("student_transport", (a, b) => db.from("student_transport").select("student_id, route_id").eq("tenant_id", T).order("id").range(a, b));
  const routeName = new Map(routes.map((r) => [r.id, r.name]));
  const learnerIds = new Set(learners.map((l) => l.id));

  // ---------------------------------------------------------------- fee structure: one per band, every term
  console.log("  fees…");
  const feeRows: Row[] = [];
  for (const t of terms) {
    for (const y of YEARS) for (const [name, amount] of FEES[y.band]) {
      feeRows.push({ id: uid(`fee:${t.index}:${y.label}:${name}`), tenant_id: T, term_id: t.id, name, amount_cents: kes(amount), applies_to: "form_level", form_level: y.year, level: y.level });
    }
    feeRows.push({ id: uid(`fee:${t.index}:boarding`), tenant_id: T, term_id: t.id, name: BOARDING_FEE[0], amount_cents: kes(BOARDING_FEE[1]), applies_to: "boarders", form_level: null, level: null });
  }
  await insertMissing("fee_items", feeRows);
  const mineFees = new Set(feeRows.map((r) => r.id as string));
  const oldItems = ok(await db.from("fee_items").select("id, name, applies_to").eq("tenant_id", T).eq("term_id", c.termOf(3).id).in("name", OLD_ITEMS).neq("applies_to", "form_level"), "old fee items")
    .filter((r) => !mineFees.has(r.id));
  stat("fee_items (seed-cbe Term 3, removed)", oldItems.length, oldItems.length);
  if (!DRY && oldItems.length) ok(await db.from("fee_items").delete().in("id", oldItems.map((r) => r.id)).eq("tenant_id", T).select("id"), "remove old fee items");
  const feesOf = (l: L) => kes(FEES[l.cls.band].reduce((s, [, a]) => s + a, 0) + (l.boarding ? BOARDING_FEE[1] : 0));

  // ---------------------------------------------------------------- invoices
  type Inv = { id: string; student_id: string; term_id: string; total_cents: number; paid_cents: number; charges_cents: number; due_on: string };
  const dbInv = await all<Inv>("fee_invoices", (a, b) => db.from("fee_invoices").select("id, student_id, term_id, total_cents, paid_cents, charges_cents, due_on").eq("tenant_id", T).order("id").range(a, b));
  const invByKey = new Map(dbInv.map((i) => [`${i.student_id}|${i.term_id}`, i]));
  const invoiceRows: Row[] = [];
  const retotal: { inv: Inv; total: number; wasPaid: boolean }[] = [];
  const planned = new Map<string, { id: string; l: L; t: Term; fees: number; charges: number; mine: boolean }>();
  for (const t of started) for (const l of learners) {
    const ex = invByKey.get(`${l.id}|${t.id}`);
    const id = ex?.id ?? uid(`invoice:${t.index}:${l.id}`);
    const mine = !ex || ex.id === uid(`invoice:${t.index}:${l.id}`);
    planned.set(`${l.id}|${t.id}`, { id, l, t, fees: feesOf(l), charges: 0, mine });
    if (!ex) invoiceRows.push({ id, tenant_id: T, student_id: l.id, term_id: t.id, total_cents: feesOf(l), due_on: FEE_DUE[t.index] ?? addDays(t.starts_on, 18) });
    else if (!mine && t.index === 3) {
      // billed by seed-cbe from the old school-wide items: re-total to this band's structure, once
      const old = kes(22_000 + 2_500 + 1_500 + (l.boarding ? 16_000 : 8_500));
      if (ex.total_cents - ex.charges_cents === old && feesOf(l) !== old && ex.paid_cents <= feesOf(l) + ex.charges_cents) retotal.push({ inv: ex, total: feesOf(l) + ex.charges_cents, wasPaid: ex.paid_cents >= ex.total_cents });
    }
  }
  await insertMissing("fee_invoices", invoiceRows);
  stat("fee_invoices (seed-cbe Term 3, re-totalled)", retotal.length, retotal.length);
  if (!DRY) for (const r of retotal) {
    const status = r.inv.paid_cents >= r.total ? "paid" : r.inv.due_on < TODAY ? "overdue" : r.inv.paid_cents > 0 ? "part_paid" : "unpaid";
    ok(await db.from("fee_invoices").update({ total_cents: r.total, status }).eq("id", r.inv.id).eq("tenant_id", T).select("id"), "re-total invoice");
  }

  // ---------------------------------------------------------------- charges: transport each term, and uniforms (below)
  const charges: Row[] = [];
  const charge = (sid: string, t: Term, key: string, amount: number, reason: string, when: string, issue_id: string | null = null) => {
    const inv = planned.get(`${sid}|${t.id}`);
    if (!inv) return;
    inv.charges += amount;
    charges.push({ id: uid(`charge:${key}`), tenant_id: T, invoice_id: inv.id, student_id: sid, amount_cents: amount, reason, issue_id, created_by: c.bursarId, created_at: when });
  };
  for (const r of riders) if (learnerIds.has(r.student_id)) for (const t of started) {
    const name = routeName.get(r.route_id) ?? "School bus";
    charge(r.student_id, t, `transport:${t.index}:${r.student_id}`, kes(transportFee(name)), `Transport: ${name}, Term ${t.index}`, at(t.starts_on, "09:00"));
  }

  // ---------------------------------------------------------------- inventory: uniforms (issued and billed), textbooks (issued), stationery, assets
  console.log("  inventory…");
  const issues: Row[] = [];
  const uniformOut = new Map<string, number>();
  for (const l of learners) for (const t of started) {
    const p = t.index === 1 ? 0.45 : t.index === 2 ? 0.15 : 0.12;
    if (hr("u", l.id, t.index) >= p) continue;
    const g = uniformGroup(l.cls.band);
    const choice = UNIFORMS.filter((u) => (u.group === g || u.group === "ALL") && (!u.who || u.who === l.gender))
      .sort((a, b) => hr("uo", l.id, t.index, a.name) - hr("uo", l.id, t.index, b.name))
      .slice(0, t.index === 1 ? 1 + Math.floor(hr("un", l.id) * 3) : 1);
    const days = schoolDaysOf.get(t.id)!.filter((d) => d <= YESTERDAY);
    if (!days.length) continue;
    const day = days[Math.min(days.length - 1, Math.floor(hr("ud", l.id, t.index) * 8))]!;
    for (const u of choice) {
      const qty = /shirt/i.test(u.name) && hr("uq", l.id, u.name) < 0.5 ? 2 : 1;
      const issueId = uid(`uissue:${l.id}:${t.index}:${u.name}`);
      const when = at(day, hm(10 * 60 + Math.floor(hr("ut", issueId) * 300)));
      issues.push({ id: issueId, tenant_id: T, item_id: uid(`item:uniform:${u.name}`), student_id: l.id, quantity: qty, issued_by: c.storeId, issued_at: when,
        condition_out: "new", status: "out", note: "Uniform issued; charged to this term's fees." });
      uniformOut.set(u.name, (uniformOut.get(u.name) ?? 0) + qty);
      charge(l.id, t, `uniform:${issueId}`, kes(u.kes * qty), `Uniform: ${u.name}${qty > 1 ? ` x${qty}` : ""}`, when, issueId);
    }
  }
  const items: Row[] = [];
  const item = (key: string, r: Row) => items.push({ id: uid(`item:${key}`), tenant_id: T, tracking: "stock", condition: "good", ...r });
  for (const u of UNIFORMS) {
    item(`uniform:${u.name}`, { name: u.name, category: "uniforms", quantity: (uniformOut.get(u.name) ?? 0) + 25 + Math.floor(hr("us", u.name) * 40),
      condition: "new", location: "Uniform store", purchased_on: "2025-12-10", unit_cost_cents: kes(u.kes), notes: "Sold to families at cost: each issue is added to the term's invoice." });
  }
  // textbooks: a Learner's Book per learning area per grade; Grade 4-12 learners each have Mathematics and English out on loan
  const perYear = new Map<number, L[]>();
  for (const l of learners) perYear.set(l.cls.yi, [...(perYear.get(l.cls.yi) ?? []), l]);
  YEARS.forEach((y, yi) => {
    for (const subj of BOOK_SUBJECTS[y.band]) {
      const name = `${subj} ${y.label} Learner's Book (${pickH(PUBLISHERS, "pub", subj)})`;
      const loaned = y.band !== "PP1" && y.band !== "PP2" && y.band !== "LP" && (subj === "Mathematics" || subj === "English");
      const qty = loaned ? (perYear.get(yi)?.length ?? 0) + 8 + Math.floor(hr("bk", name) * 10) : 40 + Math.floor(hr("bk", name) * 40);
      item(`book:${name}`, { name, category: "textbooks", quantity: qty, location: `Book store, ${y.label} shelf`, purchased_on: "2025-12-02",
        unit_cost_cents: kes(450 + Math.floor(hr("bp", name) * 10) * 50), notes: "KICD-approved course book (demo title)." });
      if (loaned) for (const l of perYear.get(yi) ?? []) {
        const day = schoolDaysOf.get(c.termOf(1).id)![1 + Math.floor(hr("bd", l.id) * 4)]!;
        issues.push({ id: uid(`bissue:${l.id}:${name}`), tenant_id: T, item_id: uid(`item:book:${name}`), student_id: l.id, quantity: 1, issued_by: c.storeId,
          issued_at: at(day, "11:00"), due_on: "2026-11-27", condition_out: hr("bc", l.id, name) < 0.7 ? "good" : "fair", status: "out" });
      }
    }
  });
  for (const [title, qty] of [["The Hare and the Baobab Tree (class reader)", 70], ["Safari ya Zawadi (Kiswahili reader)", 60], ["Rain on the Ridge (Grade 7 reader)", 75],
    ["The Lost Herd of Amboseli (Grade 9 reader)", 70], ["Kenya Junior Atlas (library copy)", 45], ["Young Scientists of the Rift (library)", 30]] as [string, number][]) {
    item(`book:${title}`, { name: title, category: "textbooks", quantity: qty, location: "Library", purchased_on: "2025-08-20", unit_cost_cents: kes(380 + Math.floor(hr("lp", title) * 8) * 50) });
  }
  const movements = await hasMovements();
  for (const s of STATIONERY) item(`stationery:${s.name}`, { name: s.name, category: "stationery", location: s.location, unit_cost_cents: kes(s.kes),
    quantity: s.stock, ...(movements ? { unit: s.unit, consumable: true, reorder_level: s.reorder } : {}) });
  for (const k of KITCHEN) item(`kitchen:${k.name}`, { name: k.name, category: "kitchen", location: k.location, unit_cost_cents: kes(k.kes),
    quantity: k.stock, ...(movements ? { unit: k.unit, consumable: true, reorder_level: k.reorder } : {}) });
  await insertMissing("inventory_items", items);
  await insertMissing("inventory_issues", issues);
  await insertMissing("fee_charges", charges);

  // ---------------------------------------------------------------- payments: most families pay on time, some in instalments, a few fall behind
  console.log("  payments…");
  const payments: Row[] = [];
  for (const inv of planned.values()) {
    if (!inv.mine) continue;
    const f = c.familyOf.get(inv.l.id);
    const P = f?.payer ?? "A";
    const total = inv.fees + inv.charges;
    const k = inv.id;
    const frac = P === "A" || P === "B" ? 1 : P === "C" ? 0.5 + 0.35 * hr("fr", k) : hr("fr", k) < 0.3 ? 0 : 0.3 * hr("fr2", k);
    const n = P === "A" ? (hr("n", k) < 0.6 ? 1 : 2) : P === "B" ? 3 + (hr("n", k) < 0.5 ? 1 : 0) : P === "C" ? 2 + (hr("n", k) < 0.5 ? 1 : 0) : 1;
    const target = frac >= 1 ? total : Math.round((total * frac) / 50_000) * 50_000;
    if (target <= 0) continue;
    const len = Date.parse(inv.t.ends_on) / 86_400_000 - Date.parse(inv.t.starts_on) / 86_400_000;
    const payer = f?.guardians.find((g) => g.primary) ?? f?.guardians[0];
    let paid = 0;
    for (let i = 0; i < n; i++) {
      const day = P === "A" ? addDays(inv.t.starts_on, -10 + Math.floor(hr("d", k, i) * 12) + i * 21)
        : P === "B" ? addDays(inv.t.starts_on, -7 + Math.round((i * (len - 20)) / (n - 1)) + Math.floor(hr("d", k, i) * 5))
        : P === "C" ? addDays(inv.t.starts_on, 5 + i * 25 + Math.floor(hr("d", k, i) * 10))
        : addDays(inv.t.starts_on, 20 + Math.floor(hr("d", k, i) * 30));
      if (day > YESTERDAY) break;
      const amount = i === n - 1 ? target - paid : Math.min(target - paid, Math.round(target / n / 50_000) * 50_000);
      if (amount <= 0) continue;
      paid += amount;
      const id = uid(`pay:${k}:${i}`);
      const m = hr("m", k, i);
      const method = m < 0.72 ? "mpesa" : m < 0.95 ? "bank" : "cash";
      const code = BigInt(`0x${id.replace(/-/g, "").slice(0, 12)}`).toString(36).toUpperCase().padStart(8, "0").slice(-6);
      const when = at(day, hm(7 * 60 + Math.floor(hr("t", id) * 13 * 60)));
      payments.push({ id, tenant_id: T, invoice_id: inv.id, amount_cents: amount, method, status: "success", created_at: when, completed_at: when,
        mpesa_receipt: method === "mpesa" ? `DEMO${code}` : null, msisdn: method === "mpesa" && payer?.phone ? payer.phone.slice(1) : null,
        reference: method === "mpesa" ? `DEMO${code}` : method === "bank" ? `DEMO-BANK-${code}` : `DEMO-CASH-${code}`,
        recorded_by: method === "mpesa" ? null : c.bursarId });
    }
  }
  await insertMissing("payments", payments);
  // seed-cbe invoices that were paid in full stay paid after the re-total and any new charges
  if (retotal.some((r) => r.wasPaid)) {
    const now = DRY ? [] : ok(await db.from("fee_invoices").select("id, total_cents, paid_cents").in("id", retotal.filter((r) => r.wasPaid).map((r) => r.inv.id)), "invoices");
    await insertMissing("payments", now.filter((i) => i.total_cents > i.paid_cents).map((i) => ({
      id: uid(`topup:${i.id}`), tenant_id: T, invoice_id: i.id, amount_cents: i.total_cents - i.paid_cents, method: "bank", status: "success",
      reference: `DEMO-TOPUP-${i.id.slice(0, 8)}`, recorded_by: c.bursarId, created_at: at(addDays(TODAY, -3), "11:20"), completed_at: at(addDays(TODAY, -3), "11:20"),
    })));
  }
  if (!DRY) {
    // invoices nothing was paid on yet go overdue after their due date, as the nightly job does
    const { error } = await db.rpc("refresh_invoice_statuses");
    if (error) console.log(`  (refresh_invoice_statuses: ${error.message}; the nightly job will do it)`);
  }

  // ---------------------------------------------------------------- attendance: every school day, taken by the class teacher
  console.log("  attendance…");
  const presentOn = new Map<string, number>();
  for (const t of started) {
    const days = termDays(t, YESTERDAY);
    for (const cls of CLASSES) {
      const ls = c.learnersOf.get(cls.id) ?? [];
      const rows: Row[] = [];
      for (const d of days) {
        let present = 0;
        for (const l of ls) {
          const week = Math.floor((Date.parse(d) - Date.parse("2026-01-01")) / (7 * 86_400_000));
          const sick = hr("sick", l.id, week) < 0.025 && dow(d) >= 1 && dow(d) <= 3;
          const pAbs = sick ? 1 : 0.022 + (oftenAbsent(l.id) ? 0.17 : 0) + (dow(d) === 1 || dow(d) === 5 ? 0.008 : 0) + (d >= "2026-06-08" && d <= "2026-07-31" ? 0.012 : 0);
          const r = hr("att", l.id, d);
          const mark = r < pAbs ? "absent" : r < pAbs + 0.025 ? "late" : r < pAbs + 0.034 ? "excused" : "present";
          if (mark === "present" || mark === "late") present++;
          rows.push({ tenant_id: T, student_id: l.id, class_id: cls.id, term_id: t.id, taken_by: cls.classTeacher, taken_on: d, mark,
            marked_at: at(d, hm(8 * 60 + 2 + Math.floor(hr("mt", cls.id, d) * 25))) });
        }
        presentOn.set(d, (presentOn.get(d) ?? 0) + present);
      }
      await insertIgnore("attendance", rows, "student_id,taken_on");
    }
    console.log(`    Term ${t.index}: ${days.length} school days`);
  }

  // ---------------------------------------------------------------- exams: CAT, mid-term and end-term, marked by the subject teachers
  console.log("  exams and marks…");
  const EXAMS = ["CAT", "Mid-term exam", "End-term exam"];
  const dbExams = ok(await db.from("exams").select("id, term_id, name").eq("tenant_id", T), "exams");
  const examRows: Row[] = [];
  const pubUpdates: { id: string; at: string }[] = [];
  for (const t of started) for (let k = 0; k < 3; k++) {
    const start = EXAM_WEEKS[t.index]?.[k];
    if (!start || start > YESTERDAY) continue;
    const name = `Term ${t.index} ${EXAMS[k]}`;
    const id = uid(`exam:${t.index}:${k}`);
    const ex = dbExams.find((e) => e.term_id === t.id && e.name.toLowerCase() === name.toLowerCase());
    if (ex && ex.id !== id) { console.log(`  ${name} already exists (not this seed's); left alone`); continue; }
    examRows.push({ id, tenant_id: T, term_id: t.id, name, out_of: 100 });
    const latest = addDays(start, 7) > TODAY;   // the end-term just written: still being marked and published
    const pubAt = at(addDays(start, latest ? 6 : 9), "16:30");
    const marks: Row[] = [];
    const pubs: Row[] = [];
    for (const cls of CLASSES.filter((x) => x.level !== "pre_primary")) for (const [code] of cls.codes) {
      const teacher = c.teacherOf.get(`${cls.id}|${code}`)!;
      const partial = latest && hr("partial", cls.id, code) < 0.06;
      const published = !latest || (!partial && hr("pub", cls.id, code) > 0.18);
      for (const l of c.learnersOf.get(cls.id) ?? []) {
        if (partial && hr("pe", l.id, code) < 0.45) continue;
        const r = hr("ma", l.id, code, t.index, k);
        const absence = oftenAbsent(l.id) && r < 0.15 ? "missed" : r < 0.006 ? "excused" : null;
        marks.push({ tenant_id: T, exam_id: id, student_id: l.id, subject_id: c.subjectId(code), score: absence ? null : score(l.id, code, t.index, EXAMS[k]!),
          absence, entered_by: teacher, entered_at: at(addDays(start, 3 + Math.floor(hr("me", cls.id, code, t.index, k) * 4)), "16:00") });
      }
      if (published) pubs.push({ exam_id: id, class_id: cls.id, subject_id: c.subjectId(code), tenant_id: T, published_by: teacher, published_at: pubAt });
    }
    await insertMissing("exams", [examRows[examRows.length - 1]!]);
    await insertIgnore("marks", marks, "exam_id,student_id,subject_id");
    await insertIgnore("mark_publications", pubs, "exam_id,class_id,subject_id");
    if (pubs.length) pubUpdates.push({ id, at: pubAt });
  }
  if (!DRY) for (const p of pubUpdates) await db.from("exams").update({ published_at: p.at }).eq("id", p.id).eq("tenant_id", T);

  // ---------------------------------------------------------------- CBE: strands, rubric assessments, judgements and comments
  console.log("  CBE assessments…");
  const dbStrands = await all<{ id: string; learning_area_id: string; grade: number; parent_id: string | null }>("strands",
    (a, b) => db.from("strands").select("id, learning_area_id, grade, parent_id").eq("tenant_id", T).order("id").range(a, b));
  const strandRows: Row[] = [];
  const topStrands = new Map<string, string[]>();
  for (const cls of CLASSES) for (const [code] of cls.codes) {
    const k = `${code}:${cls.year}`;
    if (topStrands.has(k)) continue;
    const have = dbStrands.filter((s) => s.learning_area_id === c.areaId(code) && s.grade === cls.year && !s.parent_id).map((s) => s.id);
    if (have.length) { topStrands.set(k, have); continue; }
    const names = STRAND_NAMES[code === "SS-MATH" ? "SS-MATH" : code.split("-")[1]!]!;
    const rows = names.map((name, i) => ({ id: uid(`strand:${k}:${name}`), tenant_id: T, learning_area_id: c.areaId(code), grade: cls.year, name, sort_order: (i + 1) * 10,
      source: "Demo data: illustrative, not KICD text" }));
    strandRows.push(...rows);
    topStrands.set(k, rows.map((r) => r.id));
  }
  await insertMissing("strands", strandRows);
  for (const t of started) {
    const days = schoolDaysOf.get(t.id)!;
    for (const cls of CLASSES) {
      const kinds: ["formative" | "summative", string][] = [["formative", days[24] ?? days[days.length - 1]!]];
      if (cls.band === "PP1" || cls.band === "PP2" || cls.band === "LP") kinds.push(["summative", addDays(EXAM_WEEKS[t.index]![2], 1)]);
      const assessments: Row[] = [];
      const results: Row[] = [];
      const comments: Row[] = [];
      for (const [code] of cls.codes) for (const [kind, on] of kinds) {
        if (on > YESTERDAY) continue;
        const teacher = c.teacherOf.get(`${cls.id}|${code}`)!;
        const id = uid(`cbe:${t.index}:${cls.name}:${code}:${kind}`);
        const pub = addDays(on, 6) <= TODAY ? at(addDays(on, 6), "15:00") : null;
        assessments.push({ id, tenant_id: T, term_id: t.id, class_id: cls.id, subject_id: c.subjectId(code), kind, assessed_on: on, published_at: pub, created_by: teacher,
          title: `Term ${t.index} ${kind === "formative" ? "classroom assessment" : "end-of-term assessment"}` });
        const scale = cls.level === "pre_primary" || cls.level === "primary" ? RUBRIC4 : RUBRIC8;
        for (const l of c.learnersOf.get(cls.id) ?? []) {
          for (const strand of topStrands.get(`${code}:${cls.year}`)!) {
            const code2 = level(cls.level, score(l.id, `${code}:${strand}`, t.index, kind));
            results.push({ tenant_id: T, assessment_id: id, student_id: l.id, strand_id: strand, level_code: code2,
              points: scale.length - scale.findIndex(([, x]) => x === code2), entered_by: teacher });
          }
          if (pub && (kind === "summative" || t.index === 3)) {
            const a = ability(l.id);
            const band = a > 0.66 ? "high" : a > 0.33 ? "mid" : "low";
            comments.push({ tenant_id: T, assessment_id: id, student_id: l.id, comment: pickH(COMMENTS[band], "cm", l.id, code, t.index).replace("%s", c.subjectName(code)) });
          }
        }
      }
      await insertMissing("cbe_assessments", assessments);
      await insertIgnore("cbe_results", results, "assessment_id,student_id,strand_id");
      await insertIgnore("cbe_assessment_comments", comments, "assessment_id,student_id");
    }
  }

  await seedSchoolLife(c, movements, presentOn);
}

// ================================================================ stores
type StockLine = { name: string; category: string; unit: string; kes: number; stock: number; reorder: number; location: string };
const KITCHEN: StockLine[] = [
  { name: "Rice (pishori)", category: "kitchen", unit: "kg", kes: 165, stock: 140, reorder: 80, location: "Kitchen dry store" },
  { name: "Beans (rosecoco)", category: "kitchen", unit: "kg", kes: 150, stock: 95, reorder: 60, location: "Kitchen dry store" },
  { name: "Maize flour (sifted)", category: "kitchen", unit: "kg", kes: 72, stock: 210, reorder: 100, location: "Kitchen dry store" },
  { name: "Potatoes", category: "kitchen", unit: "kg", kes: 60, stock: 120, reorder: 50, location: "Kitchen vegetable store" },
  { name: "Cabbages", category: "kitchen", unit: "heads", kes: 45, stock: 60, reorder: 20, location: "Kitchen vegetable store" },
  { name: "Cooking oil", category: "kitchen", unit: "litres", kes: 330, stock: 45, reorder: 30, location: "Kitchen dry store" },
  { name: "Sugar", category: "kitchen", unit: "kg", kes: 165, stock: 70, reorder: 40, location: "Kitchen dry store" },
  { name: "Salt", category: "kitchen", unit: "kg", kes: 40, stock: 25, reorder: 10, location: "Kitchen dry store" },
  { name: "Tea leaves", category: "kitchen", unit: "packets (500 g)", kes: 280, stock: 30, reorder: 15, location: "Kitchen dry store" },
  { name: "Milk", category: "kitchen", unit: "litres", kes: 60, stock: 60, reorder: 40, location: "Kitchen cold room" },
  { name: "Onions", category: "kitchen", unit: "kg", kes: 110, stock: 30, reorder: 15, location: "Kitchen vegetable store" },
  { name: "Tomatoes", category: "kitchen", unit: "kg", kes: 90, stock: 35, reorder: 15, location: "Kitchen vegetable store" },
  { name: "Bread (400 g loaves)", category: "kitchen", unit: "loaves", kes: 65, stock: 40, reorder: 30, location: "Kitchen dry store" },
  { name: "Wheat flour for mandazi", category: "kitchen", unit: "kg", kes: 85, stock: 60, reorder: 30, location: "Kitchen dry store" },
  { name: "Bananas (break-time fruit)", category: "kitchen", unit: "pieces", kes: 10, stock: 300, reorder: 200, location: "Kitchen cold room" },
  { name: "Oranges (break-time fruit)", category: "kitchen", unit: "pieces", kes: 15, stock: 250, reorder: 200, location: "Kitchen cold room" },
  { name: "Fruit juice (pre-primary snack)", category: "kitchen", unit: "litres", kes: 180, stock: 25, reorder: 15, location: "Kitchen cold room" },
];
const STATIONERY: StockLine[] = [
  { name: "Exercise books, 96 pages", category: "stationery", unit: "pieces", kes: 55, stock: 1_800, reorder: 600, location: "Main store" },
  { name: "Exercise books, 200 pages", category: "stationery", unit: "pieces", kes: 110, stock: 900, reorder: 300, location: "Main store" },
  { name: "A4 printing paper", category: "stationery", unit: "reams", kes: 650, stock: 85, reorder: 40, location: "Main store" },
  { name: "Printer toner (HP 26A)", category: "stationery", unit: "cartridges", kes: 6_500, stock: 6, reorder: 3, location: "Main store" },
  { name: "White chalk", category: "stationery", unit: "boxes", kes: 120, stock: 70, reorder: 30, location: "Main store" },
  { name: "Whiteboard markers", category: "stationery", unit: "pieces", kes: 90, stock: 160, reorder: 60, location: "Main store" },
  { name: "Ballpoint pens (blue)", category: "stationery", unit: "pieces", kes: 20, stock: 600, reorder: 200, location: "Main store" },
  { name: "HB pencils", category: "stationery", unit: "pieces", kes: 15, stock: 800, reorder: 300, location: "Main store" },
  { name: "30 cm rulers", category: "stationery", unit: "pieces", kes: 35, stock: 300, reorder: 100, location: "Main store" },
  { name: "Exam answer booklets", category: "stationery", unit: "pieces", kes: 25, stock: 2_500, reorder: 1_500, location: "Exams office" },
  { name: "Poster paint (assorted)", category: "stationery", unit: "bottles (500 ml)", kes: 380, stock: 60, reorder: 20, location: "Art room" },
  { name: "Powder paint (assorted)", category: "stationery", unit: "tins (1 kg)", kes: 650, stock: 25, reorder: 10, location: "Art room" },
  { name: "Paint brushes", category: "stationery", unit: "pieces", kes: 60, stock: 220, reorder: 80, location: "Art room" },
  { name: "Wax crayons (12 colours)", category: "stationery", unit: "packets", kes: 110, stock: 260, reorder: 100, location: "Art room" },
  { name: "Manila paper", category: "stationery", unit: "sheets", kes: 25, stock: 700, reorder: 250, location: "Art room" },
];
const LAB: StockLine[] = [
  { name: "Test tubes (borosilicate)", category: "lab_equipment", unit: "pieces", kes: 45, stock: 420, reorder: 150, location: "Chemistry lab prep room" },
  { name: "Litmus paper (red and blue)", category: "lab_equipment", unit: "packets", kes: 150, stock: 60, reorder: 20, location: "Chemistry lab prep room" },
  { name: "Filter paper (12.5 cm)", category: "lab_equipment", unit: "packets", kes: 350, stock: 35, reorder: 15, location: "Chemistry lab prep room" },
  { name: "Dilute hydrochloric acid (2 M)", category: "lab_equipment", unit: "litres", kes: 900, stock: 12, reorder: 5, location: "Chemicals cabinet" },
  { name: "Sodium hydroxide pellets", category: "lab_equipment", unit: "packs (500 g)", kes: 1_200, stock: 8, reorder: 3, location: "Chemicals cabinet" },
  { name: "Copper(II) sulphate", category: "lab_equipment", unit: "packs (500 g)", kes: 1_400, stock: 6, reorder: 2, location: "Chemicals cabinet" },
  { name: "Methylated spirit", category: "lab_equipment", unit: "litres", kes: 450, stock: 20, reorder: 8, location: "Chemicals cabinet" },
  { name: "Lab gas (LPG, 13 kg)", category: "lab_equipment", unit: "cylinders", kes: 3_400, stock: 4, reorder: 2, location: "Gas cage, science block" },
  { name: "Microscope slides and cover slips", category: "lab_equipment", unit: "boxes", kes: 550, stock: 30, reorder: 10, location: "Biology lab" },
];
const MEDICAL: StockLine[] = [
  { name: "Paracetamol 500 mg tablets", category: "medical", unit: "tablets", kes: 2, stock: 0, reorder: 200, location: "Sick bay, locked cabinet" },
  { name: "Paracetamol 120 mg dispersible tablets (children)", category: "medical", unit: "tablets", kes: 3, stock: 0, reorder: 200, location: "Sick bay, locked cabinet" },
  { name: "Ibuprofen 200 mg tablets", category: "medical", unit: "tablets", kes: 3, stock: 0, reorder: 100, location: "Sick bay, locked cabinet" },
  { name: "Cetirizine 5 mg tablets (antihistamine)", category: "medical", unit: "tablets", kes: 5, stock: 0, reorder: 60, location: "Sick bay, locked cabinet" },
  { name: "Oral rehydration salts (ORS)", category: "medical", unit: "sachets", kes: 25, stock: 0, reorder: 40, location: "Sick bay, locked cabinet" },
  { name: "Antiseptic solution (povidone-iodine)", category: "medical", unit: "sachets (10 ml)", kes: 30, stock: 0, reorder: 40, location: "Sick bay" },
  { name: "Adhesive plasters", category: "medical", unit: "pieces", kes: 5, stock: 0, reorder: 150, location: "Sick bay" },
  { name: "Sterile gauze pads", category: "medical", unit: "pieces", kes: 12, stock: 0, reorder: 100, location: "Sick bay" },
  { name: "Crepe bandages (7.5 cm)", category: "medical", unit: "rolls", kes: 90, stock: 0, reorder: 15, location: "Sick bay" },
  { name: "Cotton wool (400 g)", category: "medical", unit: "rolls", kes: 250, stock: 14, reorder: 5, location: "Sick bay" },
  { name: "Examination gloves", category: "medical", unit: "boxes (100)", kes: 650, stock: 18, reorder: 6, location: "Sick bay" },
  { name: "Thermometer probe covers", category: "medical", unit: "boxes (200)", kes: 900, stock: 7, reorder: 3, location: "Sick bay" },
  { name: "Instant ice packs", category: "medical", unit: "pieces", kes: 120, stock: 0, reorder: 15, location: "Sick bay" },
];
const ASSETS: [string, string, string, number, string][] = [
  ["Epson classroom projector", "KRA-ICT-001", "ict", 68_000, "Grade 10 Fig room"], ["Epson classroom projector", "KRA-ICT-002", "ict", 68_000, "School hall"],
  ["Staffroom laptop (HP ProBook)", "KRA-ICT-010", "ict", 85_000, "Staffroom"], ["Staffroom laptop (HP ProBook)", "KRA-ICT-011", "ict", 85_000, "Staffroom"],
  ["Bursar's office desktop computer", "KRA-ICT-020", "ict", 72_000, "Bursar's office"], ["Laser printer (HP LaserJet)", "KRA-ICT-030", "ict", 38_000, "School office"],
  ["Compound microscope", "KRA-LAB-001", "lab_equipment", 24_000, "Biology lab"], ["Compound microscope", "KRA-LAB-002", "lab_equipment", 24_000, "Biology lab"],
  ["Compound microscope", "KRA-LAB-003", "lab_equipment", 24_000, "Junior science lab"], ["Electronic balance (0.01 g)", "KRA-LAB-010", "lab_equipment", 32_000, "Chemistry lab"],
  ["Electronic balance (0.01 g)", "KRA-LAB-011", "lab_equipment", 32_000, "Physics lab"], ["Burette set (50 ml, class set of 20)", "KRA-LAB-020", "lab_equipment", 28_000, "Chemistry lab"],
  ["Digital piano (Yamaha)", "KRA-MUS-001", "music", 95_000, "Music room"], ["Drum set (school band)", "KRA-MUS-002", "music", 78_000, "Music room"],
  ["Football goalposts (pair)", "KRA-SPT-001", "sports", 60_000, "Field"], ["Rugby tackle bags (set of 6)", "KRA-SPT-002", "sports", 45_000, "Sports store"],
  ["Industrial gas cooker, 6 burner", "KRA-KIT-001", "kitchen", 140_000, "Kitchen"], ["Chest freezer 500 L", "KRA-KIT-002", "kitchen", 72_000, "Kitchen cold room"],
  ["Staffroom conference table", "KRA-FUR-001", "furniture", 55_000, "Staffroom"], ["Head teacher's office desk", "KRA-FUR-002", "furniture", 42_000, "Head teacher's office"],
];
const OTHER_STOCK: StockLine[] = [
  { name: "Footballs (size 5)", category: "sports", unit: "pieces", kes: 2_200, stock: 24, reorder: 8, location: "Sports store" },
  { name: "Rugby balls", category: "sports", unit: "pieces", kes: 2_800, stock: 12, reorder: 4, location: "Sports store" },
  { name: "Netballs", category: "sports", unit: "pieces", kes: 2_000, stock: 10, reorder: 4, location: "Sports store" },
  { name: "Learner desks and chairs (sets)", category: "furniture", unit: "sets", kes: 6_500, stock: 1_060, reorder: 0, location: "Classrooms" },
  { name: "Recorders (descant)", category: "music", unit: "pieces", kes: 900, stock: 45, reorder: 10, location: "Music room" },
];

/** The stock-movements feature (inventory_movements) is there, i.e. pass 2. */
async function hasMovements(): Promise<boolean> {
  const { error } = await db.from("inventory_movements").select("id", { head: true, count: "exact" }).limit(1);
  return !error;
}

// ================================================================ school life
const ANNOUNCEMENTS: { on: string; by: "head" | "deputy" | "bursar" | "games"; to: Row; subject: string; body: string }[] = [
  { on: "2025-12-15", by: "head", to: { kind: "role", role: "parent" }, subject: "Term 1 opens on Monday 5 January 2026",
    body: "Welcome back! Term 1 opens on Monday 5 January. Learners report by 7:45 am in full school uniform. Grade 10 boarders report on Sunday 4 January between 2 pm and 5 pm." },
  { on: "2025-12-18", by: "bursar", to: { kind: "role", role: "parent" }, subject: "Term 1 fee structure and payment options",
    body: "The 2026 fee structure for each section is now in the parent app under Fees. Fees are due by Friday 23 January. Pay by M-Pesa from the app or by bank deposit; please always use your child's admission number as the reference." },
  { on: "2026-01-05", by: "head", to: { kind: "whole_school" }, subject: "Happy new year and welcome to 2026",
    body: "A warm welcome to our new families and to everyone returning. This year we run two streams in every grade from PP1 to Grade 12. Our theme for the year is 'Grow, serve, excel'." },
  { on: "2026-01-12", by: "deputy", to: { kind: "roles", roles: ["school_admin", "teacher", "driver", "staff"] }, subject: "Staff briefing: Term 1 assessment calendar",
    body: "CATs run 27 to 29 January, mid-term exams 18 to 20 February and end-term exams 16 to 20 March. Enter marks within a week of each paper and publish them from the Gradebook." },
  { on: "2026-01-20", by: "bursar", to: { kind: "role", role: "parent" }, subject: "Reminder: Term 1 fees due this Friday",
    body: "Term 1 fees are due on Friday 23 January. If you need to pay in instalments, please speak to the bursar's office; we would rather agree a plan than have a learner miss lessons." },
  { on: "2026-01-22", by: "deputy", to: { kind: "role", role: "parent" }, subject: "CAT week: 27 to 29 January",
    body: "Grade 1 to Grade 12 sit their first continuous assessment tests next week. Please make sure your child has a pen, pencil, ruler and calculator (Grade 7 upwards)." },
  { on: "2026-02-13", by: "head", to: { kind: "role", role: "parent" }, subject: "Half-term break: 25 to 27 February",
    body: "Half-term break runs from Wednesday 25 to Friday 27 February. Learners return on Monday 2 March. Buses run their usual routes on Tuesday 24 February." },
  { on: "2026-03-06", by: "head", to: { kind: "role", role: "parent" }, subject: "Parents' consultation day: Saturday 14 March",
    body: "Meet your child's class teacher and subject teachers from 9 am to 1 pm. We will go through the mid-term results and the plan for the end-term exams. Tea will be served in the hall." },
  { on: "2026-03-10", by: "deputy", to: { kind: "whole_school" }, subject: "End-term exam timetable: 16 to 20 March",
    body: "The end-term exam timetable for every grade is on the notice board and in the app. Exams start at 8:00 am sharp; latecomers will not get extra time." },
  { on: "2026-03-24", by: "head", to: { kind: "role", role: "parent" }, subject: "Term 1 closes on Friday 27 March",
    body: "School closes at 12:30 pm on Friday 27 March. Report forms will be in the app the same afternoon. Term 2 opens on Monday 4 May." },
  { on: "2026-04-27", by: "bursar", to: { kind: "role", role: "parent" }, subject: "Term 2 fees and any balance carried from Term 1",
    body: "Term 2 invoices are in the app. Families with a Term 1 balance, please clear it or agree a payment plan with the bursar's office before Friday 22 May." },
  { on: "2026-05-04", by: "head", to: { kind: "whole_school" }, subject: "Welcome to Term 2",
    body: "Welcome back. This term: the inter-house sports competition, the Grade 7-9 science fair and the music festival heats. Please remember the cold season is coming; send a school sweater every day." },
  { on: "2026-05-20", by: "games", to: { kind: "form_level", level: "junior_secondary", form_level: 8, recipients: "both" }, subject: "Grade 8 science fair: projects due 12 June",
    body: "Groups present a working model on any Integrated Science strand. Projects are judged on Friday 12 June in the hall." },
  { on: "2026-06-15", by: "head", to: { kind: "role", role: "parent" }, subject: "Flu season: keep learners with a fever at home",
    body: "We have more colds and flu than usual this month. Please keep a child with a fever at home and let the class teacher know. The school nurse is available in the sick bay all day." },
  { on: "2026-06-19", by: "head", to: { kind: "role", role: "parent" }, subject: "Half-term break: 24 to 26 June",
    body: "Half-term break runs from Wednesday 24 to Friday 26 June. School resumes on Monday 29 June." },
  { on: "2026-07-03", by: "games", to: { kind: "whole_school" }, subject: "Inter-house sports day: Friday 10 July",
    body: "All four houses compete in athletics, football, netball and rugby. Parents are welcome from 10 am; lunch is served to visitors at 1 pm." },
  { on: "2026-07-14", by: "deputy", to: { kind: "whole_school" }, subject: "End-term exams: 20 to 24 July",
    body: "The Term 2 end-term exam timetable is now in the app. Revision timetables have been shared by the class teachers." },
  { on: "2026-07-28", by: "head", to: { kind: "role", role: "parent" }, subject: "Term 2 closes on Friday 31 July",
    body: "School closes at 12:30 pm on Friday 31 July. Term 3 opens on Monday 31 August. Holiday reading lists are attached to each class's notices." },
  { on: "2026-08-24", by: "bursar", to: { kind: "role", role: "parent" }, subject: "Term 3 fees due by Friday 18 September",
    body: "Term 3 invoices are in the parent app. Please clear any balance from Terms 1 and 2 as well. M-Pesa payments from the app reflect on your statement immediately." },
  { on: "2026-08-31", by: "head", to: { kind: "whole_school" }, subject: "Welcome to Term 3",
    body: "Welcome to the final term of 2026. Grade 12 learners sit their final school assessments in November; let us support them." },
  { on: "2026-09-16", by: "deputy", to: { kind: "role", role: "parent" }, subject: "CAT week: 22 to 24 September", body: "Grade 1 to Grade 12 sit Term 3 CATs from Tuesday 22 to Thursday 24 September." },
  { on: "2026-09-25", by: "bursar", to: { kind: "role", role: "parent" }, subject: "Fee balances: a gentle reminder",
    body: "Term 3 fees were due on 18 September. If you have a balance, please pay or agree a plan with the bursar's office this week. Thank you to the many families who have already cleared." },
  { on: "2026-10-16", by: "head", to: { kind: "role", role: "parent" }, subject: "Mashujaa Day and half-term: 20 to 23 October",
    body: "School is closed on Tuesday 20 October (Mashujaa Day) and for half-term from Wednesday 21 to Friday 23 October. Learners return on Monday 26 October." },
  { on: "2026-11-04", by: "games", to: { kind: "whole_school" }, subject: "Sports day and parents' day: Friday 13 November",
    body: "Our annual sports day doubles as parents' day this year. Gates open at 9 am; races start at 10 am. Visitors please sign in at the gate. Lunch is served to everyone at 1 pm." },
  { on: "2026-11-10", by: "deputy", to: { kind: "whole_school" }, subject: "End-term exams: 16 to 20 November",
    body: "Term 3 end-term exams run from Monday 16 to Friday 20 November. Results will be published in the app as soon as each subject is marked." },
  { on: "2026-11-14", by: "head", to: { kind: "whole_school" }, subject: "Thank you for a wonderful sports day",
    body: "Thank you to the more than 200 parents and guests who joined us yesterday, and congratulations to Simba House, this year's champions." },
  { on: "2026-11-19", by: "head", to: { kind: "role", role: "parent" }, subject: "Closing day: Friday 27 November",
    body: "Term 3 closes at 12:30 pm on Friday 27 November with the prize-giving assembly at 10 am, to which all parents are invited. Report forms will be in the app that afternoon." },
  { on: "2026-11-21", by: "bursar", to: { kind: "role", role: "parent" }, subject: "Please clear balances before closing day",
    body: "Report forms are released to every family. If your account has a balance, please clear it or agree a plan with the bursar's office before Friday 27 November." },
];

const ACTIVITIES: { name: string; category: string; band: Band[]; schedule: string; description: string }[] = [
  { name: "Music and movement", category: "arts", band: ["PP1", "PP2"], schedule: "Tuesdays and Thursdays, 11:00", description: "Songs, rhymes and dance for pre-primary." },
  { name: "Swimming", category: "sport", band: ["PP1", "PP2", "LP"], schedule: "Fridays, 14:00 (pool sessions by class)", description: "Learn-to-swim lessons with a qualified instructor." },
  { name: "Chess club", category: "club", band: ["LP"], schedule: "Wednesdays, 15:20", description: "Chess for Grade 1-3." },
  { name: "Scouts and Girl Guides", category: "club", band: ["UP"], schedule: "Wednesdays, 15:20", description: "Kenya Scouts and Girl Guides troops for Grade 4-6." },
  { name: "School band and choir", category: "arts", band: ["UP"], schedule: "Fridays, 15:20", description: "Instrument lessons, band and choir; music festival entries." },
  { name: "Robotics club", category: "club", band: ["JS"], schedule: "Wednesdays, 15:20", description: "Build and program robots; regional robotics challenge." },
  { name: "Drama club", category: "arts", band: ["JS"], schedule: "Fridays, 15:20", description: "Plays and set pieces for the drama festival." },
  { name: "Football", category: "sport", band: ["JS"], schedule: "Mondays and Thursdays, 15:20", description: "Boys' and girls' football teams." },
  { name: "Rugby", category: "sport", band: ["SS"], schedule: "Tuesdays and Thursdays, 15:20", description: "Sevens and fifteens; schools league." },
  { name: "Coding club", category: "club", band: ["SS"], schedule: "Wednesdays, 15:20", description: "Python, web projects and the national coding challenge." },
  { name: "Debate club", category: "club", band: ["SS"], schedule: "Fridays, 15:20", description: "Parliamentary debating; inter-school debates." },
];

const COMPLAINTS: { complaint: string; assessment: string; treatment: string; med?: [string, string, number][]; outcome: string; games?: boolean; season?: boolean; weight: number }[] = [
  { complaint: "Headache", assessment: "Mild headache; no fever. Drank little water today.", treatment: "Rest and water.", med: [["PARA", "Paracetamol", 2]], outcome: "class", weight: 22 },
  { complaint: "Cold symptoms: runny nose and sneezing", assessment: "Common cold; temperature normal.", treatment: "Warm water; advised to keep a sweater on.", med: [["CET", "Cetirizine 5 mg", 1]], outcome: "class", season: true, weight: 18 },
  { complaint: "Fever and body aches", assessment: "Temperature raised; flu-like illness.", treatment: "Rested in the sick bay; parent called to collect.", med: [["PARA", "Paracetamol", 2]], outcome: "home", season: true, weight: 8 },
  { complaint: "Stomach ache", assessment: "Mild stomach upset; no vomiting.", treatment: "Rest and oral rehydration salts.", med: [["ORS", "Oral rehydration salts", 1]], outcome: "rest", weight: 10 },
  { complaint: "Grazed knee during games", assessment: "Superficial graze, cleaned.", treatment: "Cleaned and dressed.", med: [["ANT", "Povidone-iodine antiseptic", 1], ["PLA", "Adhesive plaster", 2]], outcome: "class", games: true, weight: 14 },
  { complaint: "Twisted ankle at football", assessment: "Mild sprain; walking with a slight limp.", treatment: "Ice pack and crepe bandage; rest from games this week.", med: [["ICE", "Instant ice pack", 1], ["BAN", "Crepe bandage", 1], ["IBU", "Ibuprofen 200 mg", 1]], outcome: "rest", games: true, weight: 6 },
  { complaint: "Nosebleed in class", assessment: "Nosebleed stopped after ten minutes of pressure.", treatment: "Pressure and gauze.", med: [["GAU", "Sterile gauze pad", 2]], outcome: "class", weight: 5 },
  { complaint: "Small cut on finger in the art room", assessment: "Small clean cut.", treatment: "Cleaned and covered.", med: [["ANT", "Povidone-iodine antiseptic", 1], ["PLA", "Adhesive plaster", 1]], outcome: "class", weight: 6 },
  { complaint: "Toothache", assessment: "Discomfort in a back tooth.", treatment: "Pain relief; parent advised to book a dental check-up.", med: [["PARA", "Paracetamol", 2]], outcome: "class", weight: 4 },
  { complaint: "Itchy eyes and sneezing (dust)", assessment: "Mild allergy symptoms.", treatment: "Washed face; antihistamine.", med: [["CET", "Cetirizine 5 mg", 1]], outcome: "class", weight: 4 },
  { complaint: "Fall on the field: painful wrist", assessment: "Swelling over the wrist; possible fracture to rule out.", treatment: "Splinted and ice pack; parent informed and taken for an X-ray.", med: [["ICE", "Instant ice pack", 1]], outcome: "hospital", games: true, weight: 1 },
];
const MED_ITEM: Record<string, string> = { PARA: "Paracetamol 500 mg tablets", CET: "Cetirizine 5 mg tablets (antihistamine)", ORS: "Oral rehydration salts (ORS)",
  ANT: "Antiseptic solution (povidone-iodine)", PLA: "Adhesive plasters", ICE: "Instant ice packs", BAN: "Crepe bandages (7.5 cm)", IBU: "Ibuprofen 200 mg tablets", GAU: "Sterile gauze pads" };

async function seedSchoolLife(c: Ctx, movements: boolean, presentOn: Map<string, number>) {
  const { T, terms, learners } = c;
  const started = terms.filter((t) => t.starts_on <= TODAY);
  const staff = ok(await db.from("profiles").select("id, role, staff_title").eq("tenant_id", T).in("role", ["school_admin", "teacher", "staff", "driver"]), "staff");
  const nurse = staff.find((p) => p.id === uid("person:SF-0112")) ?? staff.find((p) => p.role === "staff" && /nurse/i.test(p.staff_title ?? "")) ?? c.head;

  // ---------------------------------------------------------------- clubs and sports, with the learners whose fees pay for them
  console.log("  activities, notices, sick bay…");
  const existingActs = ok(await db.from("activities").select("id, name").eq("tenant_id", T), "activities");
  const acts: Row[] = [], members: Row[] = [], patrons: Row[] = [], events: Row[] = [];
  for (const a of ACTIVITIES) {
    const id = uid(`activity:${a.name}`);
    const ex = existingActs.find((x) => x.name.trim().toLowerCase() === a.name.toLowerCase());
    if (ex && ex.id !== id) continue;
    acts.push({ id, tenant_id: T, name: a.name, category: a.category, description: a.description, meeting_schedule: a.schedule, active: true, created_by: c.gamesId });
    const ls = learners.filter((l) => a.band.includes(l.cls.band));
    for (const l of ls) members.push({ activity_id: id, student_id: l.id, tenant_id: T, joined_on: "2026-01-12", role: hr("cap", a.name, l.id) < 0.01 ? "Captain" : null });
    const pat = [...c.teacherById.values()].filter((t) => t.teaches.some((p) => a.band.includes(p.cls.band))).sort((x, y) => hr("pat", a.name, x.id) - hr("pat", a.name, y.id))[0];
    if (pat) patrons.push({ activity_id: id, teacher_id: pat.id, tenant_id: T });
  }
  const ev = (act: string, title: string, kind: string, lvl: string, day: string, extra: Row = {}) => {
    const starts = at(day, "14:00");
    events.push({ id: uid(`event:${act}:${title}`), tenant_id: T, activity_id: uid(`activity:${act}`), title, kind, level: lvl, starts_at: starts, ends_at: at(day, "17:00"),
      status: day < TODAY ? "completed" : "scheduled", notified_at: starts, created_by: c.gamesId, ...extra });
  };
  ev("Football", "Sub-county schools football, round 1", "fixture", "sub_county", "2026-02-12", { opponent: "Hillcrest Junior (demo)", score: "2-1", outcome: "won", venue: "Kijani Ridge field" });
  ev("Rugby", "Schools sevens league", "fixture", "county", "2026-06-11", { opponent: "Nairobi West Academy (demo)", score: "17-12", outcome: "won", venue: "Away" });
  ev("Drama club", "County drama festival", "performance", "county", "2026-03-05", { position: 2, venue: "County hall" });
  ev("Robotics club", "Regional robotics challenge", "competition", "regional", "2026-07-09", { position: 3, venue: "Regional STEM centre" });
  ev("Debate club", "Inter-school debate: technology in schools", "competition", "zonal", "2026-10-08", { position: 1, venue: "Kijani Ridge hall" });
  ev("School band and choir", "Music festival heats", "performance", "sub_county", "2026-06-18", { position: 1, venue: "Sub-county music centre" });
  await insertMissing("activities", acts);
  await insertIgnore("activity_members", members, "activity_id,student_id");
  await insertIgnore("activity_patrons", patrons, "activity_id,teacher_id");
  await insertMissing("activity_events", events);

  // ---------------------------------------------------------------- a year of notices, in-app only (no push is sent: that is an edge function the apps call)
  const authorOf = { head: c.head.id, deputy: c.deputyId, bursar: c.bursarId, games: c.gamesId };
  await insertMissing("announcements", ANNOUNCEMENTS.filter((a) => a.on <= TODAY).map((a) => ({
    id: uid(`ann:${a.subject}`), tenant_id: T, author_id: authorOf[a.by], subject: a.subject, body: a.body, audience: a.to, channels: ["in_app"],
    published_at: at(a.on, "16:00"), created_at: at(a.on, "15:30"),
  })));

  // ---------------------------------------------------------------- sick bay: a year of visits by learners, medicines taken off stock
  const visits: Row[] = [], meds: Row[] = [];
  const medUse = new Map<string, number>();
  const weights = COMPLAINTS.reduce((s, x) => s + x.weight, 0);
  for (const t of started) for (const d of termDays(t, YESTERDAY)) {
    const season = d >= "2026-06-01" && d <= "2026-07-31";
    const n = 2 + Math.floor(hr("sbn", d) * (season ? 5 : 3)) + (dow(d) === 2 || dow(d) === 4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      let r = hr("sbc", d, i) * weights;
      let cx = COMPLAINTS[0]!;
      for (const x of COMPLAINTS) { if ((r -= x.weight) < 0) { cx = x; break; } }
      if (cx.games && !(dow(d) === 2 || dow(d) === 4 || dow(d) === 1)) cx = COMPLAINTS[0]!;
      if (cx.season && !season && hr("sbs", d, i) < 0.5) cx = COMPLAINTS[0]!;
      const l = learners[Math.floor(hr("sbl", d, i) * learners.length)]!;
      const young = l.cls.level === "pre_primary" || (l.cls.level === "primary" && l.cls.year <= 6);
      const id = uid(`sickbay:${d}:${i}`);
      const inAt = cx.games ? hm(15 * 60 + 25 + Math.floor(hr("sbt", id) * 50)) : hm(8 * 60 + 30 + Math.floor(hr("sbt", id) * 400));
      const mins = Number(inAt.slice(0, 2)) * 60 + Number(inAt.slice(3));
      const fever = cx.complaint.startsWith("Fever");
      visits.push({ id, tenant_id: T, student_id: l.id, time_in: at(d, inAt), time_out: at(d, hm(Math.min(mins + 20 + Math.floor(hr("sbo", id) * 70), 17 * 60 + 30))),
        complaint: cx.complaint, temperature_c: fever ? 38 + Math.floor(hr("tmp", id) * 9) / 10 : 36.4 + Math.floor(hr("tmp", id) * 6) / 10,
        pulse_bpm: 72 + Math.floor(hr("pls", id) * 30), observations: "Demo record.", assessment: cx.assessment, treatment: cx.treatment, outcome: cx.outcome,
        referred_to: cx.outcome === "hospital" ? "Ridgeway Community Health Centre (demo)" : null,
        follow_up: cx.outcome === "home" || cx.outcome === "hospital" ? "Class teacher informed; check on the learner when back." : null, logged_by: nurse.id });
      (cx.med ?? []).forEach(([k, drug, q], mi) => {
        const itemName = k === "PARA" && young ? "Paracetamol 120 mg dispersible tablets (children)" : k === "IBU" && young ? null : MED_ITEM[k]!;
        if (!itemName) return;
        meds.push({ id: uid(`med:${id}:${mi}`), tenant_id: T, visit_id: id, drug: itemName === MED_ITEM[k] ? drug : "Paracetamol 120 mg (children)",
          dose: q > 1 ? `${q} ${/tablet|plaster|gauze/i.test(itemName) ? "pieces" : "units"}` : "1", given_at: at(d, inAt), given_by: nurse.id,
          inventory_item_id: uid(`item:medical:${itemName}`), stock_quantity: q });
        medUse.set(itemName, (medUse.get(itemName) ?? 0) + q);
      });
    }
  }
  // the medical stock lines hold the year's use plus what is on the shelf today, so nothing goes below zero
  await insertMissing("inventory_items", MEDICAL.map((m) => ({
    id: uid(`item:medical:${m.name}`), tenant_id: T, name: m.name, category: "medical", tracking: "stock", condition: "good", location: m.location,
    unit_cost_cents: kes(m.kes), quantity: (medUse.get(m.name) ?? 0) + Math.max(m.stock, m.reorder + Math.floor(hr("ms", m.name) * m.reorder)),
    ...(movements ? { unit: m.unit, consumable: true, reorder_level: m.reorder } : {}),
  })));
  const newVisits = await insertMissing("sick_bay_visits", visits);
  await insertMissing("visit_medications", meds);
  if (!DRY && newVisits.length) {
    // the in-app notices the visits raised for guardians: already read and handled, so nothing waits to be pushed
    for (const ids of chunks(newVisits.map((v) => v.id as string), 150)) {
      await db.from("medical_notices").update({ read_at: NOW_ISO, pushed_at: NOW_ISO }).in("visit_id", ids).eq("tenant_id", T);
    }
  }

  // ---------------------------------------------------------------- other stores: lab consumables, sports, furniture, music
  await insertMissing("inventory_items", [...LAB, ...OTHER_STOCK].map((s) => ({
    id: uid(`item:${s.category}:${s.name}`), tenant_id: T, name: s.name, category: s.category, tracking: "stock", condition: "good", location: s.location,
    unit_cost_cents: kes(s.kes), quantity: s.stock,
    ...(movements && s.category === "lab_equipment" ? { unit: s.unit, consumable: true, reorder_level: s.reorder } : {}),
  })));
  await insertMissing("inventory_items", ASSETS.map(([name, tag, cat, cost, loc]) => ({
    id: uid(`item:asset:${tag}`), tenant_id: T, name, category: cat, tracking: "asset", quantity: 1, asset_tag: tag, condition: "good", location: loc,
    purchased_on: "2025-01-15", unit_cost_cents: kes(cost),
  })));

  // ---------------------------------------------------------------- visitors
  // The visitor log stamps arrival with the time of the insert (visits_stamp), so past visits can't be written through the API.
  // Today's expected visitors are seeded; the sports day's 200 guests are in the kitchen's meals_served (pass 2).
  const expected = ["Delivery: Ridgeway Grain Traders (demo)", "Meeting with the bursar", "Parent: meeting with the class teacher", "County quality assurance officer"];
  await insertMissing("visits", expected.map((purpose, i) => ({
    id: uid(`visit:${TODAY}:${i}`), tenant_id: T, visitor_name: personName(i % 2 ? "female" : "male", pickH(SURNAMES, "vs", TODAY, i), "visitor", TODAY, i),
    visitor_phone: fakePhone(900_000 + i), purpose, host_kind: "office", entry_point: "gate", status: "expected", note: "Demo record.",
  })));

  if (movements) await seedMovements(c, presentOn);
  else console.log("  inventory_movements isn't here yet: stock lines only (run again once the stock feature is deployed)");
}

// ================================================================ pass 2: stock in and out (only when inventory_movements exists)
type Purpose = "Breakfast" | "Break tea" | "Lunch" | "Supper" | "Pre-primary snack";
type Flow = { key: string; uses?: Partial<Record<Purpose, number>>; every: "daily" | "twice" | "weekly" | "fortnightly" | "monthly"; pack: number; supplier: string };
const SUP = { grain: "Ridgeway Grain Traders (demo)", produce: "Mavuno Fresh Produce (demo)", dairy: "Baraka Dairy Co-operative (demo)",
  whole: "Tumaini Wholesalers (demo)", bakery: "Mkate Bora Bakery (demo)", books: "Jamhuri Stationers (demo)", lab: "Elimu Scientific Supplies (demo)", pharm: "Afya Pharmaceuticals (demo)" };
// per head per meal; the rice lunch is a fixed ~20 kg on a normal day (see qty())
const KITCHEN_FLOW: Flow[] = [
  { key: "Rice (pishori)", uses: { Lunch: 0, Supper: 0.11 }, every: "weekly", pack: 50, supplier: SUP.grain },
  { key: "Beans (rosecoco)", uses: { Lunch: 0.022, Supper: 0.08 }, every: "fortnightly", pack: 50, supplier: SUP.grain },
  { key: "Maize flour (sifted)", uses: { Breakfast: 0.05, Lunch: 0.03, Supper: 0.1 }, every: "weekly", pack: 24, supplier: SUP.grain },
  { key: "Potatoes", uses: { Lunch: 0.02, Supper: 0.06 }, every: "weekly", pack: 50, supplier: SUP.produce },
  { key: "Cabbages", uses: { Lunch: 0.036, Supper: 0.033 }, every: "twice", pack: 10, supplier: SUP.produce },
  { key: "Cooking oil", uses: { Lunch: 0.004, Supper: 0.006 }, every: "fortnightly", pack: 20, supplier: SUP.whole },
  { key: "Sugar", uses: { Breakfast: 0.03, "Break tea": 0.012 }, every: "fortnightly", pack: 50, supplier: SUP.grain },
  { key: "Salt", uses: { Lunch: 0.0012, Supper: 0.003 }, every: "monthly", pack: 10, supplier: SUP.grain },
  { key: "Tea leaves", uses: { Breakfast: 0.006, "Break tea": 0.003 }, every: "fortnightly", pack: 20, supplier: SUP.whole },
  { key: "Milk", uses: { Breakfast: 0.25, "Break tea": 0.1 }, every: "daily", pack: 10, supplier: SUP.dairy },
  { key: "Onions", uses: { Lunch: 0.006, Supper: 0.015 }, every: "weekly", pack: 10, supplier: SUP.produce },
  { key: "Tomatoes", uses: { Lunch: 0.008, Supper: 0.02 }, every: "twice", pack: 10, supplier: SUP.produce },
  { key: "Bread (400 g loaves)", uses: { Breakfast: 0.125 }, every: "daily", pack: 10, supplier: SUP.bakery },
  { key: "Wheat flour for mandazi", uses: { "Break tea": 0.008 }, every: "weekly", pack: 24, supplier: SUP.grain },
  { key: "Bananas (break-time fruit)", uses: { "Break tea": 0.3 }, every: "twice", pack: 50, supplier: SUP.produce },
  { key: "Oranges (break-time fruit)", uses: { Lunch: 0.25 }, every: "twice", pack: 50, supplier: SUP.produce },
  { key: "Fruit juice (pre-primary snack)", uses: { "Pre-primary snack": 0.1 }, every: "weekly", pack: 10, supplier: SUP.whole },
];
// weekly use (on the last school day of the week) for the other stores
const WEEKLY: { key: string; cat: string; per: number; purpose: string; every: number; supplier: string; pack: number; dow?: number }[] = [
  { key: "Exercise books, 96 pages", cat: "stationery", per: 120, purpose: "Classes", every: 1, supplier: SUP.books, pack: 100 },
  { key: "Exercise books, 200 pages", cat: "stationery", per: 60, purpose: "Classes", every: 1, supplier: SUP.books, pack: 50 },
  { key: "A4 printing paper", cat: "stationery", per: 18, purpose: "Office and classes", every: 1, supplier: SUP.books, pack: 5 },
  { key: "Printer toner (HP 26A)", cat: "stationery", per: 1, purpose: "Office printing", every: 2, supplier: SUP.books, pack: 1 },
  { key: "White chalk", cat: "stationery", per: 6, purpose: "Classes", every: 1, supplier: SUP.books, pack: 10 },
  { key: "Whiteboard markers", cat: "stationery", per: 25, purpose: "Classes", every: 1, supplier: SUP.books, pack: 20 },
  { key: "Ballpoint pens (blue)", cat: "stationery", per: 50, purpose: "Classes", every: 1, supplier: SUP.books, pack: 50 },
  { key: "HB pencils", cat: "stationery", per: 70, purpose: "Classes", every: 1, supplier: SUP.books, pack: 50 },
  { key: "30 cm rulers", cat: "stationery", per: 10, purpose: "Classes", every: 1, supplier: SUP.books, pack: 20 },
  { key: "Exam answer booklets", cat: "stationery", per: 0, purpose: "Exams", every: 1, supplier: SUP.books, pack: 500 },
  { key: "Poster paint (assorted)", cat: "stationery", per: 6, purpose: "Art lessons", every: 1, supplier: SUP.books, pack: 6 },
  { key: "Powder paint (assorted)", cat: "stationery", per: 2, purpose: "Art lessons", every: 1, supplier: SUP.books, pack: 4 },
  { key: "Paint brushes", cat: "stationery", per: 8, purpose: "Art lessons", every: 1, supplier: SUP.books, pack: 12 },
  { key: "Wax crayons (12 colours)", cat: "stationery", per: 20, purpose: "Art lessons", every: 1, supplier: SUP.books, pack: 24 },
  { key: "Manila paper", cat: "stationery", per: 40, purpose: "Art lessons", every: 1, supplier: SUP.books, pack: 50 },
  { key: "Dilute hydrochloric acid (2 M)", cat: "lab_equipment", per: 1, purpose: "Chemistry practical", every: 1, supplier: SUP.lab, pack: 5, dow: 4 },
  { key: "Test tubes (borosilicate)", cat: "lab_equipment", per: 6, purpose: "Chemistry practical", every: 1, supplier: SUP.lab, pack: 50, dow: 4 },
  { key: "Litmus paper (red and blue)", cat: "lab_equipment", per: 1, purpose: "Chemistry practical", every: 1, supplier: SUP.lab, pack: 10, dow: 4 },
  { key: "Filter paper (12.5 cm)", cat: "lab_equipment", per: 1, purpose: "Chemistry practical", every: 1, supplier: SUP.lab, pack: 5, dow: 4 },
  { key: "Methylated spirit", cat: "lab_equipment", per: 1, purpose: "Chemistry practical", every: 1, supplier: SUP.lab, pack: 5, dow: 4 },
  { key: "Sodium hydroxide pellets", cat: "lab_equipment", per: 1, purpose: "Chemistry practical", every: 3, supplier: SUP.lab, pack: 2, dow: 4 },
  { key: "Copper(II) sulphate", cat: "lab_equipment", per: 1, purpose: "Chemistry practical", every: 4, supplier: SUP.lab, pack: 2, dow: 4 },
  { key: "Lab gas (LPG, 13 kg)", cat: "lab_equipment", per: 1, purpose: "Science practicals", every: 4, supplier: SUP.lab, pack: 1, dow: 1 },
  { key: "Microscope slides and cover slips", cat: "lab_equipment", per: 1, purpose: "Biology practical, Grade 10", every: 2, supplier: SUP.lab, pack: 5, dow: 2 },
  { key: "Examination gloves", cat: "medical", per: 1, purpose: "Sick bay: first aid", every: 2, supplier: SUP.pharm, pack: 5 },
  { key: "Cotton wool (400 g)", cat: "medical", per: 1, purpose: "Sick bay: first aid", every: 3, supplier: SUP.pharm, pack: 6 },
  { key: "Thermometer probe covers", cat: "medical", per: 1, purpose: "Sick bay: first aid", every: 6, supplier: SUP.pharm, pack: 2 },
];
const VISITOR_DAYS: Record<string, number> = { "2026-07-10": 150, "2026-11-13": 200 };   // sports days: guests stay for lunch

async function seedMovements(c: Ctx, presentOn: Map<string, number>) {
  const { T, terms, learners } = c;
  console.log("  stock movements (pass 2)…");
  const lines = [...KITCHEN, ...STATIONERY, ...LAB, ...MEDICAL];
  const itemId = (name: string) => {
    const l = lines.find((x) => x.name === name)!;
    return uid(`item:${l.category === "lab_equipment" ? "lab_equipment" : l.category}:${name}`);
  };
  const flowKeys = [...KITCHEN_FLOW.map((f) => f.key), ...WEEKLY.map((w) => w.key)];
  const ids = flowKeys.map(itemId);
  // unit, consumable and reorder level on every consumable stock line (pass 1 made them without)
  const current = DRY ? [] : ok(await db.from("inventory_items").select("id, quantity, unit, consumable, reorder_level").in("id", lines.map((l) => uid(`item:${l.category}:${l.name}`))), "items");
  for (const l of lines) {
    const id = uid(`item:${l.category}:${l.name}`);
    const cur = current.find((x) => x.id === id);
    if (!DRY && cur && (cur.unit !== l.unit || !cur.consumable || cur.reorder_level !== l.reorder)) {
      ok(await db.from("inventory_items").update({ unit: l.unit, consumable: true, reorder_level: l.reorder }).eq("id", id).eq("tenant_id", T).select("id"), `item ${l.name}`);
    }
  }
  // opening stock: today's quantity less what this script's (and anyone's) movements have done, so a re-run replays the same year
  const existing = DRY ? [] : await all<{ id: string; item_id: string; kind: string; quantity: number }>("inventory_movements",
    (a, b) => db.from("inventory_movements").select("id, item_id, kind, quantity").eq("tenant_id", T).in("item_id", ids).order("id").range(a, b));
  const have = new Set(existing.map((m) => m.id));
  const net = new Map<string, number>();
  for (const m of existing) net.set(m.item_id, (net.get(m.item_id) ?? 0) + (m.kind === "used" || m.kind === "wasted" ? -m.quantity : m.quantity));
  const stock = new Map<string, number>();
  for (const k of flowKeys) {
    const id = itemId(k);
    const cur = current.find((x) => x.id === id)?.quantity ?? lines.find((l) => l.name === k)!.stock;
    stock.set(k, cur - (net.get(id) ?? 0));
  }

  const total = learners.length;
  const boarders = learners.filter((l) => l.boarding).length;
  const pp = learners.filter((l) => l.cls.level === "pre_primary").length;
  const kind = (d: string) => {
    const t = terms.find((x) => d >= x.starts_on && d <= x.ends_on);
    if (!t || HALF_TERMS.some(([a, b]) => d >= a && d <= b)) return "none";
    return isSchoolDay(d) ? "school" : "boarders";
  };
  const ref = (p: Purpose, k: string) => (k === "boarders" ? boarders + 8 : p === "Lunch" || p === "Break tea" ? Math.round(total * 0.965) + c.staffCount
    : p === "Pre-primary snack" ? Math.round(pp * 0.96) : Math.round(boarders * 0.97) + 8);
  const heads = (p: Purpose, d: string, k: string) => (k === "boarders" ? boarders + 8
    : p === "Lunch" || p === "Break tea" ? (presentOn.get(d) ?? Math.round(total * 0.965)) + c.staffCount + (VISITOR_DAYS[d] ?? 0)
    : p === "Pre-primary snack" ? Math.round(pp * (presentOn.get(d) ?? total * 0.965) / total) : Math.round(boarders * 0.97) + 8);
  const purposesOn = (k: string): Purpose[] => (k === "school" ? ["Breakfast", "Break tea", "Pre-primary snack", "Lunch", "Supper"] : k === "boarders" ? ["Breakfast", "Lunch", "Supper"] : []);
  const qty = (f: Flow, p: Purpose, d: string, k: string): number => {
    const per = f.uses?.[p];
    if (per === undefined) return 0;
    const r = ref(p, k);
    const base = f.key === "Rice (pishori)" && p === "Lunch" ? (k === "school" ? 20 : Math.round(0.11 * r)) : per * r;
    const ratio = heads(p, d, k) / r;
    let x = base * (Math.abs(ratio - 1) > 0.08 ? ratio : 1);
    if (f.key === "Rice (pishori)" && p === "Lunch" && d === "2026-11-17") x *= 1.25;   // 25 kg on a normal Tuesday: where did 5 kg go?
    if (f.key === "Cooking oil" && d >= "2026-11-02") x *= 1 + 0.3 * clamp((Date.parse(d) - Date.parse("2026-11-02")) / (18 * 86_400_000), 0, 1);   // a slow creep
    return Math.round(x);
  };
  const week = (d: string) => Math.floor((Date.parse(d) - Date.parse("2025-12-29")) / (7 * 86_400_000));
  const firstSchoolDayOf = (d: string, span: "week" | "month") => {
    if (!isSchoolDayIn(d)) return false;
    const same = (x: string) => (span === "week" ? week(x) === week(d) : x.slice(0, 7) === d.slice(0, 7));
    for (let x = addDays(d, -1); same(x); x = addDays(x, -1)) if (isSchoolDayIn(x)) return false;
    return true;
  };
  const isSchoolDayIn = (d: string) => kind(d) === "school";
  const lastSchoolDayOfWeek = (d: string) => { for (let x = addDays(d, 1); week(x) === week(d); x = addDays(x, 1)) if (isSchoolDayIn(x)) return false; return true; };
  const lastSchoolDayOfMonth = (d: string) => { for (let x = addDays(d, 1); x.slice(0, 7) === d.slice(0, 7); x = addDays(x, 1)) if (isSchoolDayIn(x)) return false; return true; };
  const termStart = (d: string) => terms.some((t) => termDays(t, "2026-12-31")[0] === d);
  const deliversOn = (every: Flow["every"], d: string) => {
    if (kind(d) === "none") return false;
    if (every === "daily") return true;
    if (kind(d) !== "school") return false;
    if (termStart(d)) return true;
    const fw = firstSchoolDayOf(d, "week");
    if (every === "weekly") return fw;
    if (every === "twice") return fw || dow(d) === 4;
    if (every === "fortnightly") return fw && week(d) % 2 === 0;
    return firstSchoolDayOf(d, "month");
  };
  const price = (name: string, d: string) => {
    const base = lines.find((l) => l.name === name)!.kes;
    const i = (Date.parse(d) - Date.parse("2026-01-01")) / 86_400_000;
    let p = base * (1 + 0.045 * (i / 330)) * (1 + 0.025 * Math.sin(i / 45 + 6 * hr("ph", name)));
    if (name === "Potatoes" && d === "2026-11-16") p *= 1.3;   // one delivery well above this supplier's usual price
    return kes(p);
  };

  const rows: Row[] = [];
  const add = (key: string, d: string, k: "received" | "used" | "wasted" | "adjusted", q: number, extra: Row = {}, tag = "") => {
    if (!q) return;
    const s = stock.get(key)!;
    if (k !== "received" && (k === "adjusted" ? q : -q) + s < 0) q = k === "adjusted" ? -s : s;
    if (!q) return;
    stock.set(key, s + (k === "received" ? q : k === "adjusted" ? q : -q));
    rows.push({ id: uid(`mv:${key}:${d}:${k}:${tag}`), tenant_id: T, item_id: itemId(key), kind: k, quantity: q, occurred_on: d, recorded_by: c.storeId, ...extra });
  };
  const forecast = (f: Flow, from: string, until: string) => {
    let s = 0;
    for (let d = from; d < until; d = addDays(d, 1)) for (const p of purposesOn(kind(d))) s += qty(f, p, d, kind(d));
    return s;
  };
  const nextDelivery = (f: Flow, d: string) => { for (let x = addDays(d, 1), n = 0; n < 60; x = addDays(x, 1), n++) if (deliversOn(f.every, x)) return x; return addDays(d, 60); };

  for (let d = "2026-01-02"; d <= YESTERDAY; d = addDays(d, 1)) {
    const k = kind(d);
    if (k === "none") continue;
    // morning deliveries, enough to reach the next one with the reorder level in hand
    for (const f of KITCHEN_FLOW) {
      if (!deliversOn(f.every, d)) continue;
      if (f.key === "Beans (rosecoco)" && d > "2026-11-16") continue;
      const line = lines.find((l) => l.name === f.key)!;
      const until = f.key === "Beans (rosecoco)" && d === "2026-11-16" ? addDays(d, 8) : nextDelivery(f, d);
      const use = forecast(f, d, until);
      const need = f.key === "Beans (rosecoco)" && d === "2026-11-16"
        ? Math.max(0, Math.ceil(use - stock.get(f.key)! + 0.4 * qty(f, "Lunch", d, "school")))   // a short delivery: beans run out before the next one
        : Math.ceil(Math.max(0, use + line.reorder - stock.get(f.key)!) / f.pack) * f.pack;
      add(f.key, d, "received", need, { unit_cost_cents: price(f.key, d), supplier: f.supplier, reference: `DN-${d.replace(/-/g, "")}-${KITCHEN_FLOW.indexOf(f) + 1}` });
    }
    for (const w of WEEKLY) {
      if (!(k === "school" && (termStart(d) || firstSchoolDayOf(d, "month")))) continue;
      const line = lines.find((l) => l.name === w.key)!;
      const target = Math.ceil((w.per * 6) / w.every) + line.reorder + (w.key === "Exam answer booklets" ? 1_800 : 0);
      add(w.key, d, "received", Math.ceil(Math.max(0, target - stock.get(w.key)!) / w.pack) * w.pack,
        { unit_cost_cents: price(w.key, d), supplier: w.supplier, reference: `LPO-${d.replace(/-/g, "")}-${WEEKLY.indexOf(w) + 1}` });
    }
    // the day's meals
    for (const p of purposesOn(k)) {
      const served = heads(p, d, k);
      for (const f of KITCHEN_FLOW) add(f.key, d, "used", qty(f, p, d, k), { purpose: p, meals_served: served }, p);
    }
    // the other stores: weekly use on the last school day of the week (or the practical's day)
    if (k === "school") for (const w of WEEKLY) {
      const due = w.dow ? dow(d) === w.dow : lastSchoolDayOfWeek(d);
      if (!w.per || !due || week(d) % w.every !== 0) continue;
      const examWeek = Object.values(EXAM_WEEKS).flat().some((s) => week(s) === week(d));
      const per = w.key === "A4 printing paper" && examWeek ? Math.round(w.per * 1.1) : w.key === "Exercise books, 96 pages" && termStart(addDays(d, -4)) ? w.per * 5 : w.per;
      const grade = w.purpose === "Chemistry practical" ? `${w.purpose}, Grade ${10 + (week(d) % 3)}` : w.purpose;
      add(w.key, d, "used", Math.max(1, Math.round(per * (0.9 + 0.2 * hr("wk", w.key, d)))), { purpose: grade });
    }
    // exam answer booklets on the first day of each exam week
    if (k === "school") for (const [ti, wk] of Object.entries(EXAM_WEEKS)) wk.forEach((s0, ei) => {
      if (d === s0) add("Exam answer booklets", d, "used", ei === 0 ? 900 : 1_700, { purpose: `Term ${ti} ${["CAT", "mid-term exams", "end-term exams"][ei]}` }, "exam");
    });
    // one week the exercise books go much faster with no change in enrolment
    if (d === "2026-11-19") add("Exercise books, 96 pages", d, "used", 480, { purpose: "Classes", note: "Issued to classes" }, "extra");
    // spoilage
    if (k === "school" && dow(d) === 5) {
      for (const key of ["Tomatoes", "Cabbages"]) if (hr("waste", key, d) < 0.35) add(key, d, "wasted", 1 + Math.floor(hr("wq", key, d) * 2), { note: "Spoiled" });
      if (hr("waste", "bananas", d) < 0.3) add("Bananas (break-time fruit)", d, "wasted", 10 + Math.floor(hr("wq", "bananas", d) * 10), { note: "Over-ripe" });
    }
    if (k === "school" && hr("waste", "milk", d) < 0.04) add("Milk", d, "wasted", 5, { note: "Soured in the heat" });
    // stock-takes: the last school day of each month, and one before closing
    if (k === "school" && (lastSchoolDayOfMonth(d) || d === "2026-11-20")) {
      for (const f of [...KITCHEN_FLOW.map((x) => x.key), ...WEEKLY.filter((w) => w.cat === "stationery").map((w) => w.key)]) {
        const r = hr("take", f, d);
        const q = f === "Sugar" && d === "2026-11-20" ? -8 : r < 0.25 ? -1 : r < 0.33 ? 1 : 0;
        add(f, d, "adjusted", q, { note: q < -1 ? "Stock-take: 8 kg short against the book balance" : "Stock-take correction" });
      }
    }
  }
  const fresh = rows.filter((r) => !have.has(r.id as string));
  stat("inventory_movements", rows.length, fresh.length);
  if (!DRY) for (const part of chunks(fresh, 500)) {
    const { error } = await db.from("inventory_movements").insert(part, { defaultToNull: false });
    if (error) throw new Error(`inventory_movements: ${error.message}`);
  }
  const low = flowKeys.filter((k) => stock.get(k)! <= lines.find((l) => l.name === k)!.reorder);
  console.log(`    ${fresh.length} new movements; at or below reorder level now: ${low.join(", ") || "none"}`);
}

// ================================================================ outputs
async function writeOutputs(o: { showcase: Person[]; staff: Person[]; head: Prof; CLASSES: Cls[]; teacherById: Map<string, Teacher> }) {
  if (process.env.RESET_SHOWCASE_PASSWORDS === "1") {
    SHOWCASE_PASSWORD = process.env.SEED_PASSWORD ?? randomBytes(12).toString("base64url");
    for (const p of o.showcase) {
      const { error } = await db.auth.admin.updateUserById(p.id, { password: SHOWCASE_PASSWORD });
      if (error) throw new Error(`password for ${p.login_id}: ${error.message}`);
    }
  } else if (showcaseCreated.length && showcaseCreated.length < o.showcase.length) {
    // some showcase logins existed already: give them this run's password too, so one password works for all
    for (const p of o.showcase.filter((x) => !showcaseCreated.includes(x))) await db.auth.admin.updateUserById(p.id, { password: SHOWCASE_PASSWORD! });
  }
  const classOf = (id: string) => o.CLASSES.filter((c) => c.classTeacher === id).map((c) => c.name);
  if (SHOWCASE_PASSWORD) {
    const lines = [
      `Kijani Ridge Academy (slug ${SLUG}) demo logins, written ${new Date().toISOString()} for ${HOST}.`,
      "Sign in to Figbloom Schools, pick Kijani Ridge Academy, and use the login ID with the password below.",
      `Password (all six): ${SHOWCASE_PASSWORD}`, "",
      ...o.showcase.map((p) => `  ${p.login_id.padEnd(8)} ${String(p.showcase).padEnd(16)} ${p.full_name}${p.staff_title ? `, ${p.staff_title}` : ""}${classOf(p.id).length ? ` (class teacher, ${classOf(p.id).join(", ")})` : ""}`),
      "", `The head teacher (${o.head.full_name}) and seed-cbe's accounts (TC-0001, PT-0001, ST-0001, BD-000x) keep their own passwords.`,
    ];
    writeFileSync(LOGINS_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
    console.log(`\nShowcase logins and their password: ${LOGINS_FILE}`);
  } else {
    console.log(`\nShowcase logins unchanged; their password is in ${LOGINS_FILE} from the run that made them (RESET_SHOWCASE_PASSWORDS=1 sets a new one).`);
  }
  const manifest = o.staff.map((p) => ({
    person_id: p.id, login_id: p.login_id, full_name: p.full_name, role: p.role, job_title: p.staff_title ?? null, email: p.email, phone: p.phone,
    gender: p.gender ?? null, tsc_number: p.tsc ?? null, start_date: p.joined ?? null, class_teacher_of: classOf(p.id),
    teaches: (o.teacherById.get(p.id)?.teaches ?? []).map((t) => `${t.cls.name}: ${t.code}`), lessons_per_week: o.teacherById.get(p.id)?.lessons ?? null,
  }));
  writeFileSync(STAFF_MANIFEST, JSON.stringify({ school: "Kijani Ridge Academy", tenant_id: TENANT, generated_at: new Date().toISOString(),
    note: "person_id = Schools profiles.id = the external_id HR's external_people holds. Emails are .invalid (sent to HR as null); TSC numbers are fake.", staff: manifest }, null, 2));
  console.log(`Staff manifest for the HR seeder: ${STAFF_MANIFEST}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
