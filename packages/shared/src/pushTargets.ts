/**
 * Where a tapped push notification should take the person. The server puts a
 * small `data` map on a push (supabase/functions/_shared/fcm.ts sendToToken,
 * from chat-push, visit-notify and medical-notify); the phone apps read it back
 * here and open the screen. FCM data values are always strings.
 *
 * The `type` strings are the server's: keep them in step with those three
 * functions. A push with no `type` (an announcement, a bus update) or one this
 * version doesn't know opens the app as it always has.
 */

export type PushTarget =
  /** A new chat message: that conversation. */
  | { kind: "chat"; conversationId: string }
  /** A visitor for this teacher: the visitors list. */
  | { kind: "visit"; visitId: string }
  /** A sick bay notice to a guardian: the Health screen, on the child it is about. */
  | { kind: "health"; studentId: string | null; visitId: string | null };

/** An id as the database writes one (a UUID), and nothing a notification could smuggle in as a route parameter. */
const ID = /^[0-9a-fA-F-]{8,64}$/;

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** The destination in a notification's data, or null when it names none this app knows. */
export function pushTargetFrom(data: Record<string, unknown> | null | undefined): PushTarget | null {
  if (!data) return null;
  switch (data.type) {
    case "chat": {
      const conversationId = idOf(data.conversation_id);
      return conversationId ? { kind: "chat", conversationId } : null;
    }
    case "visit": {
      const visitId = idOf(data.visit_id);
      return visitId ? { kind: "visit", visitId } : null;
    }
    case "health":
      return { kind: "health", studentId: idOf(data.student_id), visitId: idOf(data.visit_id) };
    default:
      return null;
  }
}
