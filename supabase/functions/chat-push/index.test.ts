import { describe, it, afterEach, beforeEach } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle, pushBody } from "./index.ts";

// Test-only RSA key, generated for this suite. Never used for anything real.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDN7BK/Gmy3+pj3
P3OvGZ2cIFiOogLkU1pOhyn6OM5jWjQqcxbGUU8nRlr3f/8zP6tTGqWDUc5NDCnS
MKdAXZEqauSE5v82otd6YkX8WIHbHqh7c5Y5Cr02uZyQOsKmkUmcg8U2g726ORQc
h+OjvK1zjXnBTqIryFP/83DqLmQG+25BTvUVAEDZOQEeyYi/mTGxXqgpRsUKhok2
IkMmCjozrR2acLREl7TJrCmaj1g3ZZ7SHCj560bRiqGHKSnxRh1qtgsfRg/Yci8p
cF6SkUuteSxcvPE3nDVIVj1Vg0RxiDsQ2I5v4UqpNCeU7gadl5i6xTEKS/unHS8I
m/TXOVr/AgMBAAECggEASJw2nAYwUctehshr/VE1/yh0sY61IFe33zrP9Xh0ZhoX
jORaIoHnPD0VtHIAxcxsl/gsZprA+PASCxi20P5tQpzAiZB+a4COJIxkiy+WUnKE
DEvcq656u8JFT6I4os1WPIdGUguwKesYiVrtTP4p1zYKubwFeRTBcd4gcaL8CG2c
I8zBnQAt8nEPcJAC+UhSCeAvMzcariKwLUw0rNMnQXxFpRIxIT7WWheMuTU0+M2o
+U7xhPVMOWVYrdH0Se9T8EeWi29hhqgA6THU2P4bwMfEfC5qbYkkMb6W8mvZclaB
XeZe4MWxvG3BPkNgG7Ajwqxmflwfo5tbW16X7GKFQQKBgQDq1ZsFjY3Tgc0jkLyO
Cq2yuyQ7HCDhtDrUeH1PXFRMrlFYjjpAVDgT5iw6k8KzuVSO3YW6Xk9R1PcdQZtP
YEdsw4qda/238OQPIx47BtAkV81gXXk/7WLsy+vf8cqtUV1IpdngTV4uPCLPM98P
1frQ+sR+rUcjxiwyk2gPQf9f4QKBgQDge15D8hXh87hISKz41M9dkh1NHs2IFeJw
pRdmFCJV6Y1z65FeBZ8Thh/6igpbEVoUV7bCZwY26jEOH6kasqG5tUFD29Qi4pYd
+RuUXZUIdjCseyC++MLrHIFPhRQ3p2hgmw3IKpe7hqcALSmdBo3z+aaIFN9gsbSA
RCDF5neW3wKBgQCv3038eKkxMFMsQaeVUZYI93MI+eX+Y3ZzzdE7cFCKJTsy8UHb
D7f33zhcnnEBHNmhLXKLwznwdWik9o+UgOy9Hi1f/JLGAZkrZQes+UtFDKT5eMfo
AqdF5OtAittZtkgAsoVcIVVZlxwSxixWtdDkVgp3PNq8hhxvvEoAs1LIwQKBgE+l
1iN7gKIkDG2xQ5YiQ9UqY7UaSciQI0DegrfYSvp6nJLVsUVP70pJG42Ubuoy9Ogk
2xaM4VqYq4EcYK61VMaEdjyygclC5gqKeWuh7KAM92YrZcn8j4RGH+dsC2lXv6QP
P8uWuTFzLEvWul4ZlkJLgPflmABB7Q5Znds505K3AoGAGsj21Y2kvjlZfhk2n9wC
tPH+b39i0xrXg9vdBZEJGIjjh6faV2cqUD7VcNJyiWi+0mRIFPEgw9oMT0Kimtxb
LobdRRVQufvoJTSh/L124VSilEfU3nrgiyjo7pLaSTGCAF60IIJStFPL2KwXW6KR
cSX+25JWTOuVVsORSeU5EjI=
-----END PRIVATE KEY-----`;

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: "test-project", client_email: "test@test-project.iam.gserviceaccount.com", private_key: TEST_PRIVATE_KEY,
});

const PARENT_ID = "parent-1";
const TEACHER_ID = "teacher-1";

function makeClients(callerId = PARENT_ID) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: PARENT_ID, full_name: "Wanjiru Kamau", role: "parent" },
    { id: TEACHER_ID, full_name: "Mr Otieno", role: "teacher" },
  ]);
  admin.seed("conversation_members", [
    { conversation_id: "conv-1", profile_id: PARENT_ID },
    { conversation_id: "conv-1", profile_id: TEACHER_ID },
  ]);
  admin.seed("chat_messages", [
    { id: "msg-1", conversation_id: "conv-1", sender_id: PARENT_ID, body: "Is the trip on Friday still on?", file_name: null },
  ]);
  admin.seed("device_tokens", [
    { id: "dt-parent", profile_id: PARENT_ID, token: "parent-phone" },
    { id: "dt-teacher", profile_id: TEACHER_ID, token: "teacher-phone" },
  ]);
  admin.seed("notification_preferences", []);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: callerId };
  return { admin, asUser };
}

function request(body: unknown = { message_id: "msg-1" }, opts: { method?: string; auth?: string | null } = {}) {
  const headers = new Headers();
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token");
  return new Request("https://example.com/chat-push", {
    method: opts.method ?? "POST", headers,
    body: opts.method === "GET" || opts.method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

/** Routes the mocked fetch and records the FCM messages sent. */
function fakeFetch(sent: { token: string; title: string; body: string; tag?: string; data?: Record<string, string> }[], status = 200): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
    }
    if (href.includes("fcm.googleapis.com")) {
      const { message } = JSON.parse(String(init?.body));
      sent.push({ token: message.token, title: message.notification.title, body: message.notification.body, tag: message.android?.notification?.tag, data: message.data });
      return new Response(status === 200 ? "{}" : "UNREGISTERED", { status });
    }
    throw new Error(`Unexpected fetch to ${href}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  Deno.env.set("FCM_SERVICE_ACCOUNT_JSON_B64", btoa(SERVICE_ACCOUNT));
});
afterEach(() => {
  Deno.env.delete("FCM_SERVICE_ACCOUNT_JSON_B64");
});

describe("chat-push handle", () => {
  it("answers an OPTIONS preflight with CORS headers, no auth required", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({}, { method: "OPTIONS", auth: null }), { admin, asUser });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("rejects a request with no Authorization header", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(undefined, { auth: null }), { admin, asUser });
    assertEquals(res.status, 401);
  });

  it("rejects a body missing message_id", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({}), { admin, asUser });
    assertEquals(res.status, 400);
  });

  it("404s when the message does not exist", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request({ message_id: "missing" }), { admin, asUser });
    assertEquals(res.status, 404);
  });

  it("refuses anyone but the sender, even the other person in the chat", async () => {
    const { admin, asUser } = makeClients(TEACHER_ID);
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 403);
  });

  it("500s with a clear message when FCM_SERVICE_ACCOUNT_JSON_B64 is not set", async () => {
    Deno.env.delete("FCM_SERVICE_ACCOUNT_JSON_B64");
    const { admin, asUser } = makeClients();
    const res = await handle(request(), { admin, asUser });
    assertEquals(res.status, 500);
  });

  it("pushes to the other person only, titled with the sender's name, and a tap can open the conversation", async () => {
    const { admin, asUser } = makeClients();
    const sent: { token: string; title: string; body: string; tag?: string; data?: Record<string, string> }[] = [];
    const res = await handle(request(), { admin, asUser }, fakeFetch(sent));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { sent: 1, failed: 0 });
    assertEquals(sent, [{
      token: "teacher-phone", title: "Wanjiru Kamau", body: "Is the trip on Friday still on?", tag: "chat-conv-1",
      data: { type: "chat", conversation_id: "conv-1" },
    }]);
  });

  it("skips someone who turned chat pushes off", async () => {
    const { admin, asUser } = makeClients();
    admin.seed("notification_preferences", [{ profile_id: TEACHER_ID, chat_messages: false }]);
    const sent: { token: string; title: string; body: string }[] = [];
    const res = await handle(request(), { admin, asUser }, fakeFetch(sent));
    assertEquals((await res.json()).sent, 0);
    assertEquals(sent.length, 0);
  });

  it("drops a phone FCM no longer knows", async () => {
    const { admin, asUser } = makeClients();
    const res = await handle(request(), { admin, asUser }, fakeFetch([], 404));
    assertEquals(await res.json(), { sent: 0, failed: 1 });
    assertEquals(admin.rowsIn("device_tokens").map((t) => t.id), ["dt-parent"]);
  });
});

describe("pushBody", () => {
  it("shortens a long message to one line", () => {
    const out = pushBody("a ".repeat(200), null);
    assertEquals(out.length, 140);
    assertEquals(out.endsWith("…"), true);
  });
  it("names the file when there's no text", () => {
    assertEquals(pushBody(null, "receipt.pdf"), "Sent a file: receipt.pdf");
    assertEquals(pushBody("   ", null), "New message");
  });
});
