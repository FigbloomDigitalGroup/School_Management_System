import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { chatCapabilities, isNotOnApiError, noticesCapabilities } from "../capabilities";
import {
  chatFileUrl, fetchChatContacts, fetchChatMessages, fetchChatUnreadCount, fetchConversationPeople, fetchMyConversations, fetchSchoolConversations,
  markConversationRead, pushChatMessage, removeUnsentChatFile, sendChatMessage, startConversation, subscribeChatMessages, uploadChatBlob,
} from "../chat";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { THREAD_MESSAGES, UNKNOWN_PERSON, messageFromApi, PREVIEW_CHATS, POLL_MESSAGES } from "./chatApi";
import { DIRECTORY_TTL_MS, resetDirectory } from "./directoryApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const ANN = "aaaaaaaa-0000-4000-8000-000000000002";
const BOB = "aaaaaaaa-0000-4000-8000-000000000003";
const STRANGER = "aaaaaaaa-0000-4000-8000-000000000004";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const P = `/v1/tenants/${T}`;

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });
const stamp = { created_at: "2026-11-20T08:00:00Z", updated_at: "2026-11-20T08:00:00Z" };
const staff = (o: Record<string, unknown> = {}) => ({
  id: "s1", tenantId: T, full_name: "Ann Mwangi", staff_title: "Deputy Principal", classification: "teacher", phone: null, email: null,
  userId: ANN, active: true, archived_at: null, ...stamp, ...o,
});
const conv = (id: string, peer: string, last: string | null = "2026-11-24T10:00:00Z") => ({
  id, tenant_id: T, pair_key: `${ME}:${peer}`, created_by: ME, created_at: "2026-11-20T08:00:00Z", last_message_at: last, peer_user_id: peer,
});
const msg = (id: string, conversation: string, sender: string, body: string, at = "2026-11-24T10:00:00Z") => ({
  id, tenant_id: T, conversation_id: conversation, sender_id: sender, body, created_at: at,
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

describe("capabilities", () => {
  it("hide files, calls, oversight and unread counts on the API, and keep every one on Supabase", () => {
    initBackend({ kind: "supabase" });
    expect(chatCapabilities()).toEqual({ attachments: true, calls: true, oversight: true, unreadCounts: true });
    expect(noticesCapabilities()).toEqual({ readState: true });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(chatCapabilities()).toEqual({ attachments: false, calls: false, oversight: false, unreadCounts: false });
    expect(noticesCapabilities()).toEqual({ readState: false });
  });
});

describe("messageFromApi", () => {
  it("is a text message with no file", () => {
    expect(messageFromApi(msg("m1", C1, ANN, "hello"))).toEqual({
      id: "m1", conversationId: C1, senderId: ANN, body: "hello", filePath: null, fileName: null, mimeType: null, sizeBytes: null, createdAt: "2026-11-24T10:00:00Z",
    });
  });
});

describe("fetchMyConversations on the API", () => {
  it("names the other person from the staff list, and shows the newest message as the preview", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: [conv(C1, ANN), conv(C2, BOB, null)], page: page() } },
      [`GET ${P}/staff`]: { body: { staff: [staff()], page: page() } },
      [`GET ${P}/chat/conversations/${C1}/messages`]: { body: { messages: [msg("m2", C1, ANN, "See you Friday\nbring the forms")], page: page() } },
    });
    const list = await fetchMyConversations();
    expect(list).toEqual([
      {
        id: C1, otherId: ANN, otherName: "Ann Mwangi", otherRole: "teacher", otherAvatarUrl: null, lastMessageAt: "2026-11-24T10:00:00Z",
        lastBody: "See you Friday\nbring the forms", lastSenderId: ANN, unread: 0, canReply: true, nameKnown: true,
      },
      {
        id: C2, otherId: BOB, otherName: UNKNOWN_PERSON, otherRole: "staff", otherAvatarUrl: null, lastMessageAt: null,
        lastBody: null, lastSenderId: null, unread: 0, canReply: true, nameKnown: false,
      },
    ]);
    // The preview asked for one message; the chat with no messages was not asked.
    expect(api.callsTo(`GET ${P}/chat/conversations/${C1}/messages`)[0]!.query.get("limit")).toBe("1");
    expect(api.callsTo(`GET ${P}/chat/conversations/${C2}/messages`)).toHaveLength(0);
  });

  it("shows every chat as 'Someone at the school' for a person who may not read the staff list", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: [conv(C1, ANN)], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
      [`GET ${P}/chat/conversations/${C1}/messages`]: { body: { messages: [msg("m1", C1, ME, "hi")], page: page() } },
    });
    const [c] = await fetchMyConversations();
    expect(c).toMatchObject({ otherName: UNKNOWN_PERSON, nameKnown: false, lastBody: "hi", lastSenderId: ME });
  });

  it("does not hide a real failure of the staff list as 'not allowed'", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: [conv(C1, ANN)], page: page() } },
      [`GET ${P}/staff`]: refused("internal", 500),
    });
    await expect(fetchMyConversations()).rejects.toMatchObject({ status: 500 });
  });

  it("follows the list's pages", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: (call) => (call.query.get("cursor") === "p2"
        ? { body: { conversations: [conv(C2, BOB, null)], page: page() } }
        : { body: { conversations: [conv(C1, ANN, null)], page: page("p2") } }),
      [`GET ${P}/staff`]: { body: { staff: [], page: page() } },
    });
    expect((await fetchMyConversations()).map((c) => c.id)).toEqual([C1, C2]);
  });

  it("looks up the preview of only the newest 30 chats, and a failed preview leaves that chat without one", async () => {
    const many = Array.from({ length: 35 }, (_, i) => conv(`d${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`, ANN));
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: many, page: page() } },
      [`GET ${P}/staff`]: { body: { staff: [staff()], page: page() } },
    });
    api.on(`GET ${P}/chat/conversations/${many[0]!.id}/messages`, refused("internal", 500));
    // every other chat's route is the generic 404 of the fake; register them to answer
    for (const c of many.slice(1)) api.on(`GET ${P}/chat/conversations/${c.id}/messages`, { body: { messages: [msg("m", c.id, ANN, "x")], page: page() } });
    const list = await fetchMyConversations();
    expect(PREVIEW_CHATS).toBe(30);
    expect(list).toHaveLength(35);
    const asked = api.calls.filter((c) => c.path.endsWith("/messages"));
    expect(asked).toHaveLength(30);
    expect(list[0]!.lastBody).toBeNull();
    expect(list[1]!.lastBody).toBe("x");
    expect(list[29]!.lastBody).toBe("x");
    expect(list[30]!.lastBody).toBeNull();
  });

  it("keeps the staff list for a minute, so a polled list does not ask for it each time", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: [conv(C1, ANN, null)], page: page() } },
      [`GET ${P}/staff`]: { body: { staff: [staff()], page: page() } },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    await fetchMyConversations();
    await fetchMyConversations();
    expect(api.callsTo(`GET ${P}/staff`)).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + DIRECTORY_TTL_MS + 1));
    await fetchMyConversations();
    expect(api.callsTo(`GET ${P}/staff`)).toHaveLength(2);
  });

  it("keeps a refusal to read the staff list for a minute too", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: [], page: page() } },
      [`GET ${P}/staff`]: refused("forbidden", 403),
    });
    await fetchMyConversations();
    await fetchMyConversations();
    expect(api.callsTo(`GET ${P}/staff`)).toHaveLength(1);
  });
});

describe("fetchChatContacts on the API", () => {
  it("offers active staff who have an account, not the signed-in person, by name", async () => {
    boot({
      [`GET ${P}/staff`]: {
        body: {
          staff: [
            staff({ id: "s2", full_name: "Zed Otieno", userId: BOB, staff_title: null, classification: "driver" }),
            staff(),
            staff({ id: "s3", full_name: "No Account", userId: null }),
            staff({ id: "s4", full_name: "Left The School", userId: STRANGER, active: false }),
            staff({ id: "s5", full_name: "Me Myself", userId: ME }),
          ],
          page: page(),
        },
      },
    });
    expect(await fetchChatContacts()).toEqual([
      { profileId: ANN, name: "Ann Mwangi", role: "teacher", avatarUrl: null, detail: "Deputy Principal" },
      { profileId: BOB, name: "Zed Otieno", role: "driver", avatarUrl: null, detail: "Driver" },
    ]);
  });

  it("says it is not on the new system yet for a person who may not read the staff list", async () => {
    boot({ [`GET ${P}/staff`]: refused("forbidden", 403) });
    const err = await fetchChatContacts().catch((e: unknown) => e);
    expect(isNotOnApiError(err)).toBe(true);
    expect((err as Error).message).toBe("A list of people to chat with is not on the new system yet.");
  });
});

describe("startConversation, people and messages on the API", () => {
  it("opens a chat with the person and answers the conversation id", async () => {
    boot({ [`POST ${P}/chat/conversations`]: { status: 201, body: { conversation: conv(C1, ANN) } } });
    expect(await startConversation(ANN)).toBe(C1);
    expect(api.calls[0]!.body).toEqual({ peer_user_id: ANN });
    expect(api.calls[0]!.headers["x-tenant-id"]).toBe(T);
  });

  it("a refused pair is the server's own 403", async () => {
    boot({ [`POST ${P}/chat/conversations`]: refused("forbidden", 403, "These users may not chat") });
    await expect(startConversation(BOB)).rejects.toMatchObject({ status: 403, message: "These users may not chat" });
  });

  it("fetchConversationPeople answers the other person, named when the staff list can be read", async () => {
    boot({
      [`GET ${P}/chat/conversations`]: { body: { conversations: [conv(C1, ANN), conv(C2, BOB)], page: page() } },
      [`GET ${P}/staff`]: { body: { staff: [staff()], page: page() } },
    });
    expect(await fetchConversationPeople(C1)).toEqual([{ profileId: ANN, name: "Ann Mwangi", role: "teacher", avatarUrl: null }]);
    expect(await fetchConversationPeople(C2)).toEqual([{ profileId: BOB, name: UNKNOWN_PERSON, role: "staff", avatarUrl: null }]);
    expect(await fetchConversationPeople("c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3")).toEqual([]);
  });

  it("fetchChatMessages answers the thread oldest first, across pages", async () => {
    boot({
      [`GET ${P}/chat/conversations/${C1}/messages`]: (call) => (call.query.get("cursor") === "p2"
        ? { body: { messages: [msg("m1", C1, ANN, "first", "2026-11-24T09:00:00Z")], page: page() } }
        : { body: { messages: [msg("m3", C1, ME, "third", "2026-11-24T11:00:00Z"), msg("m2", C1, ANN, "second", "2026-11-24T10:00:00Z")], page: page("p2") } }),
    });
    const thread = await fetchChatMessages(C1);
    expect(thread.map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(api.calls[0]!.query.get("limit")).toBe("200");
  });

  it("stops at the newest 1,000 messages of a long thread", async () => {
    let n = 1_300;
    boot({
      [`GET ${P}/chat/conversations/${C1}/messages`]: (call) => {
        const cursor = Number(call.query.get("cursor") ?? 0);
        const items = Array.from({ length: 200 }, (_, i) => msg(`m${n - cursor - i}`, C1, ANN, `#${n - cursor - i}`));
        return { body: { messages: items, page: page(cursor + 200 < n ? String(cursor + 200) : null) } };
      },
    });
    const thread = await fetchChatMessages(C1);
    expect(THREAD_MESSAGES).toBe(1_000);
    expect(thread).toHaveLength(1_000);
    expect(thread[0]!.body).toBe("#301");
    expect(thread[999]!.body).toBe("#1300");
    expect(api.calls).toHaveLength(5);
  });

  it("sendChatMessage posts the trimmed text and answers the message", async () => {
    boot({ [`POST ${P}/chat/conversations/${C1}/messages`]: { status: 201, body: { message: msg("m9", C1, ME, "ok then") } } });
    const sent = await sendChatMessage(C1, "  ok then \n", undefined);
    expect(sent).toMatchObject({ id: "m9", body: "ok then", senderId: ME, filePath: null });
    expect(api.calls[0]!.body).toEqual({ body: "ok then" });
  });

  it("sendChatMessage refuses a file, and an empty message, without calling the server", async () => {
    boot({});
    const file = { path: "x", name: "x.pdf", mimeType: "application/pdf", sizeBytes: 3 };
    const err = await sendChatMessage(C1, "see attached", file).catch((e: unknown) => e);
    expect(isNotOnApiError(err)).toBe(true);
    await expect(sendChatMessage(C1, "   ", undefined)).rejects.toThrow("Write a message first.");
    await expect(sendChatMessage(C1, null, undefined)).rejects.toThrow("Write a message first.");
    expect(api.calls).toHaveLength(0);
  });

  it("markConversationRead posts to the read endpoint", async () => {
    boot({ [`POST ${P}/chat/conversations/${C1}/read`]: { status: 204 } });
    await markConversationRead(C1);
    expect(api.callsTo(`POST ${P}/chat/conversations/${C1}/read`)).toHaveLength(1);
  });
});

describe("what the API cannot do, in chat.ts", () => {
  it("has no unread count (0), no push to ask for, and nothing to remove", async () => {
    boot({});
    expect(await fetchChatUnreadCount()).toBe(0);
    await pushChatMessage("m1");
    await removeUnsentChatFile("a/b.pdf");
    expect(api.calls).toHaveLength(0);
  });

  it("says files and the office's view of every chat are not on the new system yet", async () => {
    boot({});
    const blob = new Blob(["x"]);
    for (const attempt of [
      () => uploadChatBlob(T, C1, { blob, name: "x.pdf", mimeType: "application/pdf" }),
      () => chatFileUrl("a/b.pdf"),
      () => fetchSchoolConversations(T),
    ]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(isNotOnApiError(err)).toBe(true);
    }
    expect(api.calls).toHaveLength(0);
  });
});

describe("subscribeChatMessages on the API polls", () => {
  it("an open thread asks for the newest 50 every few seconds and reports each message once, the first answer included", async () => {
    let answer = [msg("m1", C1, ANN, "one", "2026-11-24T10:00:00Z")];
    boot({ [`GET ${P}/chat/conversations/${C1}/messages`]: () => ({ body: { messages: [...answer].reverse(), page: page() } }) });
    vi.useFakeTimers();
    const got: string[] = [];
    const stop = subscribeChatMessages({ conversationId: C1 }, (m) => got.push(m.body ?? ""));
    expect(api.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(got).toEqual(["one"]);
    expect(api.calls[0]!.query.get("limit")).toBe(String(POLL_MESSAGES));
    answer = [...answer, msg("m2", C1, ANN, "two", "2026-11-24T10:00:05Z"), msg("m3", C1, BOB, "three", "2026-11-24T10:00:06Z")];
    await vi.advanceTimersByTimeAsync(4_500);
    expect(got).toEqual(["one", "two", "three"]);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(got).toEqual(["one", "two", "three"]);
    stop();
    const before = api.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls.length).toBe(before);
  });

  it("the school scope reads the newest message of a chat whose last_message_at moved, and nothing at first", async () => {
    let last = "2026-11-24T10:00:00Z";
    boot({
      [`GET ${P}/chat/conversations`]: () => ({ body: { conversations: [conv(C1, ANN, last), conv(C2, BOB, null)], page: page() } }),
      [`GET ${P}/chat/conversations/${C1}/messages`]: () => ({ body: { messages: [msg("m2", C1, ANN, "new one", last)], page: page() } }),
    });
    vi.useFakeTimers();
    const got: string[] = [];
    const stop = subscribeChatMessages({ tenantId: T }, (m) => got.push(m.body ?? ""));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual([]);
    expect(api.callsTo(`GET ${P}/chat/conversations/${C1}/messages`)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual([]);
    last = "2026-11-24T10:05:00Z";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual(["new one"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual(["new one"]);
    stop();
  });

  it("the school scope reports a chat that was started since", async () => {
    let list = [conv(C1, ANN, null)];
    boot({
      [`GET ${P}/chat/conversations`]: () => ({ body: { conversations: list, page: page() } }),
      [`GET ${P}/chat/conversations/${C2}/messages`]: { body: { messages: [msg("m1", C2, BOB, "hello there")], page: page() } },
    });
    vi.useFakeTimers();
    const got: string[] = [];
    const stop = subscribeChatMessages({ tenantId: T }, (m) => got.push(m.body ?? ""));
    await vi.advanceTimersByTimeAsync(10_000);
    list = [conv(C2, BOB, "2026-11-24T10:00:00Z"), ...list];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual(["hello there"]);
    stop();
  });
});
