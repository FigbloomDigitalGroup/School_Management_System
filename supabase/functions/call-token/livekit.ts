// LiveKit access tokens and the few RoomService calls a teacher's controls
// need, by hand: a token is an HS256 JWT and the server API is Twirp (JSON
// over POST), so there's no SDK to pin -- same hand-rolled approach
// _shared/fcm.ts takes with Google's OAuth.

export interface LiveKitConfig {
  /** wss://<project>.livekit.cloud -- what the browser connects to */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** The three LIVEKIT_* secrets, or null when calls aren't set up on this project. */
export function liveKitConfigFromEnv(get: (name: string) => string | undefined = (n) => Deno.env.get(n)): LiveKitConfig | null {
  const url = get("LIVEKIT_URL")?.trim();
  const apiKey = get("LIVEKIT_API_KEY")?.trim();
  const apiSecret = get("LIVEKIT_API_SECRET")?.trim();
  return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
}

/** What one person may do in one room. Field names are LiveKit's own claim names. */
export interface VideoGrant {
  room: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const text = (s: string) => new TextEncoder().encode(s);

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", text(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * A signed token for one person in one room. Short-lived: it only has to
 * last until they connect, and a leaked one is soon useless.
 */
export async function accessToken(
  config: Pick<LiveKitConfig, "apiKey" | "apiSecret">,
  who: { identity: string; name?: string; metadata?: string },
  grant: VideoGrant,
  ttlSeconds = 10 * 60,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64Url(text(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims: Record<string, unknown> = {
    iss: config.apiKey,
    sub: who.identity,
    jti: `${who.identity}-${now}`,
    nbf: now,
    exp: now + ttlSeconds,
    video: grant,
  };
  if (who.name) claims.name = who.name;
  if (who.metadata) claims.metadata = who.metadata;
  const unsigned = `${header}.${base64Url(text(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(config.apiSecret), text(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

/** The server API lives on the same host as the websocket, over https. */
export function httpUrl(url: string): string {
  return url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/+$/, "");
}

/** One RoomService call. Answers the parsed JSON, or throws with LiveKit's message. */
async function roomService<T>(
  config: LiveKitConfig, method: string, room: string, body: Record<string, unknown>, fetchImpl: typeof fetch,
): Promise<T> {
  const token = await accessToken(config, { identity: "figbloom-server" }, { room, roomAdmin: true }, 60);
  const res = await fetchImpl(`${httpUrl(config.url)}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ room, ...body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LiveKit ${method} failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

export interface RoomParticipant {
  identity: string;
  metadata?: string;
  // protobuf JSON leaves out zero values, so an AUDIO (0) track may have no type at all
  tracks?: { sid: string; type?: string | number; source?: string | number; muted?: boolean }[];
}

export async function listParticipants(config: LiveKitConfig, room: string, fetchImpl: typeof fetch): Promise<RoomParticipant[]> {
  const out = await roomService<{ participants?: RoomParticipant[] }>(config, "ListParticipants", room, {}, fetchImpl);
  return out.participants ?? [];
}

export function isAudioTrack(t: NonNullable<RoomParticipant["tracks"]>[number]): boolean {
  return t.type === undefined || t.type === "AUDIO" || t.type === 0 || t.source === "MICROPHONE" || t.source === 2;
}

export async function muteTrack(config: LiveKitConfig, room: string, identity: string, trackSid: string, fetchImpl: typeof fetch): Promise<void> {
  await roomService(config, "MutePublishedTrack", room, { identity, track_sid: trackSid, muted: true }, fetchImpl);
}

export async function setParticipantPublish(
  config: LiveKitConfig, room: string, identity: string, canPublish: boolean, fetchImpl: typeof fetch,
): Promise<void> {
  await roomService(config, "UpdateParticipant", room, {
    identity, permission: { can_subscribe: true, can_publish: canPublish, can_publish_data: true },
  }, fetchImpl);
}

/** Closes the room and disconnects everyone in it. A room nobody joined yet doesn't exist: that's fine. */
export async function deleteRoom(config: LiveKitConfig, room: string, fetchImpl: typeof fetch): Promise<void> {
  try {
    await roomService(config, "DeleteRoom", room, {}, fetchImpl);
  } catch (err) {
    if (err instanceof Error && /\(404\)|not_found/i.test(err.message)) return;
    throw err;
  }
}
