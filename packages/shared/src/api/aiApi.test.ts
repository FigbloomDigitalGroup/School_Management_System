import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askTutor, draftHomework, draftMessage, draftQuestions, draftReportComments, fetchAiStatus, importPaperWithAi, saveAiSettings, translateMessage,
} from "../ai";
import {
  askBloomChat, createAiChat, deleteAiChat, deleteAiChatMessage, fetchAiChatMessages, fetchAiChats, renameAiChat, saveAiChatTurns, setAiChatWebSearch,
} from "../aiChat";
import {
  fetchAiHelperRoster, fetchAiHelperSettings, fetchAiHelperStatus, saveAiHelperSettings, setAiHelperOptIn,
} from "../aiHelper";
import { initBackend } from "../backend";
import { aiCapabilities, NotOnApiError } from "../capabilities";
import { invokeEdge } from "../edge";
import { applySetupPlan, askGuide, fetchSetupCounts, fetchSetupExisting } from "../guide";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { API_BLOOM_PROMPT_MAX, apiFetchBloomReadiness, apiQueryBloom, bloomQueryErrorMessage, formatBloomPrompt } from "./aiApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { ApiError } from "./errors";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const Y1 = "22222222-2222-4222-8222-222222222222";
const TERM1 = "33333333-3333-4333-8333-333333333333";
const L1 = "44444444-4444-4444-8444-444444444444";
const L2 = "55555555-5555-4555-8555-555555555555";
const C1 = "66666666-6666-4666-8666-666666666666";

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no"): FakeReply => ({ status, body: { error: { code, message } } });

function boot(routes: Record<string, FakeRoute> = {}): FakeApi {
  resetApiClient();
  const api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  setApiTokenStore(createMemoryTokenStore({ token: "tok-1", expiresAt: "2099-01-01T00:00:00.000Z", userId: "u-1" }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("aiCapabilities", () => {
  it("enables everything on Supabase and hides unsupported features on API", () => {
    initBackend({ kind: "supabase" });
    const sb = aiCapabilities();
    expect(sb).toEqual({
      savedChats: true,
      webSearch: true,
      chatAttachments: true,
      promptMaxChars: 12_000,
      guideSetupPlans: true,
      aiDrafting: true,
      studyHelperUsage: true,
      chatInOnePrompt: false,
      schoolSwitch: true,
    });

    initBackend({ kind: "api", apiUrl: BASE });
    const api = aiCapabilities();
    expect(api).toEqual({
      savedChats: false,
      webSearch: false,
      chatAttachments: false,
      promptMaxChars: 4_000,
      guideSetupPlans: false,
      aiDrafting: false,
      studyHelperUsage: false,
      chatInOnePrompt: true,
      schoolSwitch: false,
    });
  });
});

describe("formatBloomPrompt", () => {
  it("sends a single user turn as-is up to the limit", () => {
    expect(formatBloomPrompt([{ role: "user", content: "  Hello Bloom  " }])).toBe("Hello Bloom");
    expect(formatBloomPrompt([{ role: "user", content: "x".repeat(5000) }]).length).toBe(API_BLOOM_PROMPT_MAX);
  });

  it("packs multi-turn history newest-first within the 4,000-character budget", () => {
    const out = formatBloomPrompt(
      [
        { role: "user", content: "Old question " + "a".repeat(80) },
        { role: "assistant", content: "Old answer" },
        { role: "user", content: "Follow up" },
      ],
      60,
    );
    expect(out).toBe("Bloom: Old answer\n\nUser: Follow up");
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it("returns empty string for blank turns", () => {
    expect(formatBloomPrompt([{ role: "user", content: "   " }])).toBe("");
  });
});

describe("Bloom status & query", () => {
  it("reads readiness and maps fetchAiStatus", async () => {
    boot({
      [`GET /v1/tenants/${T}/ai/status`]: {
        body: {
          contract: "bloom-school/1",
          enabled_for_school: true,
          provider_configured: false,
          circuit: "unconfigured",
          allowed_scopes: ["public", "school"],
          tools: [],
        },
      },
    });
    const readiness = await apiFetchBloomReadiness(T);
    expect(readiness).toEqual({
      contract: "bloom-school/1",
      enabledForSchool: true,
      providerConfigured: false,
      circuit: "unconfigured",
      allowedScopes: ["public", "school"],
      tools: [],
    });

    const status = await fetchAiStatus(T);
    expect(status).toEqual({
      aiEnabled: true,
      tutorEnabled: true,
      webSearchEnabled: false,
      monthlyTokens: 0,
      usedTokens: 0,
      usedSearches: 0,
    });
  });

  it("reports aiEnabled false when allowed_scopes is empty", async () => {
    boot({
      [`GET /v1/tenants/${T}/ai/status`]: {
        body: {
          contract: "bloom-school/1",
          enabled_for_school: false,
          provider_configured: true,
          circuit: "closed",
          allowed_scopes: [],
          tools: [],
        },
      },
    });
    const status = await fetchAiStatus(T);
    expect(status?.aiEnabled).toBe(false);
    expect(status?.tutorEnabled).toBe(false);
  });

  it("asks Bloom chat and parses citations", async () => {
    const api = boot({
      [`POST /v1/tenants/${T}/ai/query`]: {
        body: {
          status: "ok",
          scope: "school",
          answer: "Fractions represent parts of a whole.",
          provider: "figbloom_ai",
          citations: [
            { title: "KICD Math", source: "https://kicd.ac.ke/math" },
            { title: "Unsafe", source: "javascript:alert(1)" },
          ],
        },
      },
    });
    const reply = await askBloomChat([{ role: "user", content: "Explain fractions" }]);
    expect(reply.text).toBe("Fractions represent parts of a whole.");
    expect(reply.sources).toEqual([
      { title: "KICD Math", url: "https://kicd.ac.ke/math" },
      { title: "", url: "" },
    ]);
    expect(api.callsTo(`POST /v1/tenants/${T}/ai/query`)[0]?.body).toEqual({
      scope: "school",
      prompt: "Explain fractions",
    });
  });

  it("maps 503 not_configured and 503 unavailable with retry-after to clear EdgeErrors", async () => {
    boot({
      [`POST /v1/tenants/${T}/ai/query`]: {
        status: 503,
        body: { status: "not_configured", scope: "school", reason: "llm_provider_not_configured" },
      },
    });
    await expect(askBloomChat([{ role: "user", content: "Hi" }])).rejects.toMatchObject({
      name: "EdgeError",
      status: 503,
      message: "Bloom AI is not available on this server yet.",
    });

    boot({
      [`POST /v1/tenants/${T}/ai/query`]: {
        status: 503,
        headers: { "retry-after": "15" },
        body: { status: "unavailable", scope: "school", reason: "circuit_open", retry_after_seconds: 15 },
      },
    });
    await expect(askBloomChat([{ role: "user", content: "Hi" }])).rejects.toMatchObject({
      name: "EdgeError",
      status: 503,
      message: "Bloom is not answering right now. Try again in 15 seconds.",
    });
  });

  it("maps caller abort to a cancelled EdgeError", async () => {
    boot({
      [`POST /v1/tenants/${T}/ai/query`]: { hang: true },
    });
    const ac = new AbortController();
    ac.abort();
    await expect(askBloomChat([{ role: "user", content: "Hi" }], { signal: ac.signal })).rejects.toMatchObject({
      name: "EdgeError",
      cancelled: true,
    });
  });

  it("routes askGuide to /ai/query with empty links and actions", async () => {
    const api = boot({
      [`POST /v1/tenants/${T}/ai/query`]: {
        body: { status: "ok", scope: "school", answer: "Go to Classes and click Add class.", provider: "figbloom_ai" },
      },
    });
    const ans = await askGuide([{ role: "user", content: "How do I add a class?" }], {
      pages: [{ to: "admin/classes", label: "Classes", about: "Create classes" }],
      here: "admin/assistant",
      tenantId: T,
    });
    expect(ans).toEqual({ reply: "Go to Classes and click Add class.", links: [], actions: [] });
    const sent = api.callsTo(`POST /v1/tenants/${T}/ai/query`)[0]?.body as { prompt: string };
    expect(sent.prompt).toContain("admin/assistant");
    expect(sent.prompt).toContain("How do I add a class?");
  });
});

describe("Bloom query: the 4,000-character limit and what a person reads when it fails", () => {
  const QUERY = `POST /v1/tenants/${T}/ai/query`;
  const CONV = "77777777-7777-4777-8777-777777777777";
  const ok = { body: { status: "ok", scope: "public", answer: "ok" } };

  it("sends at most 4,000 characters, with the scope, the conversation id and the school", async () => {
    const api = boot({ [QUERY]: ok });
    const reply = await apiQueryBloom({ prompt: "x".repeat(5000), scope: "public", conversationId: CONV });
    expect(reply).toEqual({ text: "ok", sources: [] });
    const sent = api.callsTo(QUERY)[0]!;
    expect((sent.body as { prompt: string }).prompt).toHaveLength(API_BLOOM_PROMPT_MAX);
    expect(sent.body).toMatchObject({ scope: "public", conversation_id: CONV });
    expect(sent.headers["x-tenant-id"]).toBe(T);
  });

  it("asks for the school scope by default and leaves out an absent conversation id", async () => {
    const api = boot({ [QUERY]: ok });
    await apiQueryBloom({ prompt: "  Hello  ", tenantId: T });
    expect(api.callsTo(QUERY)[0]?.body).toEqual({ scope: "school", prompt: "Hello" });
  });

  it("refuses a blank message without calling the API", async () => {
    const api = boot({ [QUERY]: ok });
    await expect(apiQueryBloom({ prompt: "   " })).rejects.toMatchObject({ name: "EdgeError", message: "Type a message for Bloom first." });
    expect(api.callsTo(QUERY)).toHaveLength(0);
  });

  it("packs a long chat into one prompt of at most 4,000 characters and keeps the newest turn", async () => {
    const api = boot({ [QUERY]: ok });
    const turns = Array.from({ length: 21 }, (_, i) => ({ role: i % 2 === 0 ? "user" as const : "assistant" as const, content: `turn ${i} ` + "w".repeat(500) }));
    await askBloomChat(turns);
    const prompt = (api.callsTo(QUERY)[0]?.body as { prompt: string }).prompt;
    expect(prompt.length).toBeLessThanOrEqual(API_BLOOM_PROMPT_MAX);
    expect(prompt.endsWith("turn 20 " + "w".repeat(500))).toBe(true);
    expect(prompt).not.toContain("turn 0 ");
  });

  it("says Bloom is not enabled when the API refuses with 403", async () => {
    boot({ [QUERY]: refused("forbidden", 403, "Bloom AI is not enabled for this school") });
    await expect(askBloomChat([{ role: "user", content: "Hi" }])).rejects.toMatchObject({
      name: "EdgeError", status: 403, message: "Bloom AI is not enabled for this school",
    });
  });

  it("says when Bloom is busy (429) and when the network is down", async () => {
    boot({ [QUERY]: { status: 429, headers: { "retry-after": "7" }, body: { error: { code: "rate_limited", message: "slow down" } } } });
    await expect(askBloomChat([{ role: "user", content: "Hi" }])).rejects.toMatchObject({
      status: 429, message: "Bloom is getting a lot of questions. Try again in 7 seconds.",
    });
    boot({ [QUERY]: { networkError: true } });
    await expect(askBloomChat([{ role: "user", content: "Hi" }])).rejects.toMatchObject({
      name: "EdgeError", message: "Can't reach the server. Check your connection and try again.",
    });
  });

  it("words 503 by whether the API sent Retry-After", () => {
    const e = (status: number, code: ApiError["code"], retry: number | null) => new ApiError({ status, code, message: "m", retryAfterSeconds: retry });
    expect(bloomQueryErrorMessage(e(503, "service_unavailable", null))).toBe("Bloom AI is not available on this server yet.");
    expect(bloomQueryErrorMessage(e(503, "service_unavailable", 1))).toBe("Bloom is not answering right now. Try again in 1 second.");
    expect(bloomQueryErrorMessage(e(429, "rate_limited", null))).toBe("Bloom is getting a lot of questions. Try again in a moment.");
    expect(bloomQueryErrorMessage(e(500, "internal_error", null))).toMatch(/Something went wrong on our side/);
  });

  it("reads an odd /ai/status answer safely", async () => {
    boot({
      [`GET /v1/tenants/${T}/ai/status`]: {
        body: { enabled_for_school: true, provider_configured: true, circuit: "weird", allowed_scopes: ["school", "root", 4], tools: ["x", 3] },
      },
    });
    expect(await apiFetchBloomReadiness(T)).toEqual({
      contract: "bloom-school/1", enabledForSchool: true, providerConfigured: true, circuit: "unconfigured", allowedScopes: ["school"], tools: ["x"],
    });
  });

  it("treats a school that is on but gives this account no scope as off", async () => {
    boot({
      [`GET /v1/tenants/${T}/ai/status`]: {
        body: { contract: "bloom-school/1", enabled_for_school: true, provider_configured: true, circuit: "closed", allowed_scopes: [], tools: [] },
      },
    });
    expect(await fetchAiStatus(T)).toMatchObject({ aiEnabled: false, tutorEnabled: true });
  });
});

describe("School assistant checklist (fetchSetupCounts)", () => {
  it("counts school setup resources across endpoints", async () => {
    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [{ id: TERM1, label: "Term 1, 2026", is_current: true }]),
      [`GET /v1/tenants/${T}/academic-years`]: list("academic_years", [{ id: Y1, label: "2026", is_current: true }]),
      [`GET /v1/tenants/${T}/subjects`]: list("subjects", [
        { id: "s1", active: true },
        { id: "s2", active: false },
      ]),
      [`GET /v1/tenants/${T}/staff`]: list("staff", [
        { id: "st1", classification: "teacher" },
        { id: "st2", classification: "support" },
      ]),
      [`GET /v1/tenants/${T}/teaching-assignments`]: list("assignments", [{ id: "ta1" }, { id: "ta2" }]),
      [`GET /v1/tenants/${T}/learners`]: list("learners", [{ id: L1 }, { id: L2 }]),
      [`GET /v1/tenants/${T}/guardians`]: list("guardians", [{ id: "g1" }]),
      [`GET /v1/tenants/${T}/classes`]: list("classes", [{ id: C1, name: "Form 1 East" }]),
      [`GET /v1/tenants/${T}/finance/fee-items`]: list("fee_items", [{ id: "fi1" }, { id: "fi2" }, { id: "fi3" }]),
      [`GET /v1/tenants/${T}/finance/invoices`]: list("invoices", [{ id: "inv1" }]),
      [`GET /v1/tenants/${T}/assessments`]: list("assessments", [
        { id: "a1", kind: "exam", title: "Opener" },
        { id: "a2", kind: "exam", title: "opener " },
        { id: "a3", kind: "exam", title: "Midterm" },
        { id: "a4", kind: "assignment", title: "HW 1" },
      ]),
    });

    const counts = await fetchSetupCounts(T);
    expect(counts).toEqual({
      hasPaymentDetails: false,
      hasCrest: false,
      leaveOut: ["details", "payments"],
      currentTerm: "Term 1, 2026",
      classes: 1,
      subjects: 1,
      teachers: 1,
      assignments: 2,
      learners: 2,
      guardians: 1,
      feeItems: 3,
      invoices: 1,
      exams: 2,
    });
  });

  it("handles 403 on optional resources gracefully", async () => {
    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/academic-years`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/subjects`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/staff`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/teaching-assignments`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/learners`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/guardians`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/classes`]: refused("forbidden", 403),
    });
    const counts = await fetchSetupCounts(T);
    expect(counts.currentTerm).toBeNull();
    expect(counts.classes).toBe(0);
    expect(counts.exams).toBe(0);
  });
});

describe("Study helper settings, opt-ins and roster", () => {
  it("reads and writes AI helper settings", async () => {
    const api = boot({
      [`GET /v1/tenants/${T}/finance/ai-helper/settings`]: {
        body: {
          settings: {
            tenantId: T,
            access_mode: "opt_in",
            price_minor: 50000,
            currency: "KES",
            cancel_days: 14,
            billing_available: false,
            billing_enabled: false,
            updated_by: null,
            updated_at: null,
          },
        },
      },
      [`PUT /v1/tenants/${T}/finance/ai-helper/settings`]: {
        body: {
          settings: {
            tenantId: T,
            access_mode: "all",
            price_minor: 0,
            currency: "KES",
            cancel_days: 7,
            billing_available: false,
            billing_enabled: false,
            updated_by: "u-1",
            updated_at: "2026-11-24T12:00:00Z",
          },
        },
      },
    });

    const settings = await fetchAiHelperSettings(T);
    expect(settings).toEqual({ access: "opt_in", priceCents: 50000, billingEnabled: false, cancelDays: 14 });

    await saveAiHelperSettings(T, { access: "all", priceCents: 0, billingEnabled: false, cancelDays: 7 });
    expect(api.callsTo(`PUT /v1/tenants/${T}/finance/ai-helper/settings`)[0]?.body).toEqual({
      access_mode: "all",
      price_minor: 0,
      cancel_days: 7,
    });
  });

  it("fetches and enriches the study helper opt-in roster for the current term", async () => {
    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [{ id: TERM1, label: "Term 1", is_current: true }]),
      [`GET /v1/tenants/${T}/finance/ai-helper/optins`]: list("optins", [
        { learner_id: L2, term_id: TERM1, opted_in: false, changed_by: "p2", changed_at: "2026-11-20T09:00:00Z" },
        { learner_id: L1, term_id: TERM1, opted_in: true, changed_by: "p1", changed_at: "2026-11-21T10:00:00Z" },
      ]),
      [`GET /v1/tenants/${T}/learners`]: list("learners", [
        { id: L1, full_name: "Amina Otieno", admission_no: "ADM-01" },
        { id: L2, full_name: "Brian Kamau", admission_no: "ADM-02" },
      ]),
      [`GET /v1/tenants/${T}/class-memberships`]: list("memberships", [{ learner_id: L1, class_id: C1 }]),
      [`GET /v1/tenants/${T}/academic-years`]: list("academic_years", [{ id: Y1, is_current: true }]),
      [`GET /v1/tenants/${T}/classes`]: list("classes", [{ id: C1, name: "Form 1 East" }]),
    });

    const rows = await fetchAiHelperRoster(T);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      studentId: L1,
      fullName: "Amina Otieno",
      admissionNo: "ADM-01",
      className: "Form 1 East",
      status: "on",
      optInActive: true,
      turnedOnAt: "2026-11-21T10:00:00Z",
      changedAt: "2026-11-21T10:00:00Z",
    });
    expect(rows[1]).toMatchObject({
      studentId: L2,
      fullName: "Brian Kamau",
      className: null,
      status: "off",
      optInActive: false,
      turnedOnAt: null,
    });
  });

  it("shows a learner the caller may not read as \"Learner\", and an empty roster when nobody chose", async () => {
    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [{ id: TERM1, label: "Term 1", is_current: true }]),
      [`GET /v1/tenants/${T}/finance/ai-helper/optins`]: list("optins", [
        { learner_id: L1, term_id: TERM1, opted_in: true, changed_by: "p1", changed_at: "2026-11-21T10:00:00Z" },
      ]),
      [`GET /v1/tenants/${T}/learners`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/class-memberships`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/academic-years`]: refused("forbidden", 403),
      [`GET /v1/tenants/${T}/classes`]: refused("forbidden", 403),
    });
    const rows = await fetchAiHelperRoster(T);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ studentId: L1, fullName: "Learner", admissionNo: "", className: null, status: "on" });

    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [{ id: TERM1, label: "Term 1", is_current: true }]),
      [`GET /v1/tenants/${T}/finance/ai-helper/optins`]: list("optins", []),
    });
    expect(await fetchAiHelperRoster(T)).toEqual([]);
  });

  it("returns empty roster when no current term is open", async () => {
    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", []),
    });
    expect(await fetchAiHelperRoster(T)).toEqual([]);
  });

  it("records a parent opt-in choice on the current term", async () => {
    const api = boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [{ id: TERM1, label: "Term 1", is_current: true }]),
      [`PUT /v1/tenants/${T}/finance/ai-helper/optins`]: {
        body: { optin: { learner_id: L1, term_id: TERM1, opted_in: true, changed_by: "u-1", changed_at: "2026-11-24T12:00:00Z" } },
      },
    });
    expect(await setAiHelperOptIn(L1, true)).toBe("on");
    expect(api.callsTo(`PUT /v1/tenants/${T}/finance/ai-helper/optins`)[0]?.body).toEqual({
      learner_id: L1,
      term_id: TERM1,
      opted_in: true,
    });
  });
});

describe("Study helper opt-in refusals", () => {
  it("needs a current term, and passes on the API's 403 for a person who is not the child's parent", async () => {
    const api = boot({ [`GET /v1/tenants/${T}/academic-terms`]: list("terms", []) });
    await expect(setAiHelperOptIn(L1, true)).rejects.toThrow("There is no current term open.");
    expect(api.callsTo(`PUT /v1/tenants/${T}/finance/ai-helper/optins`)).toHaveLength(0);

    boot({
      [`GET /v1/tenants/${T}/academic-terms`]: list("terms", [{ id: TERM1, label: "Term 1", is_current: true }]),
      [`PUT /v1/tenants/${T}/finance/ai-helper/optins`]: refused("forbidden", 403, "Only a parent of this learner may do that"),
    });
    await expect(setAiHelperOptIn(L1, false)).rejects.toMatchObject({ status: 403 });
  });
});

describe("NotOnApiError guards for unsupported AI/edge functions", () => {
  it("throws NotOnApiError for every Supabase-only AI, chat-history, guide-plan and edge function", async () => {
    boot();
    await expect(saveAiSettings(T, true, true, false)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(draftReportComments("teacher", [])).rejects.toBeInstanceOf(NotOnApiError);
    await expect(draftQuestions({
      subject: "Math", topic: "Fractions", classLabel: "Grade 7", curriculum: "cbc", kind: "exam", choice: 2, short: 1, long: 0, difficulty: "mixed",
    })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(importPaperWithAi({
      paths: ["a.pdf"], subject: "Math", classLabel: "Grade 7", curriculum: "cbc", kind: "exam",
    })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(draftHomework({
      subject: "Math", topic: "Fractions", classLabel: "Grade 7", curriculum: "cbc", youngLearner: false,
    })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(draftMessage({ notes: "Half term", audience: "parents", tone: "warm", language: "en" })).rejects.toBeInstanceOf(NotOnApiError);
    await expect(translateMessage("Sub", "Body", "sw")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(askTutor([{ role: "user", content: "Help" }])).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchAiChats()).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchAiChatMessages("c1")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(createAiChat(T, "Chat")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(setAiChatWebSearch("c1", false)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(renameAiChat("c1", "New")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(deleteAiChat("c1")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(saveAiChatTurns("c1", [])).rejects.toBeInstanceOf(NotOnApiError);
    await expect(deleteAiChatMessage("m1")).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchAiHelperStatus(L1)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(fetchSetupExisting(T)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(applySetupPlan(T, [], null)).rejects.toBeInstanceOf(NotOnApiError);
    await expect(invokeEdge("ai-assist", {}, { timeoutMs: 1000 })).rejects.toBeInstanceOf(NotOnApiError);
  });
});
