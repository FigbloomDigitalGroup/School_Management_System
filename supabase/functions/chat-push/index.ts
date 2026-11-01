/**
 * Tells the other person in a chat that a message arrived, via FCM's HTTP v1
 * API (Android only for now, same as send-push). The web app calls it right
 * after a message is sent; a chat works without it, so the app ignores failures.
 *
 * Only the sender may ask, and only for their own message: the database
 * already decided they could send it (chat_messages_send), so whoever else
 * is in the conversation is exactly who should hear about it. Anyone who has
 * turned chat pushes off (notification_preferences.chat_messages) is skipped.
 *
 * Deploy: supabase functions deploy chat-push
 * Needs the same FCM_SERVICE_ACCOUNT_JSON_B64 secret as send-push.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { fcmAccessToken, sendToToken, serviceAccountFromEnv } from "../_shared/fcm.ts";

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

const PREVIEW_MAX = 140;

/** The notification's text: the message itself (shortened), or what was attached. */
export function pushBody(body: string | null, fileName: string | null): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
  return fileName ? `Sent a file: ${fileName}` : "New message";
}

export async function handle(req: Request, { admin, asUser }: Deps, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { message_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body.message_id) return json({ error: "message_id is required" }, 400);

  const { data: message } = await admin
    .from("chat_messages").select("id, conversation_id, sender_id, body, file_name")
    .eq("id", body.message_id).maybeSingle();
  if (!message) return json({ error: "That message could not be found." }, 404);
  if (message.sender_id !== user.id) return json({ error: "You can only send push for your own message." }, 403);

  const serviceAccount = serviceAccountFromEnv();
  if (!serviceAccount) return json({ error: "Push is not configured on this project (FCM_SERVICE_ACCOUNT_JSON_B64 not set)." }, 500);

  try {
    const { data: members } = await admin
      .from("conversation_members").select("profile_id").eq("conversation_id", message.conversation_id);
    const others = ((members ?? []) as { profile_id: string }[]).map((m) => m.profile_id).filter((id) => id !== user.id);
    if (others.length === 0) return json({ sent: 0, failed: 0 });

    // No preferences row means the defaults, which have chat pushes on.
    const { data: prefs } = await admin
      .from("notification_preferences").select("profile_id, chat_messages").in("profile_id", others);
    const off = new Set(((prefs ?? []) as { profile_id: string; chat_messages: boolean }[])
      .filter((p) => p.chat_messages === false).map((p) => p.profile_id));
    const recipients = others.filter((id) => !off.has(id));
    if (recipients.length === 0) return json({ sent: 0, failed: 0, skipped: "chat pushes are turned off" });

    const { data: tokenRows } = await admin.from("device_tokens").select("id, token").in("profile_id", recipients);
    const tokens = (tokenRows ?? []) as { id: string; token: string }[];
    if (tokens.length === 0) return json({ sent: 0, failed: 0 });

    const { data: sender } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const title = sender?.full_name ?? "New message";
    const text = pushBody(message.body, message.file_name);

    const accessToken = await fcmAccessToken(serviceAccount, fetchImpl);
    let sent = 0;
    let failed = 0;
    const staleIds: string[] = [];
    for (const t of tokens) {
      // One notification per conversation on the phone: the newest replaces the last.
      const result = await sendToToken(fetchImpl, serviceAccount.project_id, accessToken, t.token, title, text, {
        tag: `chat-${message.conversation_id}`,
        // a tap opens this conversation
        data: { type: "chat", conversation_id: String(message.conversation_id) },
      });
      if (result.ok) sent++;
      else {
        failed++;
        if (result.invalid) staleIds.push(t.id);
      }
    }
    if (staleIds.length) await admin.from("device_tokens").delete().in("id", staleIds);

    return json({ sent, failed });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not send push notifications." }, 502);
  }
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    return handle(req, { admin, asUser });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
