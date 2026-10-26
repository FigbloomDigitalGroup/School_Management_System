import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { DAILY_LIMIT, handle, type AiSetup } from "./index.ts";
import type { AiReply, AiRequest } from "./providers.ts";
import { BadInput, CHAT_MAX_TOTAL_CHARS, chatMessages, MAX_LEARNERS, prepare, tutorMessages } from "./tasks.ts";

const TENANT_ID = "tenant-1";

function makeClients(role = "teacher", tenant: Record<string, unknown> = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: "me", role, tenant_id: TENANT_ID }]);
  admin.seed("tenants", [{ id: TENANT_ID, name: "Kijani Ridge", country: "KE", ai_enabled: true, ai_tutor_enabled: true, ai_monthly_tokens: 1_000_000, ...tenant }]);
  admin.seed("ai_usage", []);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "me" };
  return { admin, asUser };
}

/** A fake model that records what it was asked and answers with `text`. */
function fakeAi(text: string, outcome: AiReply["outcome"] = "ok") {
  const calls: AiRequest[] = [];
  const ai: AiSetup = {
    model: "test-model",
    call: (r) => {
      calls.push(r);
      return Promise.resolve({ model: "test-model", outcome, text, inputTokens: 1200, outputTokens: 300 });
    },
  };
  return { ai, calls };
}

const req = (task: string, payload: unknown) =>
  new Request("https://example.com/ai-assist", { method: "POST", headers: { Authorization: "Bearer x" }, body: JSON.stringify({ task, payload }) });

const MESSAGE = { notes: "Half term Friday 12 Sept, close 12:30. Boarders collect passes Thursday." };

describe("ai-assist", () => {
  it("drafts a message for a teacher and logs the tokens, not the text", async () => {
    const { admin, asUser } = makeClients();
    const { ai, calls } = fakeAi(JSON.stringify({ subject: "Half term: closing Fri 12 Sept, 12:30", body: "..." }));
    const res = await handle(req("message", MESSAGE), { admin, asUser, ai });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).result.subject, "Half term: closing Fri 12 Sept, 12:30");

    const p = calls[0]!;
    assertEquals(p.effort, "low");
    assert(p.schema, "staff tasks answer in JSON fixed by a schema");
    assertEquals(p.messages.length, 1);

    const usage = admin.rowsIn("ai_usage");
    assertEquals(usage.length, 1);
    assertEquals([usage[0]!.task, usage[0]!.model, usage[0]!.input_tokens, usage[0]!.output_tokens, usage[0]!.outcome], ["message", "test-model", 1200, 300, "ok"]);
    assert(!JSON.stringify(usage[0]).includes("Half term"), "the prompt is never stored");
  });

  it("says Bloom isn't set up, and spends nothing, when the key is missing", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(req("message", MESSAGE), { admin, asUser, ai: { error: "OPENAI_API_KEY is missing" } });
    assertEquals(res.status, 503);
    assertEquals(admin.rowsIn("ai_usage").length, 0);
  });

  it("refuses a task the role can't use", async () => {
    const { admin, asUser } = makeClients("parent");
    const res = await handle(req("message", MESSAGE), { admin, asUser, ai: fakeAi("{}").ai });
    assertEquals(res.status, 403);
    const { admin: a2, asUser: u2 } = makeClients("teacher");
    assertEquals((await handle(req("tutor", { messages: [{ role: "user", content: "hi" }] }), { admin: a2, asUser: u2, ai: fakeAi("hi").ai })).status, 403);
  });

  it("does nothing when the school has AI turned off", async () => {
    const { admin, asUser } = makeClients("teacher", { ai_enabled: false });
    const { ai, calls } = fakeAi("{}");
    const res = await handle(req("message", MESSAGE), { admin, asUser, ai });
    assertEquals(res.status, 403);
    assertEquals(calls.length, 0);
  });

  it("stops at the school's monthly allowance", async () => {
    const { admin, asUser } = makeClients("teacher", { ai_monthly_tokens: 1000 });
    admin.seed("ai_usage", [{ tenant_id: TENANT_ID, profile_id: "someone", input_tokens: 900, output_tokens: 200, created_at: new Date().toISOString() }]);
    const { ai, calls } = fakeAi("{}");
    const res = await handle(req("message", MESSAGE), { admin, asUser, ai });
    assertEquals(res.status, 429);
    assertEquals(calls.length, 0);
  });

  it("stops at a person's daily cap", async () => {
    const { admin, asUser } = makeClients("student");
    const now = new Date().toISOString();
    admin.seed("ai_usage", Array.from({ length: DAILY_LIMIT.student }, () => ({ tenant_id: TENANT_ID, profile_id: "me", input_tokens: 1, output_tokens: 1, created_at: now })));
    const res = await handle(req("tutor", { messages: [{ role: "user", content: "What is a fraction?" }] }), { admin, asUser, ai: fakeAi("...").ai });
    assertEquals(res.status, 429);
  });

  it("keeps the study helper off unless the school turned it on", async () => {
    const { admin, asUser } = makeClients("student", { ai_tutor_enabled: false });
    const res = await handle(req("tutor", { messages: [{ role: "user", content: "hi" }] }), { admin, asUser, ai: fakeAi("hi").ai });
    assertEquals(res.status, 403);
  });

  it("keeps the study helper off during an exam, without calling the model", async () => {
    const { admin, asUser } = makeClients("student");
    admin.tutorBlocked = "An exam for your class is open.";
    const { ai, calls } = fakeAi("hi");
    const res = await handle(req("tutor", { messages: [{ role: "user", content: "Answer question 3" }] }), { admin, asUser, ai });
    assertEquals(res.status, 423);
    assertEquals((await res.json()).blocked, true);
    assertEquals(calls.length, 0);
  });

  it("answers a learner in plain text, with the safeguarding prompt and their class level", async () => {
    const { admin, asUser } = makeClients("student");
    admin.seed("students", [{ id: "s1", profile_id: "me", active: true, classes: { level: "primary", form_level: 5 } }]);
    const { ai, calls } = fakeAi("A fraction is part of a whole. If you cut a chapati into 4...");
    const res = await handle(req("tutor", { messages: [{ role: "user", content: "What is a fraction?" }] }), { admin, asUser, ai });
    assertEquals(res.status, 200);
    assertStringIncludes((await res.json()).result.text, "chapati");
    const system = calls[0]!.system;
    assertStringIncludes(system, "Grade 5");
    assertStringIncludes(system, "Childline Kenya on 116");
    assertStringIncludes(system, "You are Bloom");
    assertEquals(calls[0]!.schema, null);
  });

  it("says so when the model declines, and still counts it", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(req("message", MESSAGE), { admin, asUser, ai: fakeAi("", "refused").ai });
    assertEquals(res.status, 422);
    assertEquals(admin.rowsIn("ai_usage")[0]!.outcome, "refused");
  });

  it("turns a bad request away before spending anything", async () => {
    const { admin, asUser } = makeClients();
    const { ai, calls } = fakeAi("{}");
    const res = await handle(req("questions", { subject: "Maths", topic: "Fractions", classLabel: "Grade 6", choice: 500 }), { admin, asUser, ai });
    assertEquals(res.status, 400);
    assertEquals(calls.length, 0);
    assertEquals(admin.rowsIn("ai_usage").length, 0);
  });
});

describe("tasks", () => {
  it("sends report card drafting only first names and results", () => {
    const t = prepare("report_comment", {
      who: "both",
      learners: [{ ref: "card-1", firstName: "Amani", curriculum: "844", mean: 64, grade: "B", subjects: [{ name: "Maths", average: 72, grade: "B+" }] }],
    });
    assertStringIncludes(t.user, "Amani");
    assertStringIncludes(t.system, "Do not mention position");
    assertThrows(() => prepare("report_comment", { who: "both", learners: Array.from({ length: MAX_LEARNERS + 1 }, (_, i) => ({ ref: `${i}`, firstName: "A" })) }), BadInput);
  });

  it("asks for questions in the builder's shape, by curriculum", () => {
    const t = prepare("questions", { subject: "Science", topic: "Plants", classLabel: "Grade 6", curriculum: "cbc", choice: 5, short: 2, long: 1 });
    assertStringIncludes(t.system, "Competency Based Curriculum");
    assertMatch(t.user, /5 multiple choice, 2 short answer and 1 long answer/);
    // deno-lint-ignore no-explicit-any
    assertEquals((t.schema as any).properties.questions.items.required.sort(), ["correct_option", "kind", "model_answer", "options", "points", "prompt"]);
  });

  it("keeps only the last turns of a long chat, starting with the learner", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const kept = tutorMessages({ messages: [...long, { role: "user", content: "last" }] });
    assert(kept.length <= 16);
    assertEquals(kept[0]!.role, "user");
    assertEquals(kept[kept.length - 1]!.content, "last");
    assertThrows(() => tutorMessages({ messages: [{ role: "assistant", content: "hello" }] }), BadInput);
  });
});

describe("ai-assist chat", () => {
  const ask = (messages: unknown, extra: Record<string, unknown> = {}) =>
    new Request("https://example.com/ai-assist", { method: "POST", headers: { Authorization: "Bearer x" }, body: JSON.stringify({ task: "chat", payload: { messages }, ...extra }) });

  it("answers a teacher in plain text with the whole conversation, and logs only the tokens", async () => {
    const { admin, asUser } = makeClients("teacher");
    const { ai, calls } = fakeAi("**Photosynthesis** is how plants make food.");
    const turns = [
      { role: "user", content: "Plan a Grade 7 lesson on plants" },
      { role: "assistant", content: "Here is a plan..." },
      { role: "user", content: "Now explain photosynthesis simply" },
    ];
    const res = await handle(ask(turns), { admin, asUser, ai });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).result.text, "**Photosynthesis** is how plants make food.");
    assertEquals(calls[0]!.schema, null);
    assertEquals(calls[0]!.messages.length, 3);
    assertStringIncludes(calls[0]!.system, "Kijani Ridge");
    const usage = admin.rowsIn("ai_usage");
    assertEquals([usage[0]!.task, usage[0]!.outcome], ["chat", "ok"]);
    assert(!JSON.stringify(usage[0]).includes("photosynthesis"), "the chat is never stored here");
  });

  it("is refused to learners and parents", async () => {
    for (const role of ["student", "parent"]) {
      const { admin, asUser } = makeClients(role);
      const res = await handle(ask([{ role: "user", content: "hi" }]), { admin, asUser, ai: fakeAi("hi").ai });
      assertEquals(res.status, 403);
    }
  });

  it("is off when the school has turned Bloom off, and when the allowance is used", async () => {
    const off = makeClients("school_admin", { ai_enabled: false });
    assertEquals((await handle(ask([{ role: "user", content: "hi" }]), { ...off, ai: fakeAi("hi").ai })).status, 403);
    const spent = makeClients("school_admin", { ai_monthly_tokens: 10 });
    spent.admin.seed("ai_usage", [{ tenant_id: TENANT_ID, profile_id: "someone", input_tokens: 10, output_tokens: 0 }]);
    assertEquals((await handle(ask([{ role: "user", content: "hi" }]), { ...spent, ai: fakeAi("hi").ai })).status, 429);
  });

  it("lets an org admin use it inside a member school, against that school's allowance", async () => {
    const { admin, asUser } = makeClients("org_admin");
    admin.seed("profiles", [{ id: "me", role: "org_admin", tenant_id: null }]);
    admin.seed("tenants", [{ id: TENANT_ID, organization_id: "org-1", name: "Kijani Ridge", ai_enabled: true, ai_monthly_tokens: 1_000_000 }]);
    admin.seed("organization_admins", [{ id: "oa-1", profile_id: "me", organization_id: "org-1" }]);
    const res = await handle(ask([{ role: "user", content: "hi" }], { tenantId: TENANT_ID }), { admin, asUser, ai: fakeAi("hello").ai });
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("ai_usage")[0]!.tenant_id, TENANT_ID);
  });

  it("refuses an org admin naming a school outside their organization", async () => {
    const { admin, asUser } = makeClients("org_admin");
    admin.seed("profiles", [{ id: "me", role: "org_admin", tenant_id: null }]);
    admin.seed("tenants", [{ id: TENANT_ID, organization_id: "org-2", name: "Kijani Ridge", ai_enabled: true, ai_monthly_tokens: 1_000_000 }]);
    admin.seed("organization_admins", [{ id: "oa-1", profile_id: "me", organization_id: "org-1" }]);
    const res = await handle(ask([{ role: "user", content: "hi" }], { tenantId: TENANT_ID }), { admin, asUser, ai: fakeAi("hello").ai });
    assertEquals(res.status, 403);
  });

  it("keeps the newest turns within the size cap and always ends on the question", () => {
    const big = "x".repeat(10_000);
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: big }));
    const kept = chatMessages({ messages: [...turns, { role: "user", content: "last" }] });
    assert(kept.reduce((n, m) => n + m.content.length, 0) <= CHAT_MAX_TOTAL_CHARS);
    assertEquals(kept[0]!.role, "user");
    assertEquals(kept[kept.length - 1]!.content, "last");
    assertThrows(() => chatMessages({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }), BadInput);
    // a long earlier answer is cut, not refused; a long question is refused
    const withLongAnswer = chatMessages({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "y".repeat(50_000) }, { role: "user", content: "more" }] });
    assertEquals(withLongAnswer[1]!.content.length, 12_000);
    assertThrows(() => chatMessages({ messages: [{ role: "user", content: "z".repeat(12_001) }] }), BadInput);
  });
});
