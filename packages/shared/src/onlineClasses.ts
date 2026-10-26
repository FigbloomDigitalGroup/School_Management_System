import { supabase } from "./supabase";
import { WEEKDAYS } from "./timetable";
import type { TimetableSlot, Weekday } from "./types";

/**
 * Online classes for days the school can't meet in person (teachers'
 * strikes, protests, insecurity, floods). There's no built-in video: a
 * teacher pastes a Google Meet / Zoom / Teams link and learners tap "Join".
 * Lessons still follow the normal weekly timetable_slots; the three tables
 * here (supabase/migrations/20261025010000_online_classes.sql) only say
 * which periods are online on a date and where to join them.
 *
 * The resolution logic is pure (resolveOnlineDay) so web, the family app
 * and the teacher app all agree on which link a period uses.
 */

export interface RemoteDay {
  id: string;
  tenant_id: string;
  starts_on: string;   // "2026-10-12"
  ends_on: string;     // inclusive
  reason: string;      // "Teachers' strike"
  created_by: string | null;
  created_at: string;
}

export interface ClassMeetingLink {
  id: string;
  tenant_id: string;
  class_id: string;
  /** null = the class-wide room, used for any period without its own link */
  subject_id: string | null;
  url: string;
  created_by: string | null;
  updated_at: string;
}

export interface OnlineLesson {
  id: string;
  tenant_id: string;
  class_id: string;
  on_date: string;
  start_time: string;
  subject_id: string | null;
  /** null = online, using the class's standing link */
  url: string | null;
  note: string | null;
  created_by: string | null;
}

export type MeetingProvider = "meet" | "zoom" | "teams" | "other";

export const MEETING_PROVIDER_LABEL: Record<MeetingProvider, string> = {
  meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams", other: "Online lesson",
};

/** Which app a pasted link opens, for the "Join on Zoom" label. */
export function meetingProvider(url: string): MeetingProvider {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is("meet.google.com")) return "meet";
  if (is("zoom.us") || is("zoom.com")) return "zoom";
  if (is("teams.microsoft.com") || is("teams.live.com")) return "teams";
  return "other";
}

/** Mirrors the database's is_meeting_url() check, so a bad link is caught before saving. */
export function isMeetingUrl(url: string): boolean {
  return url.length <= 2000 && /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/i.test(url);
}

/**
 * What a teacher pasted, made into a link we'll save — or null if it isn't
 * one. Teachers copy "meet.google.com/abc-defg-hij" without the scheme all
 * the time, so that's filled in; plain http is upgraded, since every
 * provider we expect serves https.
 */
export function normaliseMeetingUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  return isMeetingUrl(url) ? url : null;
}

/** "2026-10-12" for a Date, in the device's own timezone (toISOString would be UTC — yesterday, before 3am in Nairobi). */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function addDays(iso: string, n: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + n);
  return localIsoDate(d);
}

/** Timetable day for a date, or null at the weekend. */
export function weekdayOfDate(iso: string): Weekday | null {
  const dow = parseIsoDate(iso).getDay(); // 0=Sun..6=Sat
  return dow >= 1 && dow <= 5 ? WEEKDAYS[dow - 1]! : null;
}

/** The school days (Mon–Fri) from start to end inclusive. */
export function schoolDatesBetween(startsOn: string, endsOn: string): string[] {
  const out: string[] = [];
  for (let d = startsOn; d <= endsOn; d = addDays(d, 1)) {
    if (weekdayOfDate(d)) out.push(d);
  }
  return out;
}

/** The remote-day block covering a date — the most recently declared one if two overlap. */
export function remoteDayOn(date: string, remoteDays: RemoteDay[]): RemoteDay | null {
  let hit: RemoteDay | null = null;
  for (const r of remoteDays) {
    if (r.starts_on <= date && date <= r.ends_on && (!hit || r.created_at > hit.created_at)) hit = r;
  }
  return hit;
}

/** The first school day of a remote block that's still to come (today counts), or null once it's over. */
export function nextRemoteSchoolDate(remoteDay: Pick<RemoteDay, "starts_on" | "ends_on">, today: string = localIsoDate()): string | null {
  const from = remoteDay.starts_on > today ? remoteDay.starts_on : today;
  return schoolDatesBetween(from, remoteDay.ends_on)[0] ?? null;
}

export type LinkSource = "lesson" | "subject_link" | "class_link";

export interface OnlinePeriod {
  classId: string;
  time: string;
  label: string;
  room: string;
  subjectId: string | null;
  mode: "in_person" | "online";
  joinUrl: string | null;
  provider: MeetingProvider | null;
  /** where joinUrl came from — dated lesson override, the subject's standing room, or the class-wide room */
  source: LinkSource | null;
  /** the teacher's note on a dated online lesson ("bring your Chemistry notes") */
  note: string | null;
  /** an online academic lesson nobody has put a link on yet */
  needsLink: boolean;
  /** the online lesson row behind this period, when one was set for this date */
  onlineLessonId: string | null;
}

export interface OnlineDay {
  date: string;
  weekday: Weekday | null;
  remoteDay: RemoteDay | null;
  periods: OnlinePeriod[];
}

type SlotLike = Pick<TimetableSlot, "class_id" | "day" | "start_time" | "label" | "room" | "subject_id">;

/** A class's standing link for a subject, falling back to its class-wide room. */
export function standingLinkFor(
  classId: string, subjectId: string | null, links: Pick<ClassMeetingLink, "class_id" | "subject_id" | "url">[],
): { url: string; source: "subject_link" | "class_link" } | null {
  if (subjectId) {
    const own = links.find((l) => l.class_id === classId && l.subject_id === subjectId);
    if (own) return { url: own.url, source: "subject_link" };
  }
  const classWide = links.find((l) => l.class_id === classId && l.subject_id === null);
  return classWide ? { url: classWide.url, source: "class_link" } : null;
}

/**
 * Every period on a date with whether it's online and where to join.
 *
 * A period is online when the date is inside a remote-day block, or a
 * teacher made that one dated lesson online. Its link is the dated lesson's
 * own link if it has one, else the class+subject standing link, else the
 * class-wide one. Non-subject periods (Games, Break, Class meeting) are
 * online on a remote day too, but never "need" a link — there may simply be
 * no session for them.
 */
export function resolveOnlineDay(input: {
  date: string;
  slots: SlotLike[];
  remoteDays: RemoteDay[];
  links: Pick<ClassMeetingLink, "class_id" | "subject_id" | "url">[];
  lessons: Pick<OnlineLesson, "id" | "class_id" | "on_date" | "start_time" | "subject_id" | "url" | "note">[];
}): OnlineDay {
  const { date, slots, remoteDays, links, lessons } = input;
  const weekday = weekdayOfDate(date);
  const remoteDay = remoteDayOn(date, remoteDays);
  const lessonByKey = new Map(
    lessons.filter((l) => l.on_date === date).map((l) => [`${l.class_id}|${l.start_time}`, l]),
  );

  const periods: OnlinePeriod[] = !weekday ? [] : slots
    .filter((s) => s.day === weekday)
    .map((s): OnlinePeriod => {
      const lesson = lessonByKey.get(`${s.class_id}|${s.start_time}`) ?? null;
      const online = !!remoteDay || !!lesson;
      let joinUrl: string | null = null;
      let source: LinkSource | null = null;
      if (online) {
        if (lesson?.url) {
          joinUrl = lesson.url;
          source = "lesson";
        } else {
          const standing = standingLinkFor(s.class_id, s.subject_id ?? lesson?.subject_id ?? null, links);
          if (standing) {
            joinUrl = standing.url;
            source = standing.source;
          }
        }
      }
      return {
        classId: s.class_id,
        time: s.start_time,
        label: s.label,
        room: s.room ?? "",
        subjectId: s.subject_id,
        mode: online ? "online" : "in_person",
        joinUrl,
        provider: joinUrl ? meetingProvider(joinUrl) : null,
        source,
        note: lesson?.note ?? null,
        needsLink: online && !joinUrl && (!!s.subject_id || !!lesson),
        onlineLessonId: lesson?.id ?? null,
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time) || a.classId.localeCompare(b.classId));

  return { date, weekday, remoteDay, periods };
}

/** "12 of 40 lessons have no link" — only academic online lessons count. */
export function linkGaps(periods: OnlinePeriod[]): { lessons: number; missing: number } {
  const lessons = periods.filter((p) => p.mode === "online" && (p.subjectId || p.joinUrl || p.needsLink));
  return { lessons: lessons.length, missing: lessons.filter((p) => p.needsLink).length };
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Mon 12" / "Mon 12 October" — built by hand so it reads the same on every device locale. */
function dayLabel(iso: string, withMonth: boolean): string {
  const d = parseIsoDate(iso);
  return `${DAY_SHORT[d.getDay()]} ${d.getDate()}${withMonth ? ` ${MONTH[d.getMonth()]}` : ""}`;
}

/**
 * Plain-English dates for a remote block: "Mon 12 and Tue 13 October",
 * "Fri 30 October and Mon 2 November", "Mon 12 to Fri 23 October".
 * Weekends inside the range are left out of a short list (no lessons then).
 */
export function formatRemoteRange(startsOn: string, endsOn: string): string {
  const dates = schoolDatesBetween(startsOn, endsOn);
  const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);
  if (dates.length === 0 || dates.length > 3) {
    if (startsOn === endsOn) return dayLabel(startsOn, true);
    return `${dayLabel(startsOn, !sameMonth(startsOn, endsOn))} to ${dayLabel(endsOn, true)}`;
  }
  const allSame = sameMonth(dates[0]!, dates[dates.length - 1]!);
  const parts = dates.map((d, i) => dayLabel(d, !allSame || i === dates.length - 1));
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Teachers' strike" -> "teachers' strike" for mid-sentence use; leaves "KCSE marking" alone. */
function midSentence(reason: string): string {
  const r = reason.trim();
  return /^[A-Z][a-z]/.test(r) ? r.charAt(0).toLowerCase() + r.slice(1) : r;
}

/** The whole-school notice sent when the office declares remote days. */
export function remoteDaysAnnouncement(startsOn: string, endsOn: string, reason: string): { subject: string; body: string } {
  const range = formatRemoteRange(startsOn, endsOn);
  return {
    subject: `School is online on ${range}`,
    body:
      `School is online on ${range} (${midSentence(reason)}). Lessons follow the normal timetable; join links are in the app.\n\n` +
      "Parents: please have a phone, tablet or computer ready with data or wifi, find your child a quiet place to sit, " +
      "and make sure they tap Join a few minutes before each lesson starts.",
  };
}

/** The notice sent when the office ends remote days early or cancels them. */
export function backInPersonAnnouncement(fromDate: string): { subject: string; body: string } {
  const day = dayLabel(fromDate, true);
  return {
    subject: `School is back in person from ${day}`,
    body: `School is back in person from ${day}. Lessons are in class as normal; there are no online links to join.`,
  };
}

// ---------------------------------------------------------------- data access

/** Remote-day blocks that haven't finished yet (today included), soonest first. */
export async function fetchUpcomingRemoteDays(fromDate: string = localIsoDate()): Promise<RemoteDay[]> {
  const { data, error } = await supabase()
    .from("remote_days").select("*").gte("ends_on", fromDate).order("starts_on").returns<RemoteDay[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * One date's online picture for some classes (or the whole school when
 * classIds is omitted — RLS keeps that to the caller's own school; tenantId
 * narrows it for an org admin who can read several).
 */
export async function fetchOnlineDay(date: string, opts: { classIds?: string[]; tenantId?: string } = {}): Promise<OnlineDay> {
  const { classIds, tenantId } = opts;
  if (classIds && classIds.length === 0) return resolveOnlineDay({ date, slots: [], remoteDays: [], links: [], lessons: [] });
  const sb = supabase();
  const weekday = weekdayOfDate(date);

  let slotsQ = sb.from("timetable_slots").select("class_id, day, start_time, label, room, subject_id").eq("day", weekday ?? "Mon");
  let linksQ = sb.from("class_meeting_links").select("class_id, subject_id, url");
  let lessonsQ = sb.from("online_lessons").select("id, class_id, on_date, start_time, subject_id, url, note").eq("on_date", date);
  let remoteQ = sb.from("remote_days").select("*").lte("starts_on", date).gte("ends_on", date);
  if (classIds) {
    slotsQ = slotsQ.in("class_id", classIds);
    linksQ = linksQ.in("class_id", classIds);
    lessonsQ = lessonsQ.in("class_id", classIds);
  }
  if (tenantId) {
    slotsQ = slotsQ.eq("tenant_id", tenantId);
    linksQ = linksQ.eq("tenant_id", tenantId);
    lessonsQ = lessonsQ.eq("tenant_id", tenantId);
    remoteQ = remoteQ.eq("tenant_id", tenantId);
  }

  const [slots, links, lessons, remote] = await Promise.all([
    weekday ? slotsQ.returns<SlotLike[]>() : Promise.resolve({ data: [] as SlotLike[], error: null }),
    linksQ.returns<Pick<ClassMeetingLink, "class_id" | "subject_id" | "url">[]>(),
    lessonsQ.returns<Pick<OnlineLesson, "id" | "class_id" | "on_date" | "start_time" | "subject_id" | "url" | "note">[]>(),
    remoteQ.returns<RemoteDay[]>(),
  ]);
  for (const r of [slots, links, lessons, remote]) if (r.error) throw new Error(r.error.message);

  return resolveOnlineDay({
    date, slots: slots.data ?? [], remoteDays: remote.data ?? [], links: links.data ?? [], lessons: lessons.data ?? [],
  });
}

/** Standing links for some classes — the teacher's "your meeting rooms" list. */
export async function fetchClassMeetingLinks(classIds: string[]): Promise<ClassMeetingLink[]> {
  if (!classIds.length) return [];
  const { data, error } = await supabase()
    .from("class_meeting_links").select("*").in("class_id", classIds).returns<ClassMeetingLink[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Sets (or replaces) a class's standing link for a subject, or its
 * class-wide room when subjectId is null. Select-then-write rather than an
 * upsert: the unique key is NULLS NOT DISTINCT on a nullable column, which
 * isn't something to lean on ON CONFLICT inference for.
 */
export async function saveClassMeetingLink(tenantId: string, classId: string, subjectId: string | null, url: string): Promise<void> {
  const sb = supabase();
  let q = sb.from("class_meeting_links").select("id").eq("class_id", classId);
  q = subjectId ? q.eq("subject_id", subjectId) : q.is("subject_id", null);
  const { data: existing, error: findErr } = await q.maybeSingle<{ id: string }>();
  if (findErr) throw new Error(findErr.message);
  const { error } = existing
    ? await sb.from("class_meeting_links").update({ url, updated_at: new Date().toISOString() }).eq("id", existing.id)
    : await sb.from("class_meeting_links").insert({ tenant_id: tenantId, class_id: classId, subject_id: subjectId, url });
  if (error) throw new Error(error.message);
}

export async function deleteClassMeetingLink(id: string): Promise<void> {
  const { error } = await supabase().from("class_meeting_links").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Makes one dated period online (url null = use the standing link), or updates its link/note. */
export async function saveOnlineLesson(row: {
  tenantId: string; classId: string; onDate: string; startTime: string;
  subjectId: string | null; url: string | null; note: string | null;
}): Promise<void> {
  const { error } = await supabase().from("online_lessons").upsert({
    tenant_id: row.tenantId, class_id: row.classId, on_date: row.onDate, start_time: row.startTime,
    subject_id: row.subjectId, url: row.url, note: row.note?.trim() || null,
  }, { onConflict: "class_id,on_date,start_time" });
  if (error) throw new Error(error.message);
}

export async function deleteOnlineLesson(id: string): Promise<void> {
  const { error } = await supabase().from("online_lessons").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Posts a whole-school in-app + push notice, the same way the Announcements composer sends one. */
async function announceToSchool(tenantId: string, authorId: string, notice: { subject: string; body: string }): Promise<string | null> {
  const sb = supabase();
  const { data: created, error } = await sb.from("announcements").insert({
    tenant_id: tenantId,
    author_id: authorId,
    subject: notice.subject,
    body: notice.body,
    audience: { kind: "whole_school" },
    channels: ["in_app", "push"],
    published_at: new Date().toISOString(),
  }).select("id").single<{ id: string }>();
  if (error) return error.message;
  const { error: pushErr } = await sb.functions.invoke("send-push", { body: { announcement_id: created.id } });
  return pushErr ? pushErr.message : null;
}

/**
 * Declares remote days and tells the whole school. The block is saved first
 * — a failed notice must never undo the switch itself — and the notice
 * failure comes back for the caller to show.
 */
export async function declareRemoteDays(input: {
  tenantId: string; authorId: string; startsOn: string; endsOn: string; reason: string;
}): Promise<{ noticeError: string | null }> {
  const { error } = await supabase().from("remote_days").insert({
    tenant_id: input.tenantId, starts_on: input.startsOn, ends_on: input.endsOn, reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);
  const noticeError = await announceToSchool(
    input.tenantId, input.authorId, remoteDaysAnnouncement(input.startsOn, input.endsOn, input.reason),
  );
  return { noticeError };
}

/**
 * Ends a remote block so school is back in person from `backOn`. A block
 * that hasn't started yet by then is removed outright (cancelled); one
 * already under way is cut short to the day before. Tells everyone either way.
 */
export async function endRemoteDays(input: {
  remoteDay: RemoteDay; backOn: string; tenantId: string; authorId: string;
}): Promise<{ noticeError: string | null }> {
  const { remoteDay, backOn } = input;
  const sb = supabase();
  const { error } = backOn <= remoteDay.starts_on
    ? await sb.from("remote_days").delete().eq("id", remoteDay.id)
    : await sb.from("remote_days").update({ ends_on: addDays(backOn, -1) }).eq("id", remoteDay.id);
  if (error) throw new Error(error.message);
  const noticeError = await announceToSchool(input.tenantId, input.authorId, backInPersonAnnouncement(backOn));
  return { noticeError };
}
