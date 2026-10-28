import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { sendToToken } from "./fcm.ts";

/** Records the FCM message sent and answers with `status`. */
function recorder(sent: Record<string, unknown>[], status = 200, reply = "{}"): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)).message);
    return new Response(reply, { status });
  }) as unknown as typeof fetch;
}

describe("sendToToken", () => {
  it("sends the title and body alone when nothing else is asked for", async () => {
    const sent: Record<string, unknown>[] = [];
    const r = await sendToToken(recorder(sent), "proj", "access", "tok", "Title", "Body");
    assertEquals(r, { ok: true, invalid: false });
    assertEquals(sent, [{ token: "tok", notification: { title: "Title", body: "Body" } }]);
  });

  it("adds the tag for the notification and the data for a tap", async () => {
    const sent: Record<string, unknown>[] = [];
    await sendToToken(recorder(sent), "proj", "access", "tok", "Title", "Body", {
      tag: "chat-1", data: { type: "chat", conversation_id: "c1" },
    });
    assertEquals(sent, [{
      token: "tok", notification: { title: "Title", body: "Body" },
      android: { notification: { tag: "chat-1" } },
      data: { type: "chat", conversation_id: "c1" },
    }]);
  });

  it("reports a token FCM no longer knows as invalid, so it can be dropped", async () => {
    const r = await sendToToken(recorder([], 404, "UNREGISTERED"), "proj", "access", "tok", "T", "B");
    assertEquals(r, { ok: false, invalid: true });
  });
});
