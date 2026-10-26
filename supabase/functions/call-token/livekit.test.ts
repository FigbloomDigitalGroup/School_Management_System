import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { accessToken, deleteRoom, httpUrl, isAudioTrack, liveKitConfigFromEnv } from "./livekit.ts";

const CONFIG = { url: "wss://figbloom-test.livekit.cloud", apiKey: "APItest", apiSecret: "test-secret-not-real" };

function decode(part: string) {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

describe("accessToken", () => {
  it("is an HS256 JWT signed with the API secret, carrying LiveKit's claims", async () => {
    const token = await accessToken(CONFIG, { identity: "p1", name: "Grace Wanjiru", metadata: '{"role":"host"}' },
      { room: "class-1", roomJoin: true, canPublish: true, roomAdmin: true }, 600, 1_000_000);
    const [h, p, s] = token.split(".");
    assertEquals(decode(h!), { alg: "HS256", typ: "JWT" });
    const claims = decode(p!);
    assertEquals(claims.iss, "APItest");
    assertEquals(claims.sub, "p1");
    assertEquals(claims.name, "Grace Wanjiru");
    assertEquals(claims.metadata, '{"role":"host"}');
    assertEquals(claims.nbf, 1_000_000);
    assertEquals(claims.exp, 1_000_600);
    assertEquals(claims.video, { room: "class-1", roomJoin: true, canPublish: true, roomAdmin: true });

    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CONFIG.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(s!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s!.length % 4)) % 4)), (c) => c.charCodeAt(0));
    assert(await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(`${h}.${p}`)));
  });
});

describe("config and urls", () => {
  it("needs all three secrets", () => {
    const env: Record<string, string> = { LIVEKIT_URL: CONFIG.url, LIVEKIT_API_KEY: "k" };
    assertEquals(liveKitConfigFromEnv((n) => env[n]), null);
    env.LIVEKIT_API_SECRET = "s";
    assertEquals(liveKitConfigFromEnv((n) => env[n]), { url: CONFIG.url, apiKey: "k", apiSecret: "s" });
  });

  it("calls the server API over https on the websocket's host", () => {
    assertEquals(httpUrl("wss://x.livekit.cloud/"), "https://x.livekit.cloud");
    assertEquals(httpUrl("ws://localhost:7880"), "http://localhost:7880");
  });

  it("counts a track with no type as audio (protobuf JSON drops AUDIO = 0)", () => {
    assert(isAudioTrack({ sid: "a" }));
    assert(isAudioTrack({ sid: "a", type: "AUDIO" }));
    assert(!isAudioTrack({ sid: "v", type: "VIDEO", source: "CAMERA" }));
  });
});

describe("deleteRoom", () => {
  it("treats a room that was never opened as already closed", async () => {
    const fetch404 = (async () => new Response('{"code":"not_found"}', { status: 404 })) as typeof fetch;
    await deleteRoom(CONFIG, "class-1", fetch404);
  });

  it("still reports a real failure", async () => {
    const fetch500 = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await assertRejects(() => deleteRoom(CONFIG, "class-1", fetch500), Error, "DeleteRoom failed (500)");
  });
});
