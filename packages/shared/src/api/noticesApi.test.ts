import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAnnouncement } from "../adminAnnouncements";
import { initBackend } from "../backend";
import { canMessageClasses, isNotOnApiError } from "../capabilities";
import { fetchStaffNotices } from "../otherStaff";
import { subscribeAnnouncements } from "../parentData";
import { fetchSentByMe, fetchTeacherNotices, fetchTeacherUnreadNoticeCount, markNoticeRead, sendClassMessage } from "../teacherData";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { resetDirectory } from "./directoryApi";
import { INBOX_NOTICES } from "./noticesApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const ANN = "aaaaaaaa-0000-4000-8000-000000000002";
const OFFICE = "aaaaaaaa-0000-4000-8000-000000000003";
const CLASS = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const P = `/v1/tenants/${T}`;
const INBOX = `GET ${P}/communications/announcements/inbox`;

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });
const stamp = { created_at: "2026-11-20T08:00:00Z", updated_at: "2026-11-20T08:00:00Z" };
const staff = (o: Record<string, unknown> = {}) => ({
  id: "s1", tenantId: T, full_name: "Ann Mwangi", staff_title: null, classification: "teacher", phone: null, email: null, userId: ANN, active: true, archived_at: null, ...stamp, ...o,
});
const notice = (id: string, author: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, author_id: author, subject: `Subject ${id}`, body: `Body of ${id}`, audience: { kind: "whole_school" }, channels: ["in_app"],
  published_at: "2026-11-22T09:00:00Z", created_at: "2026-11-22T08:30:00Z", ...o,
});

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  resetDirectory();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: ME }));
  setApiActiveTenant(T);
  return api;
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetApiClient();
  resetDirectory();
  initBackend({ kind: "supabase" });
});

describe("canMessageClasses", () => {
  it("is every teacher on Supabase, and only the Communication area on the API", () => {
    initBackend({ kind: "supabase" });
    expect(canMessageClasses([])).toBe(true);
    initBackend({ kind: "api", apiUrl: BASE });
    expect(canMessageClasses([])).toBe(false);
    expect(canMessageClasses(["people", "fees"])).toBe(false);
    expect(canMessageClasses(["people", "communication"])).toBe(true);
  });
});

describe("the inbox on the API (teacher and staff notices)", () => {
  it("lists what reaches the person, newest first, with no unread marks", async () => {
    boot({
      [INBOX]: {
        body: {
          announcements: [
            notice("n1", OFFICE, { published_at: "2026-11-20T09:00:00Z" }),
            notice("n3", OFFICE, { published_at: "2026-11-23T09:00:00Z" }),
            notice("n2", ME, { published_at: "2026-11-22T09:00:00Z" }),
            notice("n4", ANN, { published_at: "2026-11-21T09:00:00Z" }),
          ],
          page: page(),
        },
      },
      [`GET ${P}/staff`]: { body: { staff: [staff()], page: page() } },
    });
    const list = await fetchTeacherNotices(ME);
    expect(list.map((n) => n.id)).toEqual(["n3", "n2", "n4", "n1"]);
    expect(list.every((n) => n.unread === false)).toBe(true);
    expect(list.map((n) => n.from)).toEqual(["School office", "You", "Ann Mwangi", "School office"]);
    expect(list[0]).toMatchObject({ subject: "Subject n3", body: "Body of n3" });
    expect(typeof list[0]!.when).toBe("string");
    expect(list[0]!.when.length).toBeGreaterThan(0);
  });

  it("calls an author the office when the staff list cannot be read or does not know them", async () => {
    boot({
      [INBOX]: { body: { announcements: [notice("n1", ANN), notice("n2", "aaaaaaaa-0000-4000-8000-000000000009")], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    expect((await fetchTeacherNotices(ME)).map((n) => n.from)).toEqual(["School office", "School office"]);
  });

  it("does not call a non-teacher staff member by name: the office wrote it", async () => {
    boot({
      [INBOX]: { body: { announcements: [notice("n1", ANN)], page: page() } },
      [`GET ${P}/staff`]: { body: { staff: [staff({ classification: "school_admin", full_name: "The Principal" })], page: page() } },
    });
    expect((await fetchTeacherNotices(ME))[0]!.from).toBe("School office");
  });

  it("uses the publish time, or the creation time when there is none", async () => {
    boot({
      [INBOX]: { body: { announcements: [notice("n1", OFFICE, { published_at: null, created_at: "2026-11-25T08:00:00Z" }), notice("n2", OFFICE)], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    expect((await fetchTeacherNotices(ME)).map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("reads at most the newest 400, a page of 200 at a time, and stops there", async () => {
    const full = (tag: string) => Array.from({ length: 200 }, (_, i) => notice(`${tag}${i}`, OFFICE, { published_at: `2026-11-22T09:${String(i % 60).padStart(2, "0")}:00Z` }));
    boot({
      [INBOX]: (call) => (call.query.get("cursor") === "p2" ? { body: { announcements: full("b"), page: page("p3") } } : { body: { announcements: full("a"), page: page("p2") } }),
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    const list = await fetchTeacherNotices(ME);
    expect(INBOX_NOTICES).toBe(400);
    expect(list).toHaveLength(400);
    expect(api.callsTo(INBOX).map((c) => c.query.get("limit"))).toEqual(["200", "200"]);
  });

  it("the badge count is 0: nothing shows as unread", async () => {
    boot({
      [INBOX]: { body: { announcements: [notice("n1", OFFICE)], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    expect(await fetchTeacherUnreadNoticeCount(ME)).toBe(0);
  });

  it("other staff read the same inbox", async () => {
    boot({
      [INBOX]: { body: { announcements: [notice("n1", OFFICE)], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    expect((await fetchStaffNotices(ME)).map((n) => n.id)).toEqual(["n1"]);
  });

  it("opening a notice tells the server once with the read endpoint", async () => {
    boot({ [`POST ${P}/communications/announcements/n1/read`]: { status: 204 } });
    await markNoticeRead(ME, "n1");
    expect(api.callsTo(`POST ${P}/communications/announcements/n1/read`)).toHaveLength(1);
  });

  it("a notice that is not the person's to read is the server's 404", async () => {
    boot({ [`POST ${P}/communications/announcements/n1/read`]: refused("not_found", 404, "Announcement not found") });
    await expect(markNoticeRead(ME, "n1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("sent by me on the API", () => {
  it("is the person's own published notices from the inbox, newest first, at most 20", async () => {
    const mine = Array.from({ length: 25 }, (_, i) => notice(`m${String(i).padStart(2, "0")}`, ME, {
      created_at: `2026-11-${String(i + 1).padStart(2, "0")}T08:00:00Z`, audience: { kind: "class", class_id: CLASS, recipients: "both" },
    }));
    boot({ [INBOX]: { body: { announcements: [...mine, notice("other", OFFICE)], page: page() } } });
    const sent = await fetchSentByMe(ME);
    expect(sent).toHaveLength(20);
    expect(sent[0]!.id).toBe("m24");
    expect(sent.every((a) => a.author_id === ME)).toBe(true);
    expect(sent[0]!.audience).toEqual({ kind: "class", class_id: CLASS, recipients: "both" });
    expect(sent[0]).toMatchObject({ tenant_id: T, channels: ["in_app"] });
  });

  it("is empty for a person who sent nothing", async () => {
    boot({ [INBOX]: { body: { announcements: [notice("other", OFFICE)], page: page() } } });
    expect(await fetchSentByMe(ME)).toEqual([]);
  });
});

describe("sending a class message on the API", () => {
  const create = `POST ${P}/communications/announcements`;
  const publish = (id: string) => `POST ${P}/communications/announcements/${id}/publish`;

  it("creates an in-app announcement for the class, then publishes it", async () => {
    boot({
      [create]: { status: 201, body: { announcement: notice("n9", ME, { published_at: null }) } },
      [publish("n9")]: { body: { announcement: notice("n9", ME) } },
    });
    const id = await sendClassMessage(T, ME, CLASS, "guardians", "  CAT results  ", "  Out on Friday.\n", {});
    expect(id).toBe("n9");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${P}/communications/announcements`, `POST ${P}/communications/announcements/n9/publish`]);
    expect(api.calls[0]!.body).toEqual({
      subject: "CAT results", body: "Out on Friday.", audience: { kind: "class", class_id: CLASS, recipients: "guardians" }, channels: ["in_app"],
    });
  });

  it("keeps who it is for: students, or both", async () => {
    boot({ [create]: { status: 201, body: { announcement: notice("n9", ME) } }, [publish("n9")]: { body: { announcement: notice("n9", ME) } } });
    await sendClassMessage(T, ME, CLASS, "both", "s", "b");
    expect((api.calls[0]!.body as { audience: { recipients: string } }).audience.recipients).toBe("both");
  });

  it("a draft is not published", async () => {
    boot({ [create]: { status: 201, body: { announcement: notice("n9", ME, { published_at: null }) } } });
    expect(await sendClassMessage(T, ME, CLASS, "guardians", "s", "b", { draft: true })).toBe("n9");
    expect(api.calls).toHaveLength(1);
  });

  it("a person without the right to announce gets the server's refusal, and nothing is published", async () => {
    boot({ [create]: refused("forbidden", 403, "Missing permission: resource.announcement.write") });
    await expect(sendClassMessage(T, ME, CLASS, "guardians", "s", "b")).rejects.toMatchObject({ status: 403 });
    expect(api.calls).toHaveLength(1);
  });

  it("a notice made but not published says so: the error is the publish's", async () => {
    boot({ [create]: { status: 201, body: { announcement: notice("n9", ME, { published_at: null }) } }, [publish("n9")]: refused("internal", 500) });
    await expect(sendClassMessage(T, ME, CLASS, "guardians", "s", "b")).rejects.toMatchObject({ status: 500 });
  });

  it("deleting a draft is not on the new system yet", async () => {
    boot({});
    const err = await deleteAnnouncement("n9").catch((e: unknown) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});

describe("subscribeAnnouncements on the API polls the inbox", () => {
  it("calls back when the newest notices change, not before, and not when nothing did", async () => {
    let rows = [notice("n1", OFFICE)];
    boot({ [INBOX]: () => ({ body: { announcements: rows, page: page() } }) });
    vi.useFakeTimers();
    const onChange = vi.fn();
    const stop = subscribeAnnouncements(T, onChange);
    expect(api.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.query.get("limit")).toBe("50");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange).not.toHaveBeenCalled();
    rows = [notice("n2", OFFICE), ...rows];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    const before = api.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.calls.length).toBe(before);
  });

  it("calls back when a notice already in the list is published", async () => {
    let rows = [notice("n1", OFFICE, { published_at: "2026-11-22T09:00:00Z" })];
    boot({ [INBOX]: () => ({ body: { announcements: rows, page: page() } }) });
    vi.useFakeTimers();
    const onChange = vi.fn();
    const stop = subscribeAnnouncements(T, onChange);
    await vi.advanceTimersByTimeAsync(30_000);
    rows = [notice("n1", OFFICE, { published_at: "2026-11-24T09:00:00Z" })];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });
});
