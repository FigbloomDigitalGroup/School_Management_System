import { beforeAll, describe, expect, it } from "vitest";
import { signInAs } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 06 (FIG-1239): the two M-Pesa functions as the local edge runtime serves them, so the deployment settings in
 * supabase/config.toml are exercised too, not just the handler code (that is in supabase/functions/mpesa-*).
 *
 * Safaricom is never contacted and no payment can be created: every request here is turned away at the gateway or by the
 * function before it would call Daraja. A fake Daraja can't be put behind the runtime, so the paths that need one (a real
 * prompt, PIN and callback) are BLOCKED until sandbox credentials exist; the handlers are tested with Daraja played by a stub.
 *
 * These pass whether or not the local edge runtime has DARAJA_* secrets: the callback refuses anything without the exact
 * secret, and the push function checks its input before it looks at its own configuration.
 */

const base = () => assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin;
const anonKey = () => process.env.VITE_SUPABASE_ANON_KEY!;

async function call(fn: string, opts: { method?: string; token?: string | null; body?: string } = {}) {
  const { method = "POST", token = null, body } = opts;
  const res = await fetch(`${base()}/functions/v1/${fn}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
  return { status: res.status, text: await res.text() };
}

const INVOICE = "00000000-0000-0000-0000-000000000000";
const prompt = (over: Record<string, unknown> = {}) => JSON.stringify({ invoice_id: INVOICE, amount_cents: 50000, msisdn: "254712345678", ...over });

describe("mpesa-callback as deployed (verify_jwt = false)", () => {
  // A paid-looking body for a payment that does not exist: it must not matter what the body says without the secret
  const paid = JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_NOPE", ResultCode: 0, CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: "FORGED1" }] } } } });

  it("lets a caller with no JWT reach the function (Safaricom cannot send one), which then refuses it", async () => {
    const res = await call("mpesa-callback", { body: paid });
    expect(res.status, "401 here would mean the gateway wants a JWT, and no real callback could ever get in").toBe(403);
    expect(res.text).toBe("Forbidden");
  });

  it.each([
    ["no token", "mpesa-callback"],
    ["an empty token", "mpesa-callback?token="],
    ["a guessed token", "mpesa-callback?token=guess"],
    ["a token in the wrong parameter", "mpesa-callback?secret=guess"],
  ])("refuses a callback with %s", async (_label, path) => {
    expect((await call(path, { body: paid })).status).toBe(403);
  });

  it("refuses the project's anon key used as the token", async () => {
    expect((await call(`mpesa-callback?token=${encodeURIComponent(anonKey())}`, { body: paid })).status).toBe(403);
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("refuses a %s with no token, whatever the method", async (method) => {
    expect((await call("mpesa-callback", { method, body: paid })).status).toBe(403);
  });

  it("answers the same way to a signed-in user's JWT as to nobody: a JWT is not the secret", async () => {
    const parent = await signInAs("parent");
    const token = (await parent.client.auth.getSession()).data.session!.access_token;
    expect((await call("mpesa-callback", { token, body: paid })).status).toBe(403);
  });
});

describe("mpesa-stk-push as deployed (verify_jwt = true)", () => {
  let parentToken = "";
  let visiblePayments = 0;
  let parent: Awaited<ReturnType<typeof signInAs>>;

  const countPayments = async () => (await parent.client.from("payments").select("id", { count: "exact", head: true })).count ?? -1;

  beforeAll(async () => {
    parent = await signInAs("parent");
    parentToken = (await parent.client.auth.getSession()).data.session!.access_token;
    visiblePayments = await countPayments();
    expect(visiblePayments).toBeGreaterThanOrEqual(0);
  });

  it("turns away a request with no Authorization header at the gateway", async () => {
    expect((await call("mpesa-stk-push", { body: prompt() })).status).toBe(401);
  });

  it("turns away a bearer that is not a JWT", async () => {
    expect((await call("mpesa-stk-push", { token: "not.a.jwt", body: prompt() })).status).toBe(401);
  });

  it("turns away the project's anon key: a valid JWT, but not a user", async () => {
    const res = await call("mpesa-stk-push", { token: anonKey(), body: prompt() });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text)).toEqual({ error: "Unauthorized" });
  });

  it.each([
    ["a body that is not JSON", "not json"],
    ["a JSON array", "[]"],
    ["a JSON string", '"text"'],
    ["no invoice", JSON.stringify({ amount_cents: 50000, msisdn: "254712345678" })],
    ["an amount in cents that is not whole shillings", prompt({ amount_cents: 150 })],
    ["an amount below KSh 1", prompt({ amount_cents: 50 })],
    ["a fractional amount", prompt({ amount_cents: 50050.5 })],
    ["an amount as a string", prompt({ amount_cents: "50000" })],
    ["a number with a leading zero", prompt({ msisdn: "0712345678" })],
    ["a number with a plus sign", prompt({ msisdn: "+254712345678" })],
  ])("answers 400 to %s", async (_label, body) => {
    const res = await call("mpesa-stk-push", { token: parentToken, body });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).error).toEqual(expect.any(String));
  });

  it("answers 405 to a GET", async () => {
    expect((await call("mpesa-stk-push", { method: "GET", token: parentToken })).status).toBe(405);
  });

  it("created no payment through any of the refusals above", async () => {
    expect(await countPayments()).toBe(visiblePayments);
  });

  // `const { invoice_id, ... } = body` used to throw on a JSON null, and the runtime answered with its generic 500.
  it("FIG-1324 (fixed on main): answers 400 to a JSON null body, not an unhandled 500", async () => {
    const res = await call("mpesa-stk-push", { token: parentToken, body: "null" });
    expect(res.status).toBe(400);
  });
});
