import { supabase } from "./supabase";
import { fetchAllPages } from "./paging";
import type { Audience } from "./types";

/**
 * Sports and co-curricular activities (supabase/migrations/20261027070000_activities.sql).
 *
 * The office runs the list of clubs, teams and societies and names their
 * patrons; a patron keeps the members and the events (fixtures,
 * competitions, trips, performances) and records the results. Families see
 * their own child's clubs, what's coming up and what they've won.
 */

export type ActivityCategory = "sport" | "club" | "arts" | "other";
export type EventKind = "fixture" | "competition" | "trip" | "performance" | "other";
export type EventLevel = "school" | "inter_house" | "zonal" | "sub_county" | "county" | "regional" | "national" | "international";
export type EventStatus = "scheduled" | "completed" | "cancelled";
export type EventOutcome = "won" | "drew" | "lost";
export type Award = "gold" | "silver" | "bronze" | "trophy" | "certificate" | "other";

export const ACTIVITY_CATEGORY_LABEL: Record<ActivityCategory, string> = {
  sport: "Sport",
  club: "Club or society",
  arts: "Music, drama or arts",
  other: "Other",
};

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  fixture: "Match or fixture",
  competition: "Competition",
  trip: "Trip",
  performance: "Performance or festival",
  other: "Other",
};

/** The Kenya school games / music and drama festival ladder, bottom to top. */
export const EVENT_LEVEL_LABEL: Record<EventLevel, string> = {
  school: "Within the school",
  inter_house: "Inter-house",
  zonal: "Zonal",
  sub_county: "Sub-county",
  county: "County",
  regional: "Regional",
  national: "National",
  international: "International",
};

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  scheduled: "Coming up",
  completed: "Done",
  cancelled: "Cancelled",
};

export const OUTCOME_LABEL: Record<EventOutcome, string> = { won: "Won", drew: "Drew", lost: "Lost" };

export const AWARD_LABEL: Record<Award, string> = {
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  trophy: "Trophy",
  certificate: "Certificate",
  other: "Award",
};

export interface ActivityRow {
  id: string;
  tenantId: string;
  name: string;
  category: ActivityCategory;
  description: string;
  meetingSchedule: string;
  active: boolean;
  patrons: { id: string; name: string }[];
}

export interface ActivityEventRow {
  id: string;
  activityId: string;
  title: string;
  kind: EventKind;
  level: EventLevel | null;
  startsAt: string;
  endsAt: string | null;
  venue: string;
  opponent: string;
  status: EventStatus;
  score: string;
  outcome: EventOutcome | null;
  position: number | null;
  notes: string;
  notifiedAt: string | null;
}

export interface MemberRow {
  studentId: string;
  name: string;
  className: string;
  role: string | null;
  joinedOn: string;
}

export interface ParticipantRow {
  studentId: string;
  name: string;
  className: string;
  award: Award | null;
  position: number | null;
  achievement: string | null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

// ---------------------------------------------------------------- pure

export interface ActivityInput {
  name: string;
  category: ActivityCategory;
  description: string;
  meetingSchedule: string;
}

export function validateActivity(input: ActivityInput): Checked<ActivityInput> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Give the activity a name." };
  if (name.length > 120) return { ok: false, message: "Keep the name under 120 characters." };
  if (!(input.category in ACTIVITY_CATEGORY_LABEL)) return { ok: false, message: "Choose what kind of activity it is." };
  const description = input.description.trim();
  if (description.length > 2000) return { ok: false, message: "Keep the description under 2,000 characters." };
  const meetingSchedule = input.meetingSchedule.trim();
  if (meetingSchedule.length > 300) return { ok: false, message: "Keep the meeting times under 300 characters." };
  return { ok: true, value: { name, category: input.category, description, meetingSchedule } };
}

/** What the event form collects: a local date and times, as the inputs give them. */
export interface EventForm {
  activityId: string;
  title: string;
  kind: EventKind;
  level: EventLevel | "";
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  startTime: string;
  /** HH:MM, or "" for no set end */
  endTime: string;
  venue: string;
  opponent: string;
  status: EventStatus;
  score: string;
  outcome: EventOutcome | "";
  position: string;
  notes: string;
}

export interface EventInput {
  activityId: string;
  title: string;
  kind: EventKind;
  level: EventLevel | null;
  startsAt: string;
  endsAt: string | null;
  venue: string;
  opponent: string;
  status: EventStatus;
  score: string;
  outcome: EventOutcome | null;
  position: number | null;
  notes: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Turns the form into a row, with the times read in the device's own time zone (the school's). */
export function validateEvent(f: EventForm): Checked<EventInput> {
  if (!f.activityId) return { ok: false, message: "Choose the activity." };
  const title = f.title.trim();
  if (!title) return { ok: false, message: "Give the event a title, e.g. \"Football vs Kakamega School\"." };
  if (title.length > 160) return { ok: false, message: "Keep the title under 160 characters." };
  if (!DATE_RE.test(f.date)) return { ok: false, message: "Choose the date." };
  if (!TIME_RE.test(f.startTime)) return { ok: false, message: "Give the start time." };
  if (f.endTime && !TIME_RE.test(f.endTime)) return { ok: false, message: "That end time isn't a time of day." };
  if (f.endTime && f.endTime < f.startTime) return { ok: false, message: "The event can't end before it starts." };
  if (f.venue.trim().length > 200 || f.opponent.trim().length > 200) return { ok: false, message: "Keep the venue and opponent under 200 characters." };
  if (f.score.trim().length > 120) return { ok: false, message: "Keep the score under 120 characters." };
  if (f.notes.trim().length > 4000) return { ok: false, message: "Keep the notes under 4,000 characters." };
  let position: number | null = null;
  if (f.position.trim()) {
    position = Number(f.position.trim());
    if (!Number.isInteger(position) || position < 1 || position > 1000) return { ok: false, message: "Position is a place like 1, 2 or 3." };
  }
  const result = f.status === "completed";
  return {
    ok: true,
    value: {
      activityId: f.activityId,
      title,
      kind: f.kind,
      level: f.level || null,
      startsAt: new Date(`${f.date}T${f.startTime}`).toISOString(),
      endsAt: f.endTime ? new Date(`${f.date}T${f.endTime}`).toISOString() : null,
      venue: f.venue.trim(),
      opponent: f.opponent.trim(),
      status: f.status,
      // a result only means something once it's been played
      score: result ? f.score.trim() : "",
      outcome: result ? f.outcome || null : null,
      position: result ? position : null,
      notes: f.notes.trim(),
    },
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An event back into the form's local date and times. */
export function eventToForm(e: ActivityEventRow): EventForm {
  const start = new Date(e.startsAt);
  const end = e.endsAt ? new Date(e.endsAt) : null;
  return {
    activityId: e.activityId,
    title: e.title,
    kind: e.kind,
    level: e.level ?? "",
    date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    endTime: end ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : "",
    venue: e.venue,
    opponent: e.opponent,
    status: e.status,
    score: e.score,
    outcome: e.outcome ?? "",
    position: e.position ? String(e.position) : "",
    notes: e.notes,
  };
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st ... */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "Won 2-1", "3rd place", "Won 2-1 · 1st", or "" before there's a result. */
export function eventResultLabel(e: Pick<ActivityEventRow, "status" | "score" | "outcome" | "position">): string {
  if (e.status !== "completed") return "";
  const parts: string[] = [];
  const head = [e.outcome ? OUTCOME_LABEL[e.outcome] : "", e.score].filter(Boolean).join(" ");
  if (head) parts.push(head);
  if (e.position) parts.push(e.outcome || e.score ? ordinal(e.position) : `${ordinal(e.position)} place`);
  return parts.join(" · ");
}

/**
 * Coming up (soonest first) and already happened (newest first). An event
 * stays "coming up" until it has ended -- or, with no end time, until the
 * end of its day -- unless it was cancelled or its result is in.
 */
export function splitEvents<T extends Pick<ActivityEventRow, "startsAt" | "endsAt" | "status">>(events: T[], now: Date = new Date()): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const e of events) {
    const start = new Date(e.startsAt);
    const over = e.endsAt ? new Date(e.endsAt) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    if (e.status === "scheduled" && over > now) upcoming.push(e);
    else past.push(e);
  }
  upcoming.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  past.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return { upcoming, past };
}

/** Whether a participant row is something to show off: a medal, a place or a named achievement. */
export function isAchievement(p: Pick<ParticipantRow, "award" | "position" | "achievement">): boolean {
  return !!(p.award || p.position || p.achievement);
}

/** "Gold · 400 m" / "2nd place" / "Best actor". */
export function achievementLabel(p: Pick<ParticipantRow, "award" | "position" | "achievement">): string {
  const parts: string[] = [];
  if (p.award) parts.push(AWARD_LABEL[p.award]);
  if (p.position && !(p.award && ["gold", "silver", "bronze"].includes(p.award))) parts.push(`${ordinal(p.position)} place`);
  if (p.achievement) parts.push(p.achievement);
  return parts.join(" · ");
}

/** "Sat 2 Nov, 2:00 pm" (to 4:30 pm). */
export function formatEventWhen(e: Pick<ActivityEventRow, "startsAt" | "endsAt">): string {
  const start = new Date(e.startsAt);
  const day = start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });
  return e.endsAt ? `${day}, ${time(start)} to ${time(new Date(e.endsAt))}` : `${day}, ${time(start)}`;
}

/** The announcement the participants' families get about an upcoming event. */
export function eventNotice(e: Pick<ActivityEventRow, "title" | "startsAt" | "endsAt" | "venue" | "opponent" | "level" | "notes">, activityName: string): { subject: string; body: string } {
  const lines = [
    `Coming up for ${activityName}: ${e.title}.`,
    `When: ${formatEventWhen(e)}`,
    e.venue ? `Where: ${e.venue}` : "",
    e.opponent ? `Against / hosted by: ${e.opponent}` : "",
    e.level ? `Level: ${EVENT_LEVEL_LABEL[e.level]}` : "",
    e.notes ? `\n${e.notes}` : "",
  ].filter(Boolean);
  return { subject: `${activityName}: ${e.title}`, body: lines.join("\n") };
}

/** Which ids to add and remove to turn `current` into `wanted`. */
export function diffIds(current: Iterable<string>, wanted: Iterable<string>): { add: string[]; remove: string[] } {
  const have = new Set(current);
  const want = new Set(wanted);
  return { add: [...want].filter((id) => !have.has(id)), remove: [...have].filter((id) => !want.has(id)) };
}

// ---------------------------------------------------------------- reading

interface ActivityDb {
  id: string; tenant_id: string; name: string; category: ActivityCategory;
  description: string; meeting_schedule: string; active: boolean;
}
interface EventDb {
  id: string; activity_id: string; title: string; kind: EventKind; level: EventLevel | null;
  starts_at: string; ends_at: string | null; venue: string; opponent: string; status: EventStatus;
  score: string; outcome: EventOutcome | null; position: number | null; notes: string; notified_at: string | null;
}

const EVENT_COLUMNS = "id, activity_id, title, kind, level, starts_at, ends_at, venue, opponent, status, score, outcome, position, notes, notified_at";

function toEvent(e: EventDb): ActivityEventRow {
  return {
    id: e.id, activityId: e.activity_id, title: e.title, kind: e.kind, level: e.level,
    startsAt: e.starts_at, endsAt: e.ends_at, venue: e.venue, opponent: e.opponent, status: e.status,
    score: e.score, outcome: e.outcome, position: e.position, notes: e.notes, notifiedAt: e.notified_at,
  };
}

async function patronNames(tenantId: string): Promise<Map<string, { id: string; name: string }[]>> {
  const { data, error } = await supabase().rpc("activity_patron_names", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  const out = new Map<string, { id: string; name: string }[]>();
  for (const p of (data ?? []) as { activity_id: string; teacher_id: string; full_name: string }[]) out.set(p.activity_id, [...(out.get(p.activity_id) ?? []), { id: p.teacher_id, name: p.full_name }]);
  return out;
}

/** Every activity in the school with its patrons, by name. */
export async function fetchActivities(tenantId: string): Promise<ActivityRow[]> {
  const [{ data, error }, patrons] = await Promise.all([
    supabase().from("activities").select("id, tenant_id, name, category, description, meeting_schedule, active")
      .eq("tenant_id", tenantId).order("name").returns<ActivityDb[]>(),
    patronNames(tenantId),
  ]);
  if (error) throw new Error(error.message);
  return (data ?? []).map((a) => ({
    id: a.id, tenantId: a.tenant_id, name: a.name, category: a.category, description: a.description,
    meetingSchedule: a.meeting_schedule, active: a.active, patrons: patrons.get(a.id) ?? [],
  }));
}

/** The activities this teacher is a patron of. */
export async function fetchMyPatronActivityIds(teacherId: string): Promise<Set<string>> {
  const { data, error } = await supabase().from("activity_patrons").select("activity_id").eq("teacher_id", teacherId)
    .returns<{ activity_id: string }[]>();
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.activity_id));
}

/** How many learners are in each activity (staff only: families can't count other people's children). */
export async function fetchMemberCounts(tenantId: string): Promise<Map<string, number>> {
  const rows = await fetchAllPages<{ activity_id: string }>((from, to) =>
    supabase().from("activity_members").select("activity_id").eq("tenant_id", tenantId)
      .order("activity_id").order("student_id").range(from, to).returns<{ activity_id: string }[]>());
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.activity_id, (out.get(r.activity_id) ?? 0) + 1);
  return out;
}

/** Events in the school, optionally for one activity. */
export async function fetchActivityEvents(tenantId: string, activityId?: string): Promise<ActivityEventRow[]> {
  let q = supabase().from("activity_events").select(EVENT_COLUMNS).eq("tenant_id", tenantId);
  if (activityId) q = q.eq("activity_id", activityId);
  const { data, error } = await q.order("starts_at", { ascending: false }).returns<EventDb[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toEvent);
}

type LearnerDb = { full_name: string; classes: { name: string } | null } | null;

export async function fetchActivityMembers(activityId: string): Promise<MemberRow[]> {
  const { data, error } = await supabase().from("activity_members")
    .select("student_id, role, joined_on, students(full_name, classes(name))").eq("activity_id", activityId)
    .returns<{ student_id: string; role: string | null; joined_on: string; students: LearnerDb }[]>();
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((m) => ({ studentId: m.student_id, name: m.students?.full_name ?? "Learner", className: m.students?.classes?.name ?? "", role: m.role, joinedOn: m.joined_on }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchEventParticipants(eventId: string): Promise<ParticipantRow[]> {
  const { data, error } = await supabase().from("activity_event_participants")
    .select("student_id, award, position, achievement, students(full_name, classes(name))").eq("event_id", eventId)
    .returns<{ student_id: string; award: Award | null; position: number | null; achievement: string | null; students: LearnerDb }[]>();
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((p) => ({ studentId: p.student_id, name: p.students?.full_name ?? "Learner", className: p.students?.classes?.name ?? "", award: p.award, position: p.position, achievement: p.achievement }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface LearnerOption { id: string; name: string; className: string; admissionNo: string }

/** Every active learner, for the member and participant pickers. */
export async function fetchActiveLearners(tenantId: string): Promise<LearnerOption[]> {
  const rows = await fetchAllPages<{ id: string; full_name: string; admission_no: string; classes: { name: string } | null }>((from, to) =>
    supabase().from("students").select("id, full_name, admission_no, classes(name)").eq("tenant_id", tenantId).eq("active", true)
      .order("full_name").order("id").range(from, to)
      .returns<{ id: string; full_name: string; admission_no: string; classes: { name: string } | null }[]>());
  return rows.map((s) => ({ id: s.id, name: s.full_name, className: s.classes?.name ?? "", admissionNo: s.admission_no }));
}

/** The school's teachers, for the patron picker. */
export async function fetchTeachers(tenantId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase().from("profiles").select("id, full_name").eq("tenant_id", tenantId).eq("role", "teacher")
    .order("full_name").returns<{ id: string; full_name: string }[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((t) => ({ id: t.id, name: t.full_name }));
}

// ---------------------------------------------------------------- one learner

export interface LearnerAchievement extends Pick<ParticipantRow, "award" | "position" | "achievement"> {
  event: ActivityEventRow;
  activityName: string;
}

export interface LearnerActivities {
  clubs: { activity: ActivityRow; role: string | null; joinedOn: string }[];
  /** Events of their clubs, and any other event they're down for, still to come. */
  upcoming: (ActivityEventRow & { activityName: string; takingPart: boolean })[];
  achievements: LearnerAchievement[];
}

/** A learner's clubs, what's coming up for them, and what they've won. Works for staff and for the learner's own family. */
export async function loadLearnerActivities(tenantId: string, studentId: string, now: Date = new Date()): Promise<LearnerActivities> {
  const sb = supabase();
  const [activities, { data: memberships, error: mErr }, { data: parts, error: pErr }] = await Promise.all([
    fetchActivities(tenantId),
    sb.from("activity_members").select("activity_id, role, joined_on").eq("student_id", studentId)
      .returns<{ activity_id: string; role: string | null; joined_on: string }[]>(),
    sb.from("activity_event_participants").select("event_id, award, position, achievement").eq("student_id", studentId)
      .returns<{ event_id: string; award: Award | null; position: number | null; achievement: string | null }[]>(),
  ]);
  if (mErr) throw new Error(mErr.message);
  if (pErr) throw new Error(pErr.message);

  const byId = new Map(activities.map((a) => [a.id, a]));
  const clubIds = (memberships ?? []).map((m) => m.activity_id);
  const partByEvent = new Map((parts ?? []).map((p) => [p.event_id, p]));

  // Their clubs' events, plus any event they're down for in a club they're not in.
  const filters = [
    clubIds.length ? `activity_id.in.(${clubIds.join(",")})` : "",
    partByEvent.size ? `id.in.(${[...partByEvent.keys()].join(",")})` : "",
  ].filter(Boolean);
  let events: ActivityEventRow[] = [];
  if (filters.length) {
    const { data, error } = await sb.from("activity_events").select(EVENT_COLUMNS).eq("tenant_id", tenantId).or(filters.join(","))
      .order("starts_at").returns<EventDb[]>();
    if (error) throw new Error(error.message);
    events = (data ?? []).map(toEvent);
  }

  const activityName = (id: string) => byId.get(id)?.name ?? "Activity";
  const { upcoming } = splitEvents(events, now);
  const achievements: LearnerAchievement[] = [];
  for (const e of events) {
    const p = partByEvent.get(e.id);
    if (p && isAchievement(p)) {
      achievements.push({ award: p.award, position: p.position, achievement: p.achievement, event: e, activityName: activityName(e.activityId) });
    }
  }
  achievements.sort((a, b) => b.event.startsAt.localeCompare(a.event.startsAt));

  return {
    clubs: (memberships ?? [])
      .filter((m) => byId.has(m.activity_id))
      .map((m) => ({ activity: byId.get(m.activity_id)!, role: m.role, joinedOn: m.joined_on }))
      .sort((a, b) => a.activity.name.localeCompare(b.activity.name)),
    upcoming: upcoming.map((e) => ({ ...e, activityName: activityName(e.activityId), takingPart: partByEvent.has(e.id) })),
    achievements,
  };
}

// ---------------------------------------------------------------- writing

export async function createActivity(tenantId: string, input: ActivityInput): Promise<string> {
  const { data, error } = await supabase().from("activities").insert({
    tenant_id: tenantId, name: input.name, category: input.category, description: input.description, meeting_schedule: input.meetingSchedule,
  }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.code === "23505" ? "There's already an activity with that name." : error.message);
  return data.id;
}

/** A patron may only send description and meetingSchedule; the database refuses the rest. */
export async function updateActivity(id: string, patch: Partial<ActivityInput> & { active?: boolean }): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.category !== undefined) row.category = patch.category;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.meetingSchedule !== undefined) row.meeting_schedule = patch.meetingSchedule;
  if (patch.active !== undefined) row.active = patch.active;
  const { error } = await supabase().from("activities").update(row).eq("id", id);
  if (error) throw new Error(error.code === "23505" ? "There's already an activity with that name." : error.message);
}

export async function deleteActivity(id: string): Promise<void> {
  const { error } = await supabase().from("activities").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setActivityPatrons(tenantId: string, activityId: string, current: string[], wanted: string[]): Promise<void> {
  const { add, remove } = diffIds(current, wanted);
  const sb = supabase();
  if (remove.length) {
    const { error } = await sb.from("activity_patrons").delete().eq("activity_id", activityId).in("teacher_id", remove);
    if (error) throw new Error(error.message);
  }
  if (add.length) {
    const { error } = await sb.from("activity_patrons").insert(add.map((teacher_id) => ({ activity_id: activityId, teacher_id, tenant_id: tenantId })));
    if (error) throw new Error(error.message);
  }
}

export async function addActivityMembers(tenantId: string, activityId: string, studentIds: string[]): Promise<void> {
  if (!studentIds.length) return;
  const { error } = await supabase().from("activity_members")
    .upsert(studentIds.map((student_id) => ({ activity_id: activityId, student_id, tenant_id: tenantId })), { onConflict: "activity_id,student_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

export async function removeActivityMember(activityId: string, studentId: string): Promise<void> {
  const { error } = await supabase().from("activity_members").delete().eq("activity_id", activityId).eq("student_id", studentId);
  if (error) throw new Error(error.message);
}

export async function setMemberRole(activityId: string, studentId: string, role: string): Promise<void> {
  const { error } = await supabase().from("activity_members").update({ role: role.trim() || null }).eq("activity_id", activityId).eq("student_id", studentId);
  if (error) throw new Error(error.message);
}

function eventRow(input: EventInput) {
  return {
    activity_id: input.activityId, title: input.title, kind: input.kind, level: input.level,
    starts_at: input.startsAt, ends_at: input.endsAt, venue: input.venue, opponent: input.opponent,
    status: input.status, score: input.score, outcome: input.outcome, position: input.position, notes: input.notes,
  };
}

/** Saves a new event (no id) or changes one; returns its id. tenant_id is filled in by the database from the activity. */
export async function saveActivityEvent(tenantId: string, input: EventInput, id?: string): Promise<string> {
  const sb = supabase();
  if (id) {
    const { error } = await sb.from("activity_events").update(eventRow(input)).eq("id", id);
    if (error) throw new Error(error.message);
    return id;
  }
  const { data, error } = await sb.from("activity_events").insert({ ...eventRow(input), tenant_id: tenantId }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function deleteActivityEvent(id: string): Promise<void> {
  const { error } = await supabase().from("activity_events").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setEventParticipants(tenantId: string, eventId: string, current: string[], wanted: string[]): Promise<void> {
  const { add, remove } = diffIds(current, wanted);
  const sb = supabase();
  if (remove.length) {
    const { error } = await sb.from("activity_event_participants").delete().eq("event_id", eventId).in("student_id", remove);
    if (error) throw new Error(error.message);
  }
  if (add.length) {
    const { error } = await sb.from("activity_event_participants").insert(add.map((student_id) => ({ event_id: eventId, student_id, tenant_id: tenantId })));
    if (error) throw new Error(error.message);
  }
}

export async function saveParticipantResult(eventId: string, studentId: string, r: { award: Award | null; position: number | null; achievement: string }): Promise<void> {
  const { error } = await supabase().from("activity_event_participants")
    .update({ award: r.award, position: r.position, achievement: r.achievement.trim() || null })
    .eq("event_id", eventId).eq("student_id", studentId);
  if (error) throw new Error(error.message);
}

/**
 * Tells the participants' families (and the participants who have a login)
 * about an event: an in-app announcement to exactly those people, then a
 * push. The announcement is the part that matters; a push failure comes
 * back for the caller to show, it doesn't undo anything.
 */
export async function notifyEventFamilies(input: {
  tenantId: string; authorId: string; event: ActivityEventRow; activityName: string;
}): Promise<{ reached: number; pushError: string | null }> {
  const sb = supabase();
  const { data: ids, error: idErr } = await sb.rpc("activity_event_family", { p_event_id: input.event.id });
  if (idErr) throw new Error(idErr.message);
  const profileIds = (ids ?? []) as string[];
  if (!profileIds.length) return { reached: 0, pushError: null };

  const notice = eventNotice(input.event, input.activityName);
  const { data: created, error } = await sb.from("announcements").insert({
    tenant_id: input.tenantId,
    author_id: input.authorId,
    subject: notice.subject,
    body: notice.body,
    audience: { kind: "people", profile_ids: profileIds } satisfies Audience,
    channels: ["in_app", "push"],
    published_at: new Date().toISOString(),
  }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.message);

  await sb.from("activity_events").update({ notified_at: new Date().toISOString() }).eq("id", input.event.id);
  const { error: pushErr } = await sb.functions.invoke("send-push", { body: { announcement_id: created.id } });
  return { reached: profileIds.length, pushError: pushErr ? pushErr.message : null };
}
