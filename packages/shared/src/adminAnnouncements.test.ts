import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Supabase client with a few tables in memory. `eq`, `in` and `not` really filter, `order` and
 * `limit` really order and cut, and a head count answers with the number of rows it matched.
 */
type Row = Record<string, unknown>;
const db: { tables: Record<string, Row[]>; insertError: { message: string } | null; pushError: { message: string } | null } = {
  tables: {}, insertError: null, pushError: null,
};
const inserted: { table: string; row: Row }[] = [];
const pushes: unknown[] = [];

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let sort: { col: string; ascending: boolean } | null = null;
  let cut: number | null = null;
  let counting = false;
  const rows = () => {
    let out = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (sort) {
      const { col, ascending } = sort;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (ascending ? 1 : -1));
    }
    return cut === null ? out : out.slice(0, cut);
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => resolve(counting ? { data: null, count: rows().length, error: null } : { data: rows(), error: null });
      if (method === "insert") {
        return (row: Row) => {
          inserted.push({ table, row });
          const result = db.insertError ? { data: null, error: db.insertError } : { data: { id: "new-announcement" }, error: null };
          const chain: unknown = { select: () => ({ single: () => Promise.resolve(result) }) };
          return chain;
        };
      }
      return (...args: unknown[]) => {
        if (method === "select" && (args[1] as { head?: boolean } | undefined)?.head) counting = true;
        if (method === "eq") filters.push((r) => !(String(args[0]) in r) || r[String(args[0])] === args[1]);
        if (method === "in") filters.push((r) => !(String(args[0]) in r) || (args[1] as unknown[]).includes(r[String(args[0])]));
        if (method === "not") filters.push((r) => r[String(args[0])] !== null);
        if (method === "order") sort = { col: String(args[0]), ascending: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false };
        if (method === "limit") cut = Number(args[0]);
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => builder(table),
    functions: { invoke: (name: string, opts: unknown) => { pushes.push({ name, opts }); return Promise.resolve({ error: db.pushError }); } },
  }),
}));

import {
  activeChannels, announcementAudience, announcementReach, AUDIENCE_CHOICES, DEFAULT_CHANNELS, fetchAnnouncementsData, insertAnnouncement,
  RECIPIENT_OPTIONS, sendAnnouncementPush, smsCostCents, type AnnouncementsData,
} from "./adminAnnouncements";

const T = "school-1";
const cls = (id: string, name: string, level: string, form_level: number): Row => ({ id, tenant_id: T, name, level, form_level });
const kid = (id: string, class_id: string, profile_id: string | null): Row => ({ id, class_id, tenant_id: T, active: true, profile_id });
const guardian = (profile_id: string, student_id: string): Row => ({ id: `${profile_id}-${student_id}`, tenant_id: T, profile_id, student_id });
const person = (id: string, role: string): Row => ({ id, tenant_id: T, role });

beforeEach(() => {
  inserted.length = 0;
  pushes.length = 0;
  db.insertError = null;
  db.pushError = null;
  db.tables = {
    classes: [cls("c1", "Grade 1 East", "primary", 1), cls("c2", "Grade 1 West", "primary", 1), cls("c3", "Form 2A", "secondary", 2)],
    // Grade 1 East: two learners (one has her own login); Grade 1 West: one; Form 2A: one with a login. One learner left the school.
    students: [kid("s1", "c1", "p-s1"), kid("s2", "c1", null), kid("s3", "c2", null), kid("s4", "c3", "p-s4"), { ...kid("gone", "c1", "p-gone"), active: false }],
    // Mary is the parent of both Grade 1 East learners and of the Grade 1 West one; Joel of one in East.
    guardians: [guardian("mary", "s1"), guardian("mary", "s2"), guardian("mary", "s3"), guardian("joel", "s2"), guardian("ruth", "s4")],
    profiles: [
      person("mary", "parent"), person("joel", "parent"), person("ruth", "parent"), person("p-s1", "student"), person("p-s4", "student"),
      person("t1", "teacher"), person("t2", "teacher"), person("a1", "school_admin"), person("d1", "driver"), person("r1", "staff"),
    ],
    announcements: [
      { id: "n1", tenant_id: T, subject: "Fees", published_at: "2026-11-01T08:00:00Z" },
      { id: "n2", tenant_id: T, subject: "Draft nobody sent", published_at: null },
      { id: "n3", tenant_id: T, subject: "Half term", published_at: "2026-11-05T08:00:00Z" },
    ],
  };
});

describe("fetchAnnouncementsData", () => {
  it("counts the school's accounts by role, and staff as admins, teachers, drivers and other staff", async () => {
    const d = await fetchAnnouncementsData(T);
    expect(d.byRole).toEqual({ everyone: 10, parents: 3, students: 2, teachers: 2, staff: 5 });
  });

  it("counts the distinct parents and the learners with their own login behind each class, once each", async () => {
    const d = await fetchAnnouncementsData(T);
    // Mary and Joel for Grade 1 East (Mary is the parent of two of its learners), one learner with a login
    expect(d.reachByClass.get("c1")).toEqual({ guardians: 2, students: 1, both: 3 });
    expect(d.reachByClass.get("c2")).toEqual({ guardians: 1, students: 0, both: 1 });
    expect(d.reachByClass.get("c3")).toEqual({ guardians: 1, students: 1, both: 2 });
  });

  it("counts a year group across its classes without counting a parent twice, and keeps Grade 1 apart from Form 1", async () => {
    const d = await fetchAnnouncementsData(T);
    expect(d.reachByYear.get("primary:1")).toEqual({ guardians: 2, students: 1, both: 3 });
    expect(d.reachByYear.get("secondary:2")).toEqual({ guardians: 1, students: 1, both: 2 });
    expect(d.years.map((y) => y.key)).toEqual(["primary:1", "secondary:2"]);
  });

  it("lists what was sent lately, newest first, and leaves out drafts", async () => {
    const d = await fetchAnnouncementsData(T);
    expect(d.recent.map((r) => r.subject)).toEqual(["Half term", "Fees"]);
  });
});

describe("who a choice reaches", () => {
  let data: AnnouncementsData;
  beforeEach(async () => { data = await fetchAnnouncementsData(T); });

  it("is the school's accounts for the school-wide choices", () => {
    expect(announcementReach(data, "whole_school", "both", "", "")).toBe(10);
    expect(announcementReach(data, "parents", "both", "", "")).toBe(3);
    expect(announcementReach(data, "students", "both", "", "")).toBe(2);
    expect(announcementReach(data, "teachers", "both", "", "")).toBe(2);
    expect(announcementReach(data, "staff", "both", "", "")).toBe(5);
  });

  it("is a class's or year group's parents, learners or both, as chosen", () => {
    expect(announcementReach(data, "class", "guardians", "", "c1")).toBe(2);
    expect(announcementReach(data, "class", "students", "", "c1")).toBe(1);
    expect(announcementReach(data, "class", "both", "", "c1")).toBe(3);
    expect(announcementReach(data, "year", "both", "primary:1", "")).toBe(3);
  });

  it("is nobody for a class or year group it does not know", () => {
    expect(announcementReach(data, "class", "both", "", "nope")).toBe(0);
    expect(announcementReach(data, "year", "both", "", "")).toBe(0);
  });
});

describe("the audience a choice stores", () => {
  const year = { key: "primary:1", level: "primary" as const, year: 1 };
  it("is the school, one role, or the staff roles for the school-wide choices", () => {
    expect(announcementAudience("whole_school", "both", null, "")).toEqual({ kind: "whole_school" });
    expect(announcementAudience("parents", "both", null, "")).toEqual({ kind: "role", role: "parent" });
    expect(announcementAudience("students", "both", null, "")).toEqual({ kind: "role", role: "student" });
    expect(announcementAudience("teachers", "both", null, "")).toEqual({ kind: "role", role: "teacher" });
    expect(announcementAudience("staff", "both", null, "")).toEqual({ kind: "roles", roles: ["school_admin", "teacher", "driver", "staff"] });
  });
  it("is a class, or a year group in its level, with who in it gets it", () => {
    expect(announcementAudience("class", "guardians", null, "c1")).toEqual({ kind: "class", class_id: "c1", recipients: "guardians" });
    expect(announcementAudience("year", "students", year, "")).toEqual({ kind: "form_level", form_level: 1, level: "primary", recipients: "students" });
  });
  it("falls back to year 1 when a school has no year groups yet", () => {
    expect(announcementAudience("year", "both", null, "")).toEqual({ kind: "form_level", form_level: 1, recipients: "both" });
  });
});

describe("how it goes out", () => {
  it("starts with the app and push on, and SMS and email off", () => {
    expect(activeChannels(DEFAULT_CHANNELS)).toEqual(["in_app", "push"]);
    expect(activeChannels({ in_app: true, push: false, sms: true, email: true })).toEqual(["in_app", "sms", "email"]);
  });
  it("prices SMS at 80 cents a person, in cents", () => {
    expect(smsCostCents(0)).toBe(0);
    expect(smsCostCents(412)).toBe(32_960);
    expect(smsCostCents(3)).toBe(240);
  });
  it("offers seven audiences and three ways to address a class or year group", () => {
    expect(AUDIENCE_CHOICES.map((a) => a.id)).toEqual(["whole_school", "parents", "students", "teachers", "staff", "year", "class"]);
    expect(RECIPIENT_OPTIONS.map((r) => r.value)).toEqual(["both", "guardians", "students"]);
  });
});

describe("insertAnnouncement", () => {
  const draft = { subject: "  Half-term  ", body: "  Closing Friday.\n", audience: { kind: "whole_school" as const }, channels: DEFAULT_CHANNELS };

  it("writes a trimmed notice from the sender, published now, with the channels switched on", async () => {
    const id = await insertAnnouncement(T, "admin-1", draft, true);
    expect(id).toBe("new-announcement");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.table).toBe("announcements");
    expect(inserted[0]?.row).toMatchObject({
      tenant_id: T, author_id: "admin-1", subject: "Half-term", body: "Closing Friday.", audience: { kind: "whole_school" }, channels: ["in_app", "push"],
    });
    expect(typeof inserted[0]?.row.published_at).toBe("string");
  });

  it("keeps it unpublished when it is not to go out yet", async () => {
    await insertAnnouncement(T, "admin-1", draft, false);
    expect(inserted[0]?.row.published_at).toBeNull();
  });

  it("fails with the database's own message when it cannot be written", async () => {
    db.insertError = { message: "new row violates row-level security policy" };
    await expect(insertAnnouncement(T, "admin-1", draft, true)).rejects.toThrow("new row violates row-level security policy");
  });
});

describe("sendAnnouncementPush", () => {
  it("asks send-push to notify that announcement's audience", async () => {
    await sendAnnouncementPush("n9");
    expect(pushes).toEqual([{ name: "send-push", opts: { body: { announcement_id: "n9" } } }]);
  });
  it("fails with the push service's message", async () => {
    db.pushError = { message: "FCM unavailable" };
    await expect(sendAnnouncementPush("n9")).rejects.toThrow("FCM unavailable");
  });
});
