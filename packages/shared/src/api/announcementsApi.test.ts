import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnnouncementsData, insertAnnouncement, sendAnnouncementPush, DEFAULT_CHANNELS } from "../adminAnnouncements";
import { initBackend } from "../backend";
import { announcementsCapabilities } from "../capabilities";
import { publishAnnouncement } from "../materials";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { activeApiChannels, recentAnnouncementFromApi } from "./announcementsApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";

const stamp = { created_at: "2026-11-20T08:00:00Z", updated_at: "2026-11-20T08:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({ id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o });
const klass = (o: Record<string, unknown> = {}) => ({
  id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 West", form_level: 2, education_level: "secondary",
  pathway: null, stream: "West", class_teacher_staff_id: null, active: true, archived_at: null, ...stamp, ...o,
});
const announcement = (o: Record<string, unknown> = {}) => ({
  id: A1, tenant_id: T, author_id: "u1", subject: "Half-term closing", body: "School closes Friday.",
  audience: { kind: "whole_school" }, channels: ["in_app", "push"], published_at: "2026-11-22T09:00:00Z", created_at: "2026-11-22T09:00:00Z", ...o,
});
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

let api: FakeApi;
const P = `/v1/tenants/${T}`;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: "u1" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("capabilities & helpers", () => {
  it("hides reachCounts, attachments, signatures, aiHelper and smsAndEmail on the API, and enables all on Supabase", () => {
    initBackend({ kind: "supabase" });
    expect(announcementsCapabilities()).toEqual({
      reachCounts: true, attachments: true, signatures: true, aiHelper: true, smsAndEmail: true,
    });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(announcementsCapabilities()).toEqual({
      reachCounts: false, attachments: false, signatures: false, aiHelper: false, smsAndEmail: false,
    });
  });

  it("always includes in_app in activeApiChannels", () => {
    expect(activeApiChannels({ in_app: false, push: true, sms: false, email: false })).toEqual(["in_app", "push"]);
    expect(activeApiChannels({ in_app: true, push: false, sms: true, email: true })).toEqual(["in_app", "sms", "email"]);
  });

  it("maps an API announcement to RecentAnnouncement", () => {
    expect(recentAnnouncementFromApi(announcement() as never)).toEqual({
      id: A1, subject: "Half-term closing", published_at: "2026-11-22T09:00:00Z",
    });
  });
});

describe("fetchAnnouncementsData on API", () => {
  it("loads current-year classes in year order, year groups, and recently published announcements", async () => {
    boot({
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [
        klass({ id: C1, name: "Form 2 West", form_level: 2, education_level: "secondary" }),
        klass({ id: C2, name: "Grade 1 East", form_level: 1, education_level: "primary" }),
      ]),
      [`GET ${P}/communications/announcements`]: list("announcements", [
        announcement({ id: A1, subject: "Older notice", published_at: "2026-11-20T08:00:00Z" }),
        announcement({ id: A2, subject: "Newer notice", published_at: "2026-11-22T10:00:00Z" }),
      ]),
    });

    const d = await fetchAnnouncementsData(T);
    expect(d.classes.map((c) => c.name)).toEqual(["Grade 1 East", "Form 2 West"]);
    expect(d.years.map((y) => y.key)).toEqual(["primary:1", "secondary:2"]);
    expect(d.recent.map((r) => r.subject)).toEqual(["Newer notice", "Older notice"]);
    expect(d.byRole).toEqual({ everyone: 0, parents: 0, students: 0, teachers: 0, staff: 0 });
    expect(api.calls.find((c) => c.path === `${P}/communications/announcements`)?.query.get("published")).toBe("true");
  });

  it("returns an empty class list without failing when a communication-only user cannot read classes (403)", async () => {
    boot({
      [`GET ${P}/academic-years`]: refused("forbidden", 403, "missing resource.academics.read"),
      [`GET ${P}/communications/announcements`]: list("announcements", [announcement()]),
    });

    const d = await fetchAnnouncementsData(T);
    expect(d.classes).toEqual([]);
    expect(d.years).toEqual([]);
    expect(d.recent).toHaveLength(1);
  });
});

describe("insertAnnouncement, publishAnnouncement & sendAnnouncementPush on API", () => {
  const draft = {
    subject: "  Half-term closing  ",
    body: "  School closes Friday. \n",
    audience: { kind: "whole_school" as const },
    channels: DEFAULT_CHANNELS,
  };

  it("creates a draft and does not call publish when publishNow is false", async () => {
    boot({
      [`POST ${P}/communications/announcements`]: { status: 201, body: { announcement: announcement({ published_at: null }) } },
    });

    const id = await insertAnnouncement(T, "u1", draft, false);
    expect(id).toBe(A1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.body).toEqual({
      subject: "Half-term closing",
      body: "School closes Friday.",
      audience: { kind: "whole_school" },
      channels: ["in_app", "push"],
    });
  });

  it("creates and immediately publishes when publishNow is true", async () => {
    boot({
      [`POST ${P}/communications/announcements`]: { status: 201, body: { announcement: announcement({ published_at: null }) } },
      [`POST ${P}/communications/announcements/${A1}/publish`]: { status: 200, body: { announcement: announcement() } },
    });

    const id = await insertAnnouncement(T, "u1", draft, true);
    expect(id).toBe(A1);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${P}/communications/announcements`,
      `POST ${P}/communications/announcements/${A1}/publish`,
    ]);
  });

  it("publishes an existing draft via publishAnnouncement", async () => {
    boot({
      [`POST ${P}/communications/announcements/${A1}/publish`]: { status: 200, body: { announcement: announcement() } },
    });

    await publishAnnouncement(A1, T);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${P}/communications/announcements/${A1}/publish`,
    ]);
  });

  it("treats sendAnnouncementPush as a no-op on API because publish already enqueues push", async () => {
    boot({});
    await sendAnnouncementPush(A1);
    expect(api.calls).toHaveLength(0);
  });
});
