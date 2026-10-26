/**
 * Bloom: AI drafting for staff, and the study helper for learners. The one
 * place the platform calls a model. The API key, the prompts (tasks.ts) and
 * every check live here, never in an app:
 *  - who: the task's roles (tasks.ts ALLOWED), at a school with AI switched
 *    on; the study helper also needs the school to have turned it on, and is
 *    off while the learner has an exam in progress or open
 *    (ai_tutor_blocked() in 20261026040000_ai_assist.sql)
 *  - how much: the school's monthly token allowance (tenants.ai_monthly_tokens)
 *    and a daily request cap per person
 *  - what is sent: only what the task needs. Report card drafting gets a
 *    first name and results, never an admission number or surname.
 *  - what is kept: one ai_usage row per request (who, task, tokens), never
 *    the prompt or the reply.
 *
 * Staff tasks answer in JSON fixed by a schema; the app shows the draft for
 * a person to edit, and nothing is saved or sent from here.
 *
 * Which model answers is a secret, not code (providers.ts): AI_PROVIDER
 * "openai" (the default, with OPENAI_API_KEY) or "anthropic" (with
 * ANTHROPIC_API_KEY), and optionally AI_MODEL.
 * Deploy: supabase functions deploy ai-assist
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { aiFromEnv, type AiCall, type AiReply } from "./providers.ts";
import { ALLOWED, BadInput, EFFORT, prepare, TASKS, tutorMessages, tutorSystem, type Role, type Task } from "./tasks.ts";

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
  if (!caller?.tenant_id) return json({ error: "Bloom is for school accounts." }, 403);

  let body: { task?: string; payload?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const task = body.task as Task;
  if (!TASKS.includes(task)) return json({ error: "Unknown task." }, 400);
  if (!(ALLOWED[task] as string[]).includes(caller.role)) return json({ error: "Your account can't use this." }, 403);
  const role = caller.role as Role;

  const { data: tenant } = await admin.from("tenants")
    .select("id, name, country, ai_enabled, ai_tutor_enabled, ai_monthly_tokens").eq("id", caller.tenant_id).maybeSingle();
  if (!tenant?.ai_enabled) return json({ error: "Bloom is turned off for this school. The school office can turn it on in School settings." }, 403);
  if ("error" in ai) {
    console.error("ai-assist:", ai.error);
    return json({ error: "Bloom isn't set up yet. Please tell the school office." }, 503);
  }

  // Build the request before spending anything, so a bad input costs nothing.
  let system: string;
  let messages: { role: "user" | "assistant"; content: string }[];
  let schema: Record<string, unknown> | null = null;
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
    });

  let reply: AiReply;
  try {
    reply = await ai.call({ system, messages, schema, effort: EFFORT[task] });
  } catch (err) {
    await log(null, "error");
    console.error("ai-assist: model call failed", err instanceof Error ? err.message : err);
    return json({ error: "Bloom didn't answer. Please try again in a minute." }, 502);
  }

  if (reply.outcome === "refused") {
    await log(reply, "refused");
    return json({ error: task === "tutor" ? "I can't help with that one. Try asking about your schoolwork." : "Bloom couldn't draft this. Try rewording it." }, 422);
  }
  if (reply.outcome === "too_long") {
    await log(reply, "error");
    return json({ error: "That was too much to draft at once. Try asking for less." }, 422);
  }

  await log(reply, "ok");
  if (!schema) return json({ result: { text: reply.text } });
  try {
    return json({ result: JSON.parse(reply.text) });
  } catch {
    return json({ error: "The draft came back in an unexpected form. Please try again." }, 502);
  }
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
