import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const LIVEKIT = { url: "wss://figbloom-test.livekit.cloud", apiKey: "APItest", apiSecret: "test-secret-not-real" };
const TENANT = "tenant-1";

function claimsOf(token: string) {
  const b64 = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

function setup(meId: string) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [
    { id: "teacher-1", full_name: "Grace Wanjiru", role: "teacher", tenant_id: TENANT },
    { id: "parent-1", full_name: "Peter Otieno", role: "parent", tenant_id: TENANT },
    { id: "parent-2", full_name: "Mary Achieng", role: "parent", tenant_id: TENANT },
    { id: "learner-1", full_name: "Amani Otieno", role: "student", tenant_id: TENANT },
    { id: "other-school", full_name: "Someone Else", role: "teacher", tenant_id: "tenant-2" },
  ]);
  // parent-1 may call teacher-1; parent-2 may not
  admin.rpcAnswers.may_contact = ({ a, b }) => [a, b].includes("teacher-1") && [a, b].includes("parent-1");
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: meId };
  return { admin, asUser };
}

function req(body: unknown) {
  return new Request("https://example.com/call-token", {
    method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify(body),
  });
}

/** Records RoomService calls; ListParticipants answers with `participants`. */
function liveKitFetch(participants: unknown[] = []) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const method = url.toString().split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    if (method === "ListParticipants") return new Response(JSON.stringify({ participants }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("call-token: setup", () => {
  it("says calls aren't set up when the LiveKit secrets are missing", async () => {
    const { admin, asUser } = setup("parent-1");
    const res = await handle(req({ action: "call", callee_id: "teacher-1" }), { admin, asUser, liveKit: null });
    assertEquals(res.status, 503);
  });

  it("needs a signed-in user", async () => {
    const { admin, asUser } = setup("parent-1");
    asUser.authUser = null;
    const res = await handle(req({ action: "call" }), { admin, asUser, liveKit: LIVEKIT });
    assertEquals(res.status, 401);
  });
});

describe("call-token: 1:1 calls", () => {
  it("rings someone the caller may contact, and gives the caller a token for the call's room", async () => {
    const { admin, asUser } = setup("parent-1");
    const res = await handle(req({ action: "call", callee_id: "teacher-1", video: true }), { admin, asUser, liveKit: LIVEKIT });
    assertEquals(res.status, 200);
    const out = await res.json();
    const [row] = admin.rowsIn("calls");
    assertEquals(row!.caller_name, "Peter Otieno");
    assertEquals(row!.callee_name, "Grace Wanjiru");
    assertEquals(row!.video, true);
    assertEquals(out.url, LIVEKIT.url);
    const claims = claimsOf(out.token);
    assertEquals(claims.sub, "parent-1");
    assertEquals(claims.video.room, `call-${row!.id}`);
  });

  it("refuses a pairing the school's rule doesn't allow", async () => {
    const { admin, asUser } = setup("parent-2");
    const res = await handle(req({ action: "call", callee_id: "teacher-1" }), { admin, asUser, liveKit: LIVEKIT });
    assertEquals(res.status, 403);
    assertEquals(admin.rowsIn("calls").length, 0);
  });

  it("can't reach someone at another school", async () => {
    const { admin, asUser } = setup("parent-1");
    const res = await handle(req({ action: "call", callee_id: "other-school" }), { admin, asUser, liveKit: LIVEKIT });
    assertEquals(res.status, 404);
  });

  it("lets the callee join only once they've answered, and nobody else at all", async () => {
    const { admin, asUser } = setup("teacher-1");
    admin.seed("calls", [{ id: "c1", caller_id: "parent-1", callee_id: "teacher-1", status: "ringing" }]);
    assertEquals((await handle(req({ action: "join_call", call_id: "c1" }), { admin, asUser, liveKit: LIVEKIT })).status, 410);

    admin.seed("calls", [{ id: "c1", caller_id: "parent-1", callee_id: "teacher-1", status: "accepted" }]);
    assertEquals((await handle(req({ action: "join_call", call_id: "c1" }), { admin, asUser, liveKit: LIVEKIT })).status, 200);

    asUser.authUser = { id: "parent-2" };
    assertEquals((await handle(req({ action: "join_call", call_id: "c1" }), { admin, asUser, liveKit: LIVEKIT })).status, 404);
  });
});

describe("call-token: live classes", () => {
  it("lets only a teacher of the class go live", async () => {
    const { admin, asUser } = setup("teacher-1");
    asUser.rpcAnswers.may_host_class = () => false;
    const res = await handle(req({ action: "start_class", class_id: "class-1", title: "Form 2 East" }), { admin, asUser, liveKit: LIVEKIT });
    assertEquals(res.status, 403);
  });

  it("starts the class once, and rejoins it rather than starting a second", async () => {
    const { admin, asUser } = setup("teacher-1");
    admin.seed("classes", [{ id: "class-1", tenant_id: TENANT }]);
    asUser.rpcAnswers.may_host_class = () => true;
    const body = { action: "start_class", class_id: "class-1", title: "Form 2 East · Mathematics" };
    const first = await (await handle(req(body), { admin, asUser, liveKit: LIVEKIT })).json();
    const second = await (await handle(req(body), { admin, asUser, liveKit: LIVEKIT })).json();
    assertEquals(admin.rowsIn("live_classes").length, 1);
    assertEquals(first.live_class.id, second.live_class.id);
    assertEquals(claimsOf(first.token).video.roomAdmin, true);
  });

  it("lets learners speak only when the teacher allows it; parents only watch", async () => {
    const { admin, asUser } = setup("learner-1");
    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", learners_may_publish: false, ended_at: null }]);
    asUser.rpcAnswers.live_class_role = () => "learner";
    let out = await (await handle(req({ action: "join_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT })).json();
    assertEquals(claimsOf(out.token).video.canPublish, false);

    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", learners_may_publish: true, ended_at: null }]);
    out = await (await handle(req({ action: "join_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT })).json();
    assertEquals(claimsOf(out.token).video.canPublish, true);

    asUser.rpcAnswers.live_class_role = () => "family";
    out = await (await handle(req({ action: "join_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT })).json();
    assertEquals(claimsOf(out.token).video.canPublish, false);
  });

  it("turns away someone outside the class, and anyone once it has ended", async () => {
    const { admin, asUser } = setup("parent-2");
    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", ended_at: null }]);
    asUser.rpcAnswers.live_class_role = () => null;
    assertEquals((await handle(req({ action: "join_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT })).status, 403);

    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", ended_at: "2026-10-27T09:00:00Z" }]);
    asUser.rpcAnswers.live_class_role = () => "learner";
    assertEquals((await handle(req({ action: "join_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT })).status, 410);
  });

  it("mutes every learner's open mic but not the teacher's", async () => {
    const { admin, asUser } = setup("teacher-1");
    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", ended_at: null }]);
    asUser.rpcAnswers.live_class_role = () => "host";
    const lk = liveKitFetch([
      { identity: "teacher-1", metadata: '{"role":"host"}', tracks: [{ sid: "TA", type: "AUDIO" }] },
      { identity: "learner-1", metadata: '{"role":"learner"}', tracks: [{ sid: "LA" }, { sid: "LV", type: "VIDEO" }] },
      { identity: "learner-2", metadata: '{"role":"learner"}', tracks: [{ sid: "MA", type: "AUDIO", muted: true }] },
    ]);
    const out = await (await handle(req({ action: "mute_all", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT }, lk.impl)).json();
    assertEquals(out.muted, 1);
    const mutes = lk.calls.filter((c) => c.method === "MutePublishedTrack");
    assertEquals(mutes.map((c) => c.body.track_sid), ["LA"]);
  });

  it("won't let a learner use the teacher's controls", async () => {
    const { admin, asUser } = setup("learner-1");
    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", ended_at: null }]);
    asUser.rpcAnswers.live_class_role = () => "learner";
    const res = await handle(req({ action: "end_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT });
    assertEquals(res.status, 403);
    assertEquals(admin.rowsIn("live_classes")[0]!.ended_at, null);
  });

  it("ends the class and closes its room", async () => {
    const { admin, asUser } = setup("teacher-1");
    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", ended_at: null }]);
    asUser.rpcAnswers.live_class_role = () => "host";
    const lk = liveKitFetch();
    const res = await handle(req({ action: "end_class", live_class_id: "lc1" }), { admin, asUser, liveKit: LIVEKIT }, lk.impl);
    assertEquals(res.status, 200);
    assert(admin.rowsIn("live_classes")[0]!.ended_at);
    assertEquals(lk.calls.map((c) => [c.method, c.body.room]), [["DeleteRoom", "class-lc1"]]);
  });

  it("changes what learners already in the room may do", async () => {
    const { admin, asUser } = setup("teacher-1");
    admin.seed("live_classes", [{ id: "lc1", class_id: "class-1", ended_at: null, learners_may_publish: false }]);
    asUser.rpcAnswers.live_class_role = () => "host";
    const lk = liveKitFetch([
      { identity: "teacher-1", metadata: '{"role":"host"}' },
      { identity: "learner-1", metadata: '{"role":"learner"}' },
      { identity: "parent-1", metadata: '{"role":"family"}' },
    ]);
    await handle(req({ action: "learners_may_publish", live_class_id: "lc1", allow: true }), { admin, asUser, liveKit: LIVEKIT }, lk.impl);
    assertEquals(admin.rowsIn("live_classes")[0]!.learners_may_publish, true);
    const updates = lk.calls.filter((c) => c.method === "UpdateParticipant");
    assertEquals(updates.map((c) => c.body.identity), ["learner-1"]);
  });
});
