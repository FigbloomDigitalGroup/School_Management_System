import { supabase } from "./supabase";
import { invokeEdge } from "./edge";
import { EXAM_OUT_OF, validateExamName } from "./exams";
import { isValidYear, LEVELS, levelsForTenant, yearLabel } from "./levels";
import type { ClassLevel, Tenant } from "./types";

/**
 * The Figbloom guide (ai-assist task "guide"): an AI helper in every console
 * that shows people the way round the app, so they need no demo. It is sent
 * the person's own sidebar, each page with what it's for (PAGE_ABOUT), and
 * answers with steps and links to those pages only.
 *
 * For a full school admin it can also plan the school's structure: classes,
 * subjects, a term, exams and fee items. A plan is only a proposal: planSetup
 * checks every step against the school's own rules and what already exists,
 * the admin sees it and confirms, and applySetupPlan writes it from their own
 * browser, under their own row-level security, with the audit triggers
 * logging every row as theirs. The guide never adds or changes people, and a
 * message with a phone number in it is never sent.
 */

/** What each console page is for, in the guide's words. Keys are NAV `to` values. */
export const PAGE_ABOUT: Record<string, string> = {
  // the school's admin console
  "admin": "The overview for full admins: what needs you, attendance by class today and fee collection this term. Someone holding only some admin areas sees a list of their areas instead.",
  "admin/people": "Learners, staff and parents: add a learner, import learners from a CSV file, add staff and guardians, open anyone's card to edit their details, documents and sign-in, give a staff member admin areas, archive a learner who has left.",
  "admin/classes": "Create classes (every year crossed with every stream you list), set each class's teacher, and promote a class to the next year at the end of the year.",
  "admin/subjects": "Tick the learning areas the school teaches (each becomes a subject for the right grades), add a subject of your own, and pick who teaches each subject in each class.",
  "admin/courses": "Higher education only: semesters, the course catalogue and section rosters.",
  "admin/exams": "Set up each exam once a term (Opener, Mid-term, End of term). Teachers enter marks in their Gradebook and publish each class and subject when ready.",
  "admin/papers": "Online exams and tests: write a paper or import one with Bloom, set when it opens, and see learners' attempts.",
  "admin/materials": "Notes, worksheets and videos shared with classes.",
  "admin/report-cards": "Build, check, sign and send each learner's report card for a term.",
  "admin/fees": "Fee items per term, billing learners (one invoice each), recording cash, bank, cheque and M-Pesa payments, checking parents' proofs of payment, and receipts.",
  "admin/study-helper": "Who has the Bloom study helper for learners, and how much it is used.",
  "admin/announcements": "Announcements to the whole school, a class or parents. In the app always; SMS only when it can't wait.",
  "admin/activities": "Sports, clubs and societies: members, patrons, fixtures, events and awards.",
  "admin/chats": "Your chats with parents and staff, and every chat in the school, which you can read but not join.",
  "admin/leave": "Approve or decline teachers' and staff's leave requests; they are told either way.",
  "admin/visitors": "Everyone recorded at the gate or reception, and visits escalated to the office.",
  "admin/medical": "The sick bay: visits, the medication round, parents' medication requests and learners' health records.",
  "admin/inventory": "What the school owns and who has it: issue textbooks, equipment and uniforms to learners or staff and record returns.",
  "admin/fleet": "Buses, routes and stops, drivers, and every bus on the road now, with riders and alerts.",
  "admin/reports": "Attendance and fee collection by class for this term.",
  "admin/performance": "Published results over time: how means, subjects and grades move from exam to exam.",
  "admin/settings": "School settings: the current term (start a new one with its dates), school details, the crest, the accent colour, how parents pay (paybill, till, bank details), publishing the fee structure, and the AI and Bloom switches.",
  "admin/access": "Access & roles: make roles from admin areas (or use presets such as Bursar or Deputy) and give them to teachers or staff on their card in Students & staff.",
  "admin/audit": "The audit log: every change in the school, who made it and when. Read only.",
  "admin/account": "Your own name, phone, photo and password.",
  // teachers
  "teacher/attendance": "Take a class's register for today and correct it; registers taken offline send themselves later.",
  "teacher/gradebook": "Enter marks for an exam, class and subject you teach (type abs for an absence), then publish them when ready.",
  "teacher/homework": "Set homework for a class and subject you teach; learners mark it handed in and you see how many have.",
  "teacher/materials": "Share notes, worksheets and videos with your classes.",
  "teacher/exams": "Online exams and tests for your classes: write one or import a paper with Bloom, and see attempts.",
  "teacher/report-cards": "Write comments (Bloom can draft them) and check report cards for your classes.",
  "teacher/performance": "How your classes' published results have moved over time.",
  "teacher/timetable": "Your week, lesson by lesson.",
  "teacher/classes": "The classes and subjects you teach, and your own class's learners.",
  "teacher/sections": "Higher education: the course sections you teach.",
  "teacher/messages": "Send a note to one of your classes: its parents, its learners, or both.",
  "teacher/chats": "Chats and calls with colleagues and the parents of learners you teach.",
  "teacher/notices": "Announcements from the school office.",
  "teacher/activities": "The clubs and teams you look after.",
  "teacher/buses": "Where every bus is now and when it reaches its next stop.",
  "teacher/leave": "Ask for time off; the office approves or declines it.",
  "teacher/loans": "Ask for a salary advance or staff loan.",
  "teacher/visitors": "Visitors who asked for you at the gate or reception today.",
  "teacher/items": "Things the school has issued you, and when they're due back.",
  "teacher/account": "Your own name, phone, photo and password.",
  // other staff
  "staff": "Your home page.",
  "staff/visitors": "The visitor log at the gate and reception: sign people in and out, escalate a visit to the office.",
  "staff/notices": "Announcements from the school office.",
  "staff/chats": "Chats and calls with colleagues.",
  "staff/loans": "Ask for a salary advance or staff loan; repayments come off your salary.",
  "staff/items": "Things the school has issued you, and when they're due back.",
  "staff/account": "Your own name, phone, photo and password. Your title is set by the school office.",
  // organization admins (relative to /org/<slug>/)
  "dashboard": "The organization's overview across its schools.",
  "schools": "The organization's schools: add a school (it's ready to use at once), open one to see it, or open its console to work as that school's office.",
  "admins": "The organization's admins: add or remove the people who run the organization.",
  "audit": "The organization's audit log: what its admins did, and when.",
};

export interface GuidePageInfo { to: string; label: string; about: string }

/** The guide's view of a sidebar: each page with what it's for. */
export function guidePages(items: readonly { to: string; label: string }[]): GuidePageInfo[] {
  return items.map((i) => ({ to: i.to, label: i.label, about: PAGE_ABOUT[i.to] ?? "" }));
}

/** Mirrors containsPhoneNumber in supabase/functions/ai-assist/tasks.ts, so a message is stopped before it's sent. */
const PHONE = /(?:\+?254|\b0)[\s-]?[17](?:[\s-]?\d){8}\b|\+\d(?:[\s-]?\d){7,13}\b/;
export const containsPhoneNumber = (text: string): boolean => PHONE.test(text);

export interface GuideTurn { role: "user" | "assistant"; content: string }
export interface GuideLink { to: string; label: string }

export type SetupAction =
  | { kind: "create_class"; name: string; level: ClassLevel; year: number; stream: string | null }
  | { kind: "create_subject"; name: string; code: string; level: ClassLevel | null; fromYear: number | null; toYear: number | null }
  | { kind: "start_term"; year: number; index: number; startsOn: string; endsOn: string }
  | { kind: "create_exam"; name: string }
  | { kind: "create_fee_item"; name: string; shillings: number; appliesTo: "all" | "boarders" | "day" | "form_level"; level: ClassLevel | null; year: number | null };

export interface GuideAnswer { reply: string; links: GuideLink[]; actions: unknown[] }

const GUIDE_TIMEOUT_MS = 120_000;

/**
 * The guide's next answer. A school console sends nothing extra (an org admin
 * acting for a school sends its tenantId); the organization console sends its
 * organizationId.
 */
export async function askGuide(
  turns: GuideTurn[],
  opts: { pages: GuidePageInfo[]; here: string; adminAreas?: boolean; tenantId?: string; organizationId?: string; signal?: AbortSignal },
): Promise<GuideAnswer> {
  const { result } = await invokeEdge<{ result: GuideAnswer }>("ai-assist", {
    task: "guide",
    payload: { messages: turns, pages: opts.pages, here: opts.here, adminAreas: !!opts.adminAreas },
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
  }, { timeoutMs: GUIDE_TIMEOUT_MS, signal: opts.signal });
  return { reply: result.reply ?? "", links: result.links ?? [], actions: result.actions ?? [] };
}

// ------------------------------------------------------------------ setup plans

/** What's already there, for spotting a step that would repeat it. Names compare without case. */
export interface SetupExisting {
  classNames: string[];
  subjectCodes: string[];
  terms: { year: number; index: number }[];
  currentTermId: string | null;
  currentTermExams: string[];
  currentTermFeeItems: string[];
}

export async function fetchSetupExisting(tenantId: string): Promise<SetupExisting> {
  const db = supabase();
  const [classes, subjects, terms] = await Promise.all([
    db.from("classes").select("name").eq("tenant_id", tenantId),
    db.from("subjects").select("code").eq("tenant_id", tenantId),
    db.from("terms").select("id, year, index, is_current").eq("tenant_id", tenantId),
  ]);
  for (const r of [classes, subjects, terms]) if (r.error) throw new Error(r.error.message);
  const current = (terms.data ?? []).find((t) => t.is_current) ?? null;
  const [exams, fees] = current
    ? await Promise.all([
      db.from("exams").select("name").eq("term_id", current.id),
      db.from("fee_items").select("name").eq("term_id", current.id),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];
  for (const r of [exams, fees]) if (r.error) throw new Error(r.error.message);
  return {
    classNames: (classes.data ?? []).map((c) => c.name as string),
    subjectCodes: (subjects.data ?? []).map((s) => s.code as string),
    terms: (terms.data ?? []).map((t) => ({ year: t.year as number, index: t.index as number })),
    currentTermId: (current?.id as string | undefined) ?? null,
    currentTermExams: (exams.data ?? []).map((e) => (e as { name: string }).name),
    currentTermFeeItems: (fees.data ?? []).map((f) => (f as { name: string }).name),
  };
}

/** One step of a plan as the admin sees it: what it does, or why it will be left out. */
export interface PlanItem { action: SetupAction | null; label: string; skip: string | null }

const LEVEL_KEYS = Object.keys(LEVELS) as ClassLevel[];
const FEE_SCOPES = ["all", "boarders", "day", "form_level"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A fee item larger than this is far more likely a slip than a real amount. */
const MAX_FEE_SHILLINGS = 5_000_000;
const NAME_MAX = 60;

const text = (v: unknown, max = NAME_MAX): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t && t.length <= max ? t : null;
};
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const level = (v: unknown): ClassLevel | null => (typeof v === "string" && (LEVEL_KEYS as string[]).includes(v) ? v as ClassLevel : null);
const lower = (s: string) => s.toLowerCase();
const shillings = (n: number) => `KSh ${n.toLocaleString("en-KE")}`;

/**
 * The guide's raw steps, each checked: a step that's malformed, outside the
 * school's levels, or would repeat something that exists (or an earlier step)
 * is kept with its reason and not applied. Steps come back in the order
 * they'll run: a new term first, so exams and fee items go into it.
 */
export function planSetup(raw: unknown[], existing: SetupExisting, schoolLevel: Tenant["level"]): PlanItem[] {
  const allowed = levelsForTenant(schoolLevel);
  const classes = new Set(existing.classNames.map(lower));
  const codes = new Set(existing.subjectCodes.map(lower));
  const startsTerm = raw.some((a) => (a as { kind?: unknown })?.kind === "start_term");
  // a new term starts with no exams or fee items
  const exams = startsTerm ? [] : [...existing.currentTermExams];
  const fees = new Set(startsTerm ? [] : existing.currentTermFeeItems.map(lower));
  const noTerm = !startsTerm && !existing.currentTermId;
  let termSeen = false;

  const items = raw.map((r): PlanItem => {
    const a = (r ?? {}) as Record<string, unknown>;
    switch (a.kind) {
      case "create_class": {
        const name = text(a.name), lv = level(a.level), year = whole(a.year);
        if (!name || !lv || year === null) return { action: null, label: `Class ${name ?? ""}`.trim(), skip: "Not enough detail to create it." };
        const label = `Class ${name}`;
        if (!allowed.includes(lv)) return { action: null, label, skip: `This school doesn't run ${LEVELS[lv].label.toLowerCase()} classes.` };
        if (!isValidYear(lv, year)) return { action: null, label, skip: `${LEVELS[lv].label} has no ${yearLabel(lv, year)}.` };
        if (classes.has(lower(name))) return { action: null, label, skip: "Already exists." };
        classes.add(lower(name));
        return { action: { kind: "create_class", name, level: lv, year, stream: text(a.stream, 40) }, label: `Class ${name} (${yearLabel(lv, year)})`, skip: null };
      }
      case "create_subject": {
        const name = text(a.name), code = text(a.code, 12)?.toUpperCase().replace(/\s+/g, "") ?? null;
        if (!name || !code) return { action: null, label: `Subject ${name ?? ""}`.trim(), skip: "Not enough detail to create it." };
        const label = `Subject ${name} (${code})`;
        const lv = level(a.level);
        const from = lv ? whole(a.from_year) : null, to = lv ? whole(a.to_year) : null;
        if (lv && [from, to].some((y) => y !== null && !isValidYear(lv, y))) return { action: null, label, skip: `Those years aren't in ${LEVELS[lv].label.toLowerCase()}.` };
        if (from !== null && to !== null && from > to) return { action: null, label, skip: "The years are the wrong way round." };
        if (codes.has(lower(code))) return { action: null, label, skip: `A subject already has the code ${code}.` };
        codes.add(lower(code));
        const span = lv ? ` for ${from !== null || to !== null ? `${yearLabel(lv, from ?? LEVELS[lv].min)} to ${yearLabel(lv, to ?? LEVELS[lv].max)}` : LEVELS[lv].label.toLowerCase()}` : "";
        return { action: { kind: "create_subject", name, code, level: lv, fromYear: from, toYear: to }, label: label + span, skip: null };
      }
      case "start_term": {
        const year = whole(a.term_year), index = whole(a.term_index);
        const startsOn = typeof a.starts_on === "string" && DATE.test(a.starts_on) ? a.starts_on : null;
        const endsOn = typeof a.ends_on === "string" && DATE.test(a.ends_on) ? a.ends_on : null;
        const label = year && index ? `Start Term ${index}, ${year}` : "Start a new term";
        if (termSeen) return { action: null, label, skip: "Only one new term at a time." };
        termSeen = true;
        if (!year || year < 2000 || year > 2100 || !index || index < 1 || index > 3 || !startsOn || !endsOn) return { action: null, label, skip: "It needs a year, a term number (1 to 3) and both dates." };
        if (endsOn <= startsOn) return { action: null, label, skip: "It ends before it starts." };
        if (existing.terms.some((t) => t.year === year && t.index === index)) return { action: null, label, skip: "That term already exists. Make it current in School settings." };
        return { action: { kind: "start_term", year, index, startsOn, endsOn }, label: `${label} (${startsOn} to ${endsOn}), and make it the current term`, skip: null };
      }
      case "create_exam": {
        const label = `Exam ${text(a.name) ?? ""}`.trim();
        if (noTerm) return { action: null, label, skip: "There's no current term to put it in. Start one first." };
        const checked = validateExamName(typeof a.name === "string" ? a.name : "", exams);
        if (!checked.ok) return { action: null, label, skip: checked.message };
        exams.push(checked.name);
        return { action: { kind: "create_exam", name: checked.name }, label: `Exam ${checked.name} (out of ${EXAM_OUT_OF})`, skip: null };
      }
      case "create_fee_item": {
        const name = text(a.name), amount = whole(a.amount_shillings);
        const appliesTo = (FEE_SCOPES as readonly unknown[]).includes(a.applies_to) ? a.applies_to as typeof FEE_SCOPES[number] : "all";
        const label = `Fee item ${name ?? ""}`.trim();
        if (noTerm) return { action: null, label, skip: "There's no current term to put it in. Start one first." };
        if (!name || amount === null || amount <= 0 || amount > MAX_FEE_SHILLINGS) return { action: null, label, skip: "It needs a name and an amount in whole shillings." };
        const lv = appliesTo === "form_level" ? level(a.level) : null, year = appliesTo === "form_level" ? whole(a.year) : null;
        if (appliesTo === "form_level" && (!lv || year === null || !isValidYear(lv, year) || !allowed.includes(lv))) return { action: null, label, skip: "It needs a year group this school has." };
        if (fees.has(lower(name))) return { action: null, label, skip: "This term already has a fee item with that name." };
        fees.add(lower(name));
        const who = appliesTo === "all" ? "every learner" : appliesTo === "boarders" ? "boarders" : appliesTo === "day" ? "day scholars" : yearLabel(lv!, year!);
        return { action: { kind: "create_fee_item", name, shillings: amount, appliesTo, level: lv, year }, label: `Fee item ${name}: ${shillings(amount)} for ${who}`, skip: null };
      }
      default:
        return { action: null, label: "An unknown step", skip: "The guide can't do this." };
    }
  });
  const ORDER: Record<string, number> = { start_term: 0, create_class: 1, create_subject: 2, create_exam: 3, create_fee_item: 4 };
  return items
    .map((item, i) => ({ item, i }))
    .sort((x, y) => (ORDER[x.item.action?.kind ?? ""] ?? 5) - (ORDER[y.item.action?.kind ?? ""] ?? 5) || x.i - y.i)
    .map(({ item }) => item);
}

export interface PlanResult { label: string; ok: boolean; message: string }

/**
 * Writes the plan's steps from the admin's own browser, the way the setup
 * screens do: a new term first (ending the current one), then each kind in
 * one insert, so the audit log has one line per kind. A kind that fails is
 * reported and the rest still run; exams and fee items wait for the term.
 */
export async function applySetupPlan(tenantId: string, items: PlanItem[], existingTermId: string | null): Promise<PlanResult[]> {
  const db = supabase();
  const results: PlanResult[] = [];
  const of = <K extends SetupAction["kind"]>(kind: K) =>
    items.map((i) => i.action).filter((a): a is Extract<SetupAction, { kind: K }> => a?.kind === kind);
  const labelsOf = (kind: SetupAction["kind"]) => items.filter((i) => i.action?.kind === kind).map((i) => i.label);
  const report = (kind: SetupAction["kind"], error: { message: string } | null) =>
    labelsOf(kind).forEach((label) => results.push({ label, ok: !error, message: error ? error.message : "Created" }));

  let termId = existingTermId;
  const [term] = of("start_term");
  if (term) {
    let error: { message: string } | null = null;
    if (existingTermId) error = (await db.from("terms").update({ is_current: false }).eq("id", existingTermId)).error;
    if (!error) {
      const inserted = await db.from("terms").insert({
        tenant_id: tenantId, name: `Term ${term.index}, ${term.year}`, year: term.year, index: term.index,
        starts_on: term.startsOn, ends_on: term.endsOn, is_current: true,
      }).select("id").single();
      error = inserted.error;
      if (!error) termId = (inserted.data as { id: string }).id;
      else if (existingTermId) await db.from("terms").update({ is_current: true }).eq("id", existingTermId);
    }
    report("start_term", error);
    if (error) termId = existingTermId;
  }

  const classes = of("create_class");
  if (classes.length) {
    report("create_class", (await db.from("classes").insert(classes.map((c) => ({
      tenant_id: tenantId, name: c.name, level: c.level, form_level: c.year, pathway: null, stream: c.stream, room: null, class_teacher_id: null,
    })))).error);
  }
  const subjects = of("create_subject");
  if (subjects.length) {
    report("create_subject", (await db.from("subjects").insert(subjects.map((s) => ({
      tenant_id: tenantId, name: s.name, code: s.code, is_core: true, level: s.level, min_form_level: s.fromYear, max_form_level: s.toYear,
    })))).error);
  }
  // a term this plan meant to start but couldn't: its exams and fee items would land in the old one
  const termFailed = !!term && results.some((r) => !r.ok && labelsOf("start_term").includes(r.label));
  const needsTerm = termFailed || !termId ? { message: "Not created: there's no term for it." } : null;
  const exams = of("create_exam");
  if (exams.length) {
    report("create_exam", needsTerm ?? (await db.from("exams").insert(exams.map((e) => ({ tenant_id: tenantId, term_id: termId, name: e.name, out_of: EXAM_OUT_OF })))).error);
  }
  const fees = of("create_fee_item");
  if (fees.length) {
    report("create_fee_item", needsTerm ?? (await db.from("fee_items").insert(fees.map((f) => ({
      tenant_id: tenantId, term_id: termId, name: f.name, amount_cents: f.shillings * 100, applies_to: f.appliesTo, level: f.level, form_level: f.year,
    })))).error);
  }
  return results;
}
