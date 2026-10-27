/**
 * Bloom: AI drafting for staff, and the study helper for learners. The one
 * place the platform calls a model. The API key, the prompts (tasks.ts) and
 * every check live here, never in an app:
 *  - who: the task's roles (tasks.ts ALLOWED), at a school with AI switched
 *    on. An org admin acting inside a member school names it (tenantId) and
 *    counts as that school's office; the study helper also needs the school to have turned it on, and is
 *    off while the learner has an exam in progress or open
 *    (ai_tutor_blocked() in 20261026040000_ai_assist.sql)
 *  - how much: the school's monthly token allowance (tenants.ai_monthly_tokens,
 *    each web search counted as ai_tokens_per_search() tokens) and a daily
 *    request cap per person
 *  - what is sent: only what the task needs. Report card drafting gets a
 *    first name and results, never an admission number or surname.
 *  - web search: Bloom chat only, when the school allows it
 *    (tenants.ai_web_search_enabled) and the person's toggle is on; at most
 *    CHAT_MAX_SEARCHES a message. No other task is ever sent the tool.
 *  - what is kept: one ai_usage row per request (who, task, tokens, searches), never
 *    the prompt or the reply. A paper sent for importing is deleted from
 *    storage as soon as it has been read (documents.ts).
 *
 * Staff drafting tasks answer in JSON fixed by a schema; the app shows the
 * draft for a person to edit, and nothing is saved or sent from here. Bloom
 * chat answers in Markdown; the app keeps the person's own chat history
 * (ai_chats, 20261027060000_ai_chat_workspace.sql), not this function.
 *
 * Which model answers is a secret, not code (providers.ts): AI_PROVIDER
 * "openai" (the default, with OPENAI_API_KEY) or "anthropic" (with
 * ANTHROPIC_API_KEY), and optionally AI_MODEL.
 * Deploy: supabase functions deploy ai-assist
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { paperImportContent, readStaged } from "./documents.ts";
import { aiFromEnv, type AiCall, type AiReply, type AiRequest, type WebSearch } from "./providers.ts";
import {
  ALLOWED, BadInput, CHAT_MAX_SEARCHES, chatMessages, chatSystem, EFFORT, PAPER_IMPORT_SCHEMA, paperImportRequest, paperImportSystem, prepare, TASKS, tutorMessages, tutorSystem,
  type Role, type Task,
} from "./tasks.ts";

/** Requests per person per day: staff draft in batches at the end of term; a learner chats. */
export const DAILY_LIMIT: Record<Role, number> = { school_admin: 400, teacher: 400, student: 80 };

/** The configured model, or why there isn't one (a missing key): checked before anything else is spent. */
export type AiSetup = { call: AiCall; model: string } | { error: string };

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any; ai: AiSetup }

const CLASS_WORD: Record<string, string> = {
  pre_primary: "PP", primary: "Grade ", junior_secondary: "Grade ", senior_school: "Grade ", secondary: "Form ",
};

export async function handle(req: Request, { admin, asUser, ai }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!req.headers.get("Authorization")) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const { data: caller } = await admin.from("profiles").select("id, role, tenant_id").eq("id", user.id).maybeSingle();
  if (!caller) return json({ error: "Bloom is for school accounts." }, 403);

  let body: { task?: string; payload?: unknown; tenantId?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  // An org admin has no school of their own; inside a member school's
  // console they work as its office, against that school's switch and allowance.
  let tenantId: string | null = caller.tenant_id;
  let effectiveRole: string = caller.role;
  if (caller.role === "org_admin" && typeof body.tenantId === "string") {
    const { data: school } = await admin.from("tenants").select("id, organization_id").eq("id", body.tenantId).maybeSingle();
    const { data: membership } = school?.organization_id
      ? await admin.from("organization_admins").select("id").eq("profile_id", caller.id).eq("organization_id", school.organization_id).maybeSingle()
      : { data: null };
    if (membership) { tenantId = school.id; effectiveRole = "school_admin"; }
  }
  if (!tenantId) return json({ error: "Bloom is for school accounts." }, 403);

  const task = body.task as Task;
  if (!TASKS.includes(task)) return json({ error: "Unknown task." }, 400);
  if (!(ALLOWED[task] as string[]).includes(effectiveRole)) return json({ error: "Your account can't use this." }, 403);
  const role = effectiveRole as Role;

  const { data: tenant } = await admin.from("tenants")
    .select("id, name, country, ai_enabled, ai_tutor_enabled, ai_web_search_enabled, ai_monthly_tokens").eq("id", tenantId).maybeSingle();
  if (!tenant?.ai_enabled) return json({ error: "Bloom is turned off for this school. The school office can turn it on in School settings." }, 403);
  if ("error" in ai) {
    console.error("ai-assist:", ai.error);
    return json({ error: "Bloom isn't set up yet. Please tell the school office." }, 503);
  }

  // Build the request before spending anything, so a bad input costs nothing.
  let system: string;
  let messages: AiRequest["messages"];
  let schema: Record<string, unknown> | null = null;
  // Only the chat branch below ever sets this.
  let webSearch: WebSearch | null = null;
  try {
    if (task === "tutor") {
      if (!tenant.ai_tutor_enabled) return json({ error: "Bloom isn't turned on for learners at your school." }, 403);
      const { data: blocked } = await admin.rpc("ai_tutor_blocked", { p_profile_id: caller.id });
      if (blocked) return json({ error: blocked, blocked: true }, 423);
      const { data: me } = await admin.from("students")
        .select("classes(level, form_level)").eq("profile_id", caller.id).eq("active", true).maybeSingle();
      const level: string = me?.classes?.level ?? "";
      const label = level ? `${CLASS_WORD[level] ?? "Year "}${me.classes.form_level}` : "";
      system = tutorSystem(label, level === "secondary" ? "844" : "cbc");
      messages = tutorMessages(body.payload ?? {});
    } else if (task === "paper_import") {
      const request = paperImportRequest(body.payload, tenant.id, caller.id);
      system = paperImportSystem(request.kind);
      schema = PAPER_IMPORT_SCHEMA;
      messages = [{ role: "user", content: paperImportContent(request, await readStaged(admin, request.paths)) }];
    } else if (task === "chat") {
      const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi" });
      webSearch = chatWebSearch(body.payload, tenant);
      system = chatSystem(tenant.name ?? "", role === "teacher" ? "teacher" : "school_admin", today, webSearch !== null);
      messages = chatMessages(body.payload ?? {});
    } else {
      const prepared = prepare(task, body.payload);
      system = prepared.system;
      schema = prepared.schema as Record<string, unknown> | null;
      messages = [{ role: "user", content: prepared.user }];
    }
  } catch (err) {
    if (err instanceof BadInput) return json({ error: err.message }, 400);
    throw err;
  }

  // Allowance: the school's month, and this person's day.
  const { data: used } = await admin.rpc("ai_month_tokens", { p_tenant_id: tenant.id });
  if (Number(used ?? 0) >= Number(tenant.ai_monthly_tokens ?? 0)) {
    return json({ error: "Your school has used this month's Bloom allowance. It resets on the 1st." }, 429);
  }
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true })
    .eq("profile_id", caller.id).gte("created_at", dayStart.toISOString());
  if ((count ?? 0) >= DAILY_LIMIT[role]) return json({ error: "You've reached today's limit for Bloom. Try again tomorrow." }, 429);

  const log = (reply: AiReply | null, outcome: "ok" | "refused" | "error") =>
    admin.from("ai_usage").insert({
      tenant_id: tenant.id, profile_id: caller.id, task, model: reply?.model ?? ai.model, outcome,
      input_tokens: reply?.inputTokens ?? 0, output_tokens: reply?.outputTokens ?? 0,
      // left null when the tool wasn't offered; searches are billed even when the answer is refused or cut off
      ...(webSearch ? { searches: reply?.searches ?? 0 } : {}),
    });

  let reply: AiReply;
  try {
    reply = await ai.call({ system, messages, schema, effort: EFFORT[task], webSearch });
  } catch (err) {
    await log(null, "error");
    console.error("ai-assist: model call failed", err instanceof Error ? err.message : err);
    return json({ error: "Bloom didn't answer. Please try again in a minute." }, 502);
  }

  if (reply.outcome === "refused") {
    await log(reply, "refused");
    return json({
      error: task === "tutor" ? "I can't help with that one. Try asking about your schoolwork."
        : task === "chat" ? "Bloom can't help with that one. Try asking another way."
        : task === "paper_import" ? "Bloom couldn't read this paper. Check it's the right file."
        : "Bloom couldn't draft this. Try rewording it.",
    }, 422);
  }
  if (reply.outcome === "too_long") {
    await log(reply, "error");
    return json({
      error: task === "chat" ? "That answer ran too long. Try asking for less at once, or start a new chat."
        : task === "paper_import" ? "That paper is too long to import in one go. Import it a section at a time."
        : "That was too much to draft at once. Try asking for less.",
    }, 422);
  }

  await log(reply, "ok");
  if (task === "chat") return json({ result: { text: reply.text, sources: reply.sources } });
  if (!schema) return json({ result: { text: reply.text } });
  try {
    return json({ result: JSON.parse(reply.text) });
  } catch {
    return json({ error: "The draft came back in an unexpected form. Please try again." }, 502);
  }
}

/**
 * Bloom chat's web search: on unless the school has switched it off or the
 * person turned it off for this chat (payload.webSearch === false), and
 * localised to the school's country (Kenya's time zone for a Kenyan school).
 */
export function chatWebSearch(payload: unknown, tenant: { country?: string | null; ai_web_search_enabled?: boolean | null }): WebSearch | null {
  if (tenant.ai_web_search_enabled === false) return null;
  if ((payload as { webSearch?: unknown } | null)?.webSearch === false) return null;
  const country = typeof tenant.country === "string" && /^[A-Z]{2}$/.test(tenant.country) ? tenant.country : "KE";
  return { maxUses: CHAT_MAX_SEARCHES, country, ...(country === "KE" ? { timezone: "Africa/Nairobi" } : {}) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

if (import.meta.main) {
  const ai = aiFromEnv((name) => Deno.env.get(name));
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    return handle(req, { admin, asUser, ai });
  });
}
