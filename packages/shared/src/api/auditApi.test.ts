import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_PAGE_SIZE, fetchAuditEvents } from "../audit";
import { initBackend } from "../backend";
import { auditCapabilities } from "../capabilities";
import { BASE, createFakeApi, type FakeApi, type FakeCall, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { API_AUDIT_SEARCH_MAX, AUDIT_SYSTEM_ACTOR, apiFetchAuditEvents, auditEventFromApi, resetAuditCursors } from "./auditApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { isApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const U_ADMIN = "44444444-4444-4444-8444-444444444444";
const ROUTE = "GET /v1/tenants/11111111-1111-4111-8111-111111111111/audit-events";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eventRow = (n: number, o: Record<string, unknown> = {}) => ({
  id: uuid(n),
  occurred_at: new Date(Date.UTC(2026, 10, 25, 12, 0, 0) - n * 60_000).toISOString(),
  event_type: "finance.payment.recorded",
  label: "Payment recorded",
  category: "financial",
  actor_user_id: U_ADMIN,
  actor_name: "Grace Wanjiku",
  ...o,
});

/** A log of `total` events that answers by cursor: the cursor "c<n>" starts at event n; `tag` makes the cursors of two filter sets differ. */
function logOf(total: number, tag = ""): (call: FakeCall) => FakeReply {
  return (call) => {
    const limit = Number(call.query.get("limit"));
    const cursor = call.query.get("cursor");
    const start = cursor ? Number(cursor.slice(cursor.lastIndexOf("c") + 1)) : 0;
    const end = Math.min(start + limit, total);
    return {
      body: {
        events: Array.from({ length: end - start }, (_, i) => eventRow(start + i)),
        page: { limit, next_cursor: end < total ? `${tag}c${end}` : null },
      },
    };
  };
}

let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  resetAuditCursors();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U_ADMIN }));
  setApiActiveTenant(T);
  return api;
}

const cursorsSent = (calls: FakeCall[]) => calls.map((c) => c.query.get("cursor"));
const ids = (events: { id: string }[]) => events.map((e) => e.id);

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  resetAuditCursors();
  initBackend({ kind: "supabase" });
});

describe("capabilities and the mapping", () => {
  it("offers everything on Supabase, and neither field changes nor the whole log on the API", () => {
    initBackend({ kind: "supabase" });
    expect(auditCapabilities()).toEqual({ fieldChanges: true, everyChange: true });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(auditCapabilities()).toEqual({ fieldChanges: false, everyChange: false });
  });

  it("maps a row onto the screen's AuditEvent: the label is the event, the name is the actor, there is no detail", () => {
    expect(auditEventFromApi(T, eventRow(1) as never)).toEqual({
      id: uuid(1),
      tenant_id: T,
      actor_id: U_ADMIN,
      actor_label: "Grace Wanjiku",
      event: "Payment recorded",
      category: "financial",
      metadata: { event_type: "finance.payment.recorded" },
      created_at: eventRow(1).occurred_at,
    });
  });

  it("words the two HR & Payroll events as the Supabase build does, and leaves every other event's label alone", () => {
    const words = (event_type: string, label: string) => auditEventFromApi(T, eventRow(4, { event_type, label, category: "access" }) as never).event;
    expect(words("hr.handoff.opened", "Handoff opened")).toBe("Opened HR & Payroll (one-time sign-in link)");
    expect(words("hr.handoff.requested", "Handoff requested")).toBe("Asked Figbloom for HR & Payroll");
    expect(words("hr.handoff.refused", "Handoff refused")).toBe("Handoff refused");
    expect(words("finance.payment.recorded", "Payment recorded")).toBe("Payment recorded");
  });

  it("puts an event with no actor down to the system, and an actor with no name to an unknown person", () => {
    expect(auditEventFromApi(T, eventRow(2, { actor_user_id: null, actor_name: null }) as never)).toMatchObject({ actor_id: null, actor_label: AUDIT_SYSTEM_ACTOR });
    expect(auditEventFromApi(T, eventRow(3, { actor_name: null }) as never)).toMatchObject({ actor_id: U_ADMIN, actor_label: "Unknown person" });
  });
});

describe("the first page and its filters", () => {
  it("asks for one page of the active school, sends no filter that is empty, and maps every row", async () => {
    boot({ [ROUTE]: logOf(3) });
    const rows = await apiFetchAuditEvents(T, { category: "", search: "   ", since: "" }, 0, AUDIT_PAGE_SIZE);
    expect(rows.map((r) => r.event)).toEqual(["Payment recorded", "Payment recorded", "Payment recorded"]);
    expect(api.calls).toHaveLength(1);
    const q = api.calls[0]!.query;
    expect(q.get("limit")).toBe("100");
    for (const name of ["cursor", "category", "since", "search"]) expect(q.has(name), name).toBe(false);
    expect(api.calls[0]!.headers["x-tenant-id"]).toBe(T);
  });

  it("sends the category and the day as they are, and the search trimmed", async () => {
    boot({ [ROUTE]: logOf(1) });
    await apiFetchAuditEvents(T, { category: "financial", since: "2026-11-01", search: "  payment  " }, 0, 100);
    const q = api.calls[0]!.query;
    expect(q.get("category")).toBe("financial");
    expect(q.get("since")).toBe("2026-11-01");
    expect(q.get("search")).toBe("payment");
  });

  it("cuts a search to the API's limit instead of letting it be refused", async () => {
    boot({ [ROUTE]: logOf(1) });
    await apiFetchAuditEvents(T, { search: "a".repeat(120) }, 0, 100);
    expect(api.calls[0]!.query.get("search")).toBe("a".repeat(API_AUDIT_SEARCH_MAX));
    await apiFetchAuditEvents(T, { search: `${"x".repeat(API_AUDIT_SEARCH_MAX - 1)} yyyy` }, 0, 100);
    expect(api.calls[1]!.query.get("search")).toBe("x".repeat(API_AUDIT_SEARCH_MAX - 1));
  });

  it("an empty log is an empty list", async () => {
    boot({ [ROUTE]: logOf(0) });
    expect(await apiFetchAuditEvents(T, {}, 0, 100)).toEqual([]);
  });
});

describe("paging by offset over cursors", () => {
  it("'Show older events' is one request each: the cursor of the page before is held", async () => {
    boot({ [ROUTE]: logOf(250) });
    const first = await apiFetchAuditEvents(T, {}, 0, 100);
    const second = await apiFetchAuditEvents(T, {}, 100, 100);
    const third = await apiFetchAuditEvents(T, {}, 200, 100);
    expect([first.length, second.length, third.length]).toEqual([100, 100, 50]);
    expect(ids([...first, ...second, ...third])).toEqual(Array.from({ length: 250 }, (_, i) => uuid(i)));
    expect(cursorsSent(api.calls)).toEqual([null, "c100", "c200"]);
  });

  it("a page asked for with no cursor held is found by reading the pages before it, once", async () => {
    boot({ [ROUTE]: logOf(250) });
    const third = await apiFetchAuditEvents(T, {}, 200, 100);
    expect(ids(third)).toEqual(Array.from({ length: 50 }, (_, i) => uuid(200 + i)));
    expect(cursorsSent(api.calls)).toEqual([null, "c100", "c200"]);
    // what that read learned is kept: the page before is now one request
    const second = await apiFetchAuditEvents(T, {}, 100, 100);
    expect(ids(second)[0]).toBe(uuid(100));
    expect(cursorsSent(api.calls)).toEqual([null, "c100", "c200", "c100"]);
  });

  it("reading from the start again forgets the cursors held, so a newer log cannot be stepped over", async () => {
    boot({ [ROUTE]: logOf(250) });
    await apiFetchAuditEvents(T, {}, 0, 100);
    await apiFetchAuditEvents(T, {}, 100, 100);
    await apiFetchAuditEvents(T, {}, 200, 100);
    api.calls.length = 0;
    await apiFetchAuditEvents(T, {}, 0, 100); // the filter was applied again: a fresh read, and only c100 is known again
    const third = await apiFetchAuditEvents(T, {}, 200, 100);
    expect(ids(third)).toEqual(Array.from({ length: 50 }, (_, i) => uuid(200 + i)));
    expect(cursorsSent(api.calls)).toEqual([null, "c100", "c200"]);
  });

  it("each filter set has its own cursors, and never borrows another's", async () => {
    // the cursor names the search it was made under, so a borrowed one would show
    boot({ [ROUTE]: (call) => logOf(250, call.query.get("search") ?? "none-")(call) });
    await apiFetchAuditEvents(T, { search: "alice" }, 0, 100);
    await apiFetchAuditEvents(T, { search: "brian" }, 0, 100);
    await apiFetchAuditEvents(T, { search: "alice" }, 100, 100);
    await apiFetchAuditEvents(T, { search: "brian" }, 100, 100);
    expect(cursorsSent(api.calls)).toEqual([null, null, "alicec100", "brianc100"]);
    // a filter set nothing was read under starts from the first page
    await apiFetchAuditEvents(T, { category: "access" }, 100, 100);
    expect(cursorsSent(api.calls).slice(-2)).toEqual([null, "none-c100"]);
  });

  it("asking past the end gives nothing, and does not loop", async () => {
    boot({ [ROUTE]: logOf(30) });
    expect(await apiFetchAuditEvents(T, {}, 100, 100)).toEqual([]);
    expect(api.calls).toHaveLength(1);
    expect(await apiFetchAuditEvents(T, {}, 30, 100)).toEqual([]);
  });

  it("a page boundary that is not a multiple of the page size still returns the right events", async () => {
    boot({ [ROUTE]: logOf(250) });
    const rows = await apiFetchAuditEvents(T, {}, 150, 100);
    expect(ids(rows)).toEqual(Array.from({ length: 100 }, (_, i) => uuid(150 + i)));
  });
});

describe("when the log cannot be read", () => {
  it("a refusal says so in words, and keeps the API's error type", async () => {
    boot({ [ROUTE]: { status: 403, body: { error: { code: "forbidden", message: "Missing permission" } } } });
    const err = await apiFetchAuditEvents(T, {}, 0, 100).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect(err).toMatchObject({ status: 403, code: "forbidden", message: "You don't have permission to read the audit log." });
  });

  it("a refused filter is the server's own sentence", async () => {
    boot({ [ROUTE]: { status: 400, body: { error: { code: "validation_error", message: "since must be a real date, yyyy-mm-dd" } } } });
    await expect(apiFetchAuditEvents(T, { since: "2026-02-31" }, 0, 100)).rejects.toThrow("since must be a real date, yyyy-mm-dd");
  });

  it("no answer at all is a sentence about the connection", async () => {
    boot({ [ROUTE]: { networkError: true } });
    await expect(apiFetchAuditEvents(T, {}, 0, 100)).rejects.toThrow("Can't reach the server. Check your connection and try again.");
  });
});

describe("fetchAuditEvents on the API build", () => {
  it("is the API read, one screen page at a time, and never touches Supabase", async () => {
    boot({ [ROUTE]: logOf(3) });
    const rows = await fetchAuditEvents(T, { category: "financial" }, 0);
    expect(rows).toHaveLength(3);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.query.get("limit")).toBe(String(AUDIT_PAGE_SIZE));
    expect(api.calls[0]!.query.get("category")).toBe("financial");
    expect(rows[0]).toMatchObject({ event: "Payment recorded", actor_label: "Grace Wanjiku", tenant_id: T });
  });
});
