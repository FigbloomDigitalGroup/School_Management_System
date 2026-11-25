import type { AiStatus } from "../ai";
import { parseChatSources, type AiChatReply, type AiChatTurn } from "../aiChat";
import { optInActive, type AiHelperRosterRow, type AiHelperSettings, type AiHelperStatus } from "../aiHelper";
import { NotOnApiError } from "../capabilities";
import { EdgeError } from "../edge";
import type { GuideAnswer, GuidePageInfo, GuideTurn, SetupCounts } from "../guide";
import { apiClient } from "./client";
import { isApiError, userMessage, type ApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";
import { currentAcademicYear, listAcademicTerms, listApiSubjects, listClasses } from "./setupApi";

/**
 * AI and Bloom on apps/api (contract bloom-school/1): the API side of ai.ts, aiChat.ts, aiHelper.ts and guide.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET /v1/tenants/{tenantId}/ai/status` reports `enabled_for_school`, `provider_configured`, `circuit`, `allowed_scopes`
 *    and `tools` (empty). It has no monthly token allowance or search counters.
 *  - `POST /v1/tenants/{tenantId}/ai/query` is chat-only (`bloom-school/1`, 4,000-character prompts, no tools, no web search,
 *    no file attachments, no saved chat history). Multi-turn history is packed into the 4,000-character prompt.
 *  - On 503 (`not_configured` / `unavailable`), the API returns `{ status, reason }` rather than the standard error envelope,
 *    so 503 is mapped to a plain message for the user.
 *  - Study helper settings and term opt-in rosters come from `/finance/ai-helper/settings` and `/finance/ai-helper/optins`.
 *    Per-learner monthly question/token usage is not tracked by the API yet.
 */

export const API_BLOOM_PROMPT_MAX = 4_000;

export type BloomScope = "public" | "school" | "internal_figbloom";

export interface BloomReadiness {
  contract: string;
  enabledForSchool: boolean;
  providerConfigured: boolean;
  circuit: "closed" | "open" | "unconfigured";
  allowedScopes: BloomScope[];
  tools: string[];
}

type ApiLearner = components["schemas"]["Learner"];
type ApiMembership = components["schemas"]["ClassMembership"];
type ApiClass = components["schemas"]["SchoolClass"];

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

async function tolerant<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------- Bloom status & query

function isBloomScope(v: unknown): v is BloomScope {
  return v === "public" || v === "school" || v === "internal_figbloom";
}

export async function apiFetchBloomReadiness(tenantId: string): Promise<BloomReadiness> {
  const raw = await apiClient().get("/v1/tenants/{tenantId}/ai/status", { path: { tenantId }, tenantId });
  const circuit = raw.circuit === "closed" || raw.circuit === "open" || raw.circuit === "unconfigured" ? raw.circuit : "unconfigured";
  const allowedScopes = Array.isArray(raw.allowed_scopes) ? raw.allowed_scopes.filter(isBloomScope) : [];
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t): t is string => typeof t === "string") : [];
  return {
    contract: typeof raw.contract === "string" ? raw.contract : "bloom-school/1",
    enabledForSchool: raw.enabled_for_school === true,
    providerConfigured: raw.provider_configured === true,
    circuit,
    allowedScopes,
    tools,
  };
}

export async function apiFetchAiStatus(tenantId: string): Promise<AiStatus> {
  const r = await apiFetchBloomReadiness(tenantId);
  return {
    aiEnabled: r.enabledForSchool && r.allowedScopes.length > 0,
    tutorEnabled: r.enabledForSchool,
    webSearchEnabled: false,
    monthlyTokens: 0,
    usedTokens: 0,
    usedSearches: 0,
  };
}

/**
 * Packs a chat history into one prompt of at most `maxChars` characters (4,000 for bloom-school/1).
 * A single turn is sent as-is; a multi-turn chat keeps the newest turns that fit, always keeping the latest question.
 */
export function formatBloomPrompt(turns: readonly { role: "user" | "assistant"; content: string }[], maxChars = API_BLOOM_PROMPT_MAX): string {
  const cleaned = turns
    .map((t) => ({ role: t.role, content: t.content.trim() }))
    .filter((t) => t.content.length > 0);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0]!.content.slice(0, maxChars);

  const last = cleaned[cleaned.length - 1]!;
  const latestLine = `User: ${last.content}`;
  if (latestLine.length >= maxChars) return last.content.slice(0, maxChars);

  const kept: string[] = [latestLine];
  let total = latestLine.length;
  for (let i = cleaned.length - 2; i >= 0; i--) {
    const t = cleaned[i]!;
    const line = `${t.role === "user" ? "User" : "Bloom"}: ${t.content}`;
    const sep = 2; // "\n\n"
    if (total + sep + line.length > maxChars) break;
    kept.unshift(line);
    total += sep + line.length;
  }
  return kept.join("\n\n");
}

/** The sentence a person reads when Bloom does not answer. The 503 bodies of /ai/query are not the standard error envelope, so they are told apart by status and the Retry-After header. */
export function bloomQueryErrorMessage(err: ApiError): string {
  const wait = err.retryAfterSeconds;
  const seconds = wait ? ` Try again in ${wait} second${wait === 1 ? "" : "s"}.` : " Try again in a moment.";
  if (err.status === 503) {
    return wait ? `Bloom is not answering right now.${seconds}` : "Bloom AI is not available on this server yet.";
  }
  if (err.code === "rate_limited") return `Bloom is getting a lot of questions.${seconds}`;
  return userMessage(err);
}

function mapQueryError(err: unknown): EdgeError {
  if (isApiError(err)) {
    if (err.code === "aborted") return new EdgeError("Stopped.", undefined, true);
    return new EdgeError(bloomQueryErrorMessage(err), err.status || undefined);
  }
  return new EdgeError(err instanceof Error ? err.message : "Bloom didn't answer. Try again.");
}

export async function apiQueryBloom(input: {
  tenantId?: string;
  scope?: BloomScope;
  prompt: string;
  conversationId?: string;
  signal?: AbortSignal;
}): Promise<AiChatReply> {
  const tenantId = tenantIdOrThrow(input.tenantId);
  const prompt = input.prompt.trim().slice(0, API_BLOOM_PROMPT_MAX);
  if (!prompt) throw new EdgeError("Type a message for Bloom first.");
  try {
    const res = await apiClient().post("/v1/tenants/{tenantId}/ai/query", {
      path: { tenantId },
      tenantId,
      signal: input.signal,
      body: {
        scope: input.scope ?? "school",
        prompt,
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      },
    });
    const answer = typeof res.answer === "string" ? res.answer : "";
    const rawCitations = Array.isArray(res.citations) ? res.citations : [];
    const sources = parseChatSources(
      rawCitations.map((c) => {
        const rec = (c && typeof c === "object" ? c : {}) as { title?: unknown; source?: unknown };
        return { title: rec.title, url: rec.source };
      }),
    );
    return { text: answer, sources };
  } catch (err) {
    throw mapQueryError(err);
  }
}

export async function apiAskBloomChat(
  turns: AiChatTurn[],
  opts: { tenantId?: string; signal?: AbortSignal; scope?: BloomScope; conversationId?: string } = {},
): Promise<AiChatReply> {
  return apiQueryBloom({
    tenantId: opts.tenantId,
    scope: opts.scope ?? "school",
    prompt: formatBloomPrompt(turns),
    conversationId: opts.conversationId,
    signal: opts.signal,
  });
}

/**
 * The study helper's next reply for a learner: `POST /ai/query` with the PUBLIC scope, the only one the server gives a learner (`school`
 * and `internal_figbloom` are a 403). The whole chat is packed into the one prompt, as for every Bloom chat on the API. The server does not
 * look at the learner's opt-in or at whether an exam is open (finding `student-6`), so neither is checked here.
 */
export async function apiAskTutor(turns: readonly { role: "user" | "assistant"; content: string }[]): Promise<string> {
  return (await apiQueryBloom({ scope: "public", prompt: formatBloomPrompt(turns) })).text;
}

export async function apiAskGuide(
  turns: GuideTurn[],
  opts: { pages: GuidePageInfo[]; here: string; tenantId?: string; signal?: AbortSignal },
): Promise<GuideAnswer> {
  const prefix = opts.here ? `Context: School management console (current page: ${opts.here}).\n\n` : "";
  const budget = Math.max(200, API_BLOOM_PROMPT_MAX - prefix.length);
  const body = formatBloomPrompt(turns, budget);
  const reply = await apiQueryBloom({
    tenantId: opts.tenantId,
    scope: "school",
    prompt: prefix ? `${prefix}${body}` : body,
    signal: opts.signal,
  });
  return { reply: reply.text, links: [], actions: [] };
}

// ---------------------------------------------------------------- School assistant checklist

export async function apiFetchSetupCounts(tenantId: string): Promise<SetupCounts> {
  const [terms, year, subjects, staff, assignments, learners, guardians] = await Promise.all([
    tolerant(() => listAcademicTerms(tenantId), []),
    tolerant(() => currentAcademicYear(tenantId), null),
    tolerant(() => listApiSubjects(tenantId), []),
    tolerant(
      () => listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/staff", {
          path: { tenantId },
          query: { active: true, limit: API_PAGE_LIMIT, cursor },
          tenantId,
        });
        return { items: r.staff, page: r.page };
      }),
      [],
    ),
    tolerant(
      () => listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", {
          path: { tenantId },
          query: { limit: API_PAGE_LIMIT, cursor },
          tenantId,
        });
        return { items: r.assignments, page: r.page };
      }),
      [],
    ),
    tolerant(
      () => listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
          path: { tenantId },
          query: { active: true, limit: API_PAGE_LIMIT, cursor },
          tenantId,
        });
        return { items: r.learners, page: r.page };
      }),
      [],
    ),
    tolerant(
      () => listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/guardians", {
          path: { tenantId },
          query: { limit: API_PAGE_LIMIT, cursor },
          tenantId,
        });
        return { items: r.guardians, page: r.page };
      }),
      [],
    ),
  ]);

  const current = terms.find((t) => t.is_current) ?? null;
  const [classes, feeItems, invoices, assessments] = await Promise.all([
    year ? tolerant(() => listClasses(tenantId, year.id), []) : tolerant(() => listClasses(tenantId), []),
    current
      ? tolerant(
        () => listAllPages(async (cursor) => {
          const r = await apiClient().get("/v1/tenants/{tenantId}/finance/fee-items", {
            path: { tenantId },
            query: { termId: current.id, active: true, limit: API_PAGE_LIMIT, cursor },
            tenantId,
          });
          return { items: r.fee_items, page: r.page };
        }),
        [],
      )
      : Promise.resolve([]),
    current
      ? tolerant(
        () => listAllPages(async (cursor) => {
          const r = await apiClient().get("/v1/tenants/{tenantId}/finance/invoices", {
            path: { tenantId },
            query: { termId: current.id, limit: API_PAGE_LIMIT, cursor },
            tenantId,
          });
          return { items: r.invoices, page: r.page };
        }),
        [],
      )
      : Promise.resolve([]),
    current
      ? tolerant(
        () => listAllPages(async (cursor) => {
          const r = await apiClient().get("/v1/tenants/{tenantId}/assessments", {
            path: { tenantId },
            query: { termId: current.id, limit: API_PAGE_LIMIT, cursor },
            tenantId,
          });
          return { items: r.assessments, page: r.page };
        }),
        [],
      )
      : Promise.resolve([]),
  ]);

  const examTitles = new Set(
    assessments
      .filter((a) => a.kind === "exam")
      .map((a) => a.title.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    // The API stores no payment details or school crest yet, so the checklist cannot say whether they are set: it leaves them off.
    hasPaymentDetails: false,
    hasCrest: false,
    leaveOut: ["details", "payments"],
    currentTerm: current?.label ?? null,
    classes: classes.length,
    subjects: subjects.length,
    teachers: staff.filter((s) => s.classification === "teacher").length,
    assignments: assignments.length,
    learners: learners.length,
    guardians: guardians.length,
    feeItems: feeItems.length,
    invoices: invoices.length,
    exams: examTitles.size,
  };
}

// ---------------------------------------------------------------- Study helper settings & roster

export async function apiFetchAiHelperSettings(tenantId: string): Promise<AiHelperSettings> {
  const { settings } = await apiClient().get("/v1/tenants/{tenantId}/finance/ai-helper/settings", {
    path: { tenantId },
    tenantId,
  });
  return {
    access: settings.access_mode === "opt_in" ? "opt_in" : "all",
    priceCents: settings.price_minor,
    billingEnabled: settings.billing_enabled,
    cancelDays: settings.cancel_days,
  };
}

export async function apiSaveAiHelperSettings(tenantId: string, s: AiHelperSettings): Promise<void> {
  await apiClient().put("/v1/tenants/{tenantId}/finance/ai-helper/settings", {
    path: { tenantId },
    tenantId,
    body: {
      access_mode: s.access,
      price_minor: s.priceCents,
      cancel_days: s.cancelDays,
    },
  });
}

export async function apiFetchAiHelperRoster(tenantId: string): Promise<AiHelperRosterRow[]> {
  const terms = await tolerant(() => listAcademicTerms(tenantId), []);
  const current = terms.find((t) => t.is_current) ?? null;
  if (!current) return [];

  const optins = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/finance/ai-helper/optins", {
      path: { tenantId },
      query: { termId: current.id, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.optins, page: r.page };
  });
  if (optins.length === 0) return [];

  const [learners, memberships, year] = await Promise.all([
    tolerant<ApiLearner[]>(
      () => listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
          path: { tenantId },
          query: { active: true, limit: API_PAGE_LIMIT, cursor },
          tenantId,
        });
        return { items: r.learners, page: r.page };
      }),
      [],
    ),
    tolerant<ApiMembership[]>(
      () => listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
          path: { tenantId },
          query: { active: true, limit: API_PAGE_LIMIT, cursor },
          tenantId,
        });
        return { items: r.memberships, page: r.page };
      }),
      [],
    ),
    tolerant(() => currentAcademicYear(tenantId), null),
  ]);
  const classes = await tolerant<ApiClass[]>(() => listClasses(tenantId, year?.id), []);

  const learnerById = new Map(learners.map((l) => [l.id, l]));
  const classById = new Map(classes.map((c) => [c.id, c.name]));
  const classNameByLearner = new Map<string, string>();
  for (const m of memberships) {
    const name = classById.get(m.class_id);
    if (name && !classNameByLearner.has(m.learner_id)) classNameByLearner.set(m.learner_id, name);
  }

  return optins
    .map((o): AiHelperRosterRow => {
      const learner = learnerById.get(o.learner_id);
      return {
        studentId: o.learner_id,
        fullName: learner?.full_name ?? "Learner",
        admissionNo: learner?.admission_no ?? "",
        className: classNameByLearner.get(o.learner_id) ?? null,
        status: o.opted_in ? "on" : "off",
        optInActive: o.opted_in,
        turnedOnBy: null,
        turnedOnAt: o.opted_in ? o.changed_at : null,
        changedBy: null,
        changedAt: o.changed_at,
        questionsThisMonth: 0,
        tokensThisMonth: 0,
        lastUsedAt: null,
        chargeCents: null,
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function apiFetchAiHelperStatus(studentId: string | null): Promise<AiHelperStatus | null> {
  if (!studentId) throw new NotOnApiError("Learner study helper status");
  const tenantId = tenantIdOrThrow();
  try {
    const { ai_helper: h } = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/ai-helper", {
      path: { tenantId, learnerId: studentId },
      tenantId,
    });
    const status = h.optin ? (h.optin.opted_in ? "on" : "off") : null;
    const termId = h.current_term?.id ?? null;
    return {
      studentId,
      fullName: "",
      schoolOn: h.school_on,
      access: h.access_mode === "opt_in" ? "opt_in" : "all",
      billingEnabled: h.billing_enabled,
      priceCents: h.price_minor,
      cancelDays: h.cancel_days,
      status,
      optInActive: optInActive(status ? { status, termId } : null, h.billing_enabled, termId),
      termName: h.current_term?.label ?? null,
      turnedOnBy: null,
      turnedOnAt: h.optin?.opted_in ? h.optin.changed_at : null,
      changedBy: null,
      changedAt: h.optin?.changed_at ?? null,
      questionsThisMonth: 0,
      lastUsedAt: null,
      chargeCents: null,
    };
  } catch (err) {
    if (isApiError(err) && err.code === "not_found") return null;
    throw err;
  }
}

export async function apiSetAiHelperOptIn(studentId: string, on: boolean): Promise<string> {
  const tenantId = tenantIdOrThrow();
  const { ai_helper } = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/ai-helper", {
    path: { tenantId, learnerId: studentId },
    tenantId,
  });
  const current = ai_helper.current_term;
  if (!current) throw new Error("There is no current term open.");
  await apiClient().put("/v1/tenants/{tenantId}/finance/ai-helper/optins", {
    path: { tenantId },
    tenantId,
    body: { learner_id: studentId, term_id: current.id, opted_in: on },
  });
  return on ? "on" : "off";
}
