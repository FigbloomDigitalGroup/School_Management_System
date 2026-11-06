import { supabase } from "./supabase";
import { fetchAllPages } from "./paging";
import { STAFF_ROLES, type AudienceRecipients } from "./audience";
import { yearGroupKey, yearGroupsOf, type YearGroup } from "./levels";
import type { Audience, ClassGroup } from "./types";

/**
 * The school's announcement composer: who a notice can go to and how many people that reaches, how it goes out
 * and what the SMS part costs, and the insert and the push that send it. It was inline in the web's
 * Announcements screen; it lives here so the phone's composer sends the same way. The database decides who an
 * audience reaches (20261026030000); the counts here only tell the sender what to expect.
 */

/** The composer's choices. Each maps to one Audience. */
export type AudienceChoice = "whole_school" | "parents" | "students" | "teachers" | "staff" | "year" | "class";

export const AUDIENCE_CHOICES: { id: AudienceChoice; label: string; hint?: string }[] = [
  { id: "whole_school", label: "Whole school", hint: "Staff, parents and students" },
  { id: "parents", label: "All parents" },
  { id: "students", label: "All students", hint: "Learners with their own login" },
  { id: "teachers", label: "All teachers" },
  { id: "staff", label: "All staff", hint: "Office, teachers and drivers" },
  { id: "year", label: "One year group" },
  { id: "class", label: "One class" },
];

/** Whether a year group's or a class's notice goes to the parents, the learners with their own login, or both. */
export const RECIPIENT_OPTIONS: { value: AudienceRecipients; label: string }[] = [
  { value: "both", label: "Parents and students" },
  { value: "guardians", label: "Parents only" },
  { value: "students", label: "Students only" },
];

export interface ChannelFlags { in_app: boolean; push: boolean; sms: boolean; email: boolean }

/** In the app and push are free, so they start on; SMS costs money and email often has no working address. */
export const DEFAULT_CHANNELS: ChannelFlags = { in_app: true, push: true, sms: false, email: false };

export const CHANNEL_OPTIONS: { key: keyof ChannelFlags; label: string; note: string }[] = [
  { key: "in_app", label: "In the app", note: "Free. Everyone with an account sees it." },
  { key: "push", label: "Push notification", note: "Free. Android only for now — reaches the phone even if the app is closed." },
  { key: "sms", label: "SMS", note: "Charged per recipient. Reaches parents with no smartphone." },
  { key: "email", label: "Email", note: "Free, but many parents have no working address." },
];

/** The channels switched on, as the database stores them. */
export function activeChannels(flags: ChannelFlags): (keyof ChannelFlags)[] {
  return (Object.keys(flags) as (keyof ChannelFlags)[]).filter((k) => flags[k]);
}

/** What one SMS costs the school, in the school's currency. SMS costs real money per recipient, so the sender sees the total first. */
export const SMS_COST_PER_RECIPIENT = 0.8;

/** The bill for texting this many people, in cents. */
export function smsCostCents(reach: number): number {
  return Math.round(reach * SMS_COST_PER_RECIPIENT * 100);
}

export interface RecentAnnouncement {
  id: string;
  subject: string;
  published_at: string | null;
}

/** How many people, per side, a class or year group reaches. */
export interface Reach { guardians: number; students: number; both: number }

export interface AnnouncementsData {
  classes: Pick<ClassGroup, "id" | "name" | "level" | "form_level">[];
  /** Accounts at the school, by role. */
  byRole: { everyone: number; parents: number; students: number; teachers: number; staff: number };
  /** Keyed by yearGroupKey(level, form_level) — Grade 1 and Form 1 are both form_level 1. */
  reachByYear: Map<string, Reach>;
  /** Year groups that actually have classes, youngest first. */
  years: YearGroup[];
  reachByClass: Map<string, Reach>;
  recent: RecentAnnouncement[];
}

/** Distinct parent and learner accounts behind a set of learners. */
function reachOf(students: { id: string; profile_id: string | null }[], parentsOf: Map<string, string[]>): Reach {
  const learners = new Set(students.map((s) => s.profile_id).filter((p): p is string => !!p));
  const parents = new Set(students.flatMap((s) => parentsOf.get(s.id) ?? []));
  return { guardians: parents.size, students: learners.size, both: parents.size + learners.size };
}

/** What the composer needs before it can say who a notice reaches: the classes, the headcounts, and what was sent lately. */
export async function fetchAnnouncementsData(tenantId: string): Promise<AnnouncementsData> {
  const sb = supabase();
  const count = (roles: string[]) =>
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).in("role", roles);

  const [{ data: classRows }, students, guardians, everyone, parents, learners, teachers, staff, { data: recent }] = await Promise.all([
    sb.from("classes").select("id,name,level,form_level").eq("tenant_id", tenantId).order("form_level").order("name").returns<Pick<ClassGroup, "id" | "name" | "level" | "form_level">[]>(),
    fetchAllPages<{ id: string; class_id: string; profile_id: string | null }>((from, to) =>
      sb.from("students").select("id,class_id,profile_id").eq("tenant_id", tenantId).eq("active", true).order("id").range(from, to)
        .returns<{ id: string; class_id: string; profile_id: string | null }[]>()),
    fetchAllPages<{ profile_id: string; student_id: string }>((from, to) =>
      sb.from("guardians").select("profile_id,student_id").eq("tenant_id", tenantId).order("id").range(from, to)
        .returns<{ profile_id: string; student_id: string }[]>()),
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    count(["parent"]),
    count(["student"]),
    count(["teacher"]),
    count(STAFF_ROLES),
    sb.from("announcements").select("id,subject,published_at").eq("tenant_id", tenantId).not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(5).returns<RecentAnnouncement[]>(),
  ]);

  const classes = classRows ?? [];
  const classById = new Map(classes.map((c) => [c.id, c]));
  const parentsOf = new Map<string, string[]>();
  for (const g of guardians) parentsOf.set(g.student_id, [...(parentsOf.get(g.student_id) ?? []), g.profile_id]);

  const byClass = new Map<string, typeof students>();
  const byYear = new Map<string, typeof students>();
  for (const s of students) {
    byClass.set(s.class_id, [...(byClass.get(s.class_id) ?? []), s]);
    const cls = classById.get(s.class_id);
    if (cls) { const k = yearGroupKey(cls.level, cls.form_level); byYear.set(k, [...(byYear.get(k) ?? []), s]); }
  }

  return {
    classes,
    byRole: {
      everyone: everyone.count ?? 0, parents: parents.count ?? 0, students: learners.count ?? 0,
      teachers: teachers.count ?? 0, staff: staff.count ?? 0,
    },
    reachByYear: new Map([...byYear.entries()].map(([k, list]) => [k, reachOf(list, parentsOf)])),
    years: yearGroupsOf(classRows ?? []),
    reachByClass: new Map([...byClass.entries()].map(([k, list]) => [k, reachOf(list, parentsOf)])),
    recent: recent ?? [],
  };
}

/** How many people this choice reaches. `yearKey` is a year group's key, `classId` a class's id; both only matter for their own choice. */
export function announcementReach(data: AnnouncementsData, choice: AudienceChoice, recipients: AudienceRecipients, yearKey: string, classId: string): number {
  switch (choice) {
    case "whole_school": return data.byRole.everyone;
    case "parents": return data.byRole.parents;
    case "students": return data.byRole.students;
    case "teachers": return data.byRole.teachers;
    case "staff": return data.byRole.staff;
    case "year": return data.reachByYear.get(yearKey)?.[recipients] ?? 0;
    case "class": return data.reachByClass.get(classId)?.[recipients] ?? 0;
  }
}

/** The Audience the database stores for this choice. */
export function announcementAudience(choice: AudienceChoice, recipients: AudienceRecipients, yearGroup: YearGroup | null, classId: string): Audience {
  switch (choice) {
    case "whole_school": return { kind: "whole_school" };
    case "parents": return { kind: "role", role: "parent" };
    case "students": return { kind: "role", role: "student" };
    case "teachers": return { kind: "role", role: "teacher" };
    case "staff": return { kind: "roles", roles: STAFF_ROLES };
    case "year": return yearGroup
      ? { kind: "form_level", form_level: yearGroup.year, level: yearGroup.level, recipients }
      : { kind: "form_level", form_level: 1, recipients };
    case "class": return { kind: "class", class_id: classId, recipients };
  }
}

export interface AnnouncementDraft {
  subject: string;
  body: string;
  audience: Audience;
  channels: ChannelFlags;
}

/**
 * Writes the announcement. Sent now, it is published at once; otherwise it is kept as a draft (the web does that
 * while a notice's files go up, and publishes it after). Answers its id.
 */
export async function insertAnnouncement(tenantId: string, authorId: string, draft: AnnouncementDraft, publishNow: boolean): Promise<string> {
  const { data, error } = await supabase().from("announcements").insert({
    tenant_id: tenantId,
    author_id: authorId,
    subject: draft.subject.trim(),
    body: draft.body.trim(),
    audience: draft.audience,
    channels: activeChannels(draft.channels),
    published_at: publishNow ? new Date().toISOString() : null,
  }).select("id").single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data.id;
}

/** Asks the push service to notify the announcement's audience. The announcement is already sent; a failure here is only the push. */
export async function sendAnnouncementPush(announcementId: string): Promise<void> {
  const { error } = await supabase().functions.invoke("send-push", { body: { announcement_id: announcementId } });
  if (error) throw new Error(error.message);
}
