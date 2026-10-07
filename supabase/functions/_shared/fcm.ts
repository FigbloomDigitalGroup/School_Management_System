// FCM HTTP v1, shared by send-push (announcements) and bus-tick (bus updates).
// Authenticated via a service-account JWT bearer flow (Web Crypto, no SDK —
// same hand-rolled-OAuth approach mpesa-stk-push already uses for Daraja).

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export interface ServiceAccount { project_id: string; client_email: string; private_key: string }

/** The FCM_SERVICE_ACCOUNT_JSON_B64 secret, decoded — null when push isn't configured. */
export function serviceAccountFromEnv(): ServiceAccount | null {
  // Base64, not raw JSON: a multi-line PEM inside a JSON string is exactly
  // the kind of secret value that shell/dotenv quoting mangles silently —
  // base64 has no characters either of those treats specially.
  const b64 = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON_B64");
  return b64 ? JSON.parse(atob(b64)) as ServiceAccount : null;
}

export async function fcmAccessToken(account: ServiceAccount, fetchImpl: typeof fetch): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Could not authenticate with FCM: ${await res.text()}`);
  const out = await res.json();
  return out.access_token as string;
}

/** `tag` collapses updates on the phone: a newer one with the same tag replaces the old. */
export async function sendToToken(
  fetchImpl: typeof fetch, projectId: string, accessToken: string, token: string, title: string, body: string,
  opts: { tag?: string } = {},
): Promise<{ ok: boolean; invalid: boolean }> {
  const message: Record<string, unknown> = { token, notification: { title, body } };
  if (opts.tag) message.android = { notification: { tag: opts.tag } };
  const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (res.ok) return { ok: true, invalid: false };
  const text = await res.text();
  const invalid = res.status === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(text);
  return { ok: false, invalid };
}
