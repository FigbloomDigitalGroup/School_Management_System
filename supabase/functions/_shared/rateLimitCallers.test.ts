import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "./fakeSupabase.ts";
import { handle as searchSchools } from "../search-schools/index.ts";
import { handle as resolveLoginId } from "../resolve-login-id/index.ts";
import { handle as requestPasswordReset } from "../request-password-reset/index.ts";
import { handle as signupOrganization } from "../signup-organization/index.ts";

/**
 * Every public function that limits per caller (callerKey), driven with the
 * headers an attacker controls. The limiter records the key it is given and
 * refuses, so each handler stops at 429 before doing anything else: what
 * matters is that the key never changes with what the caller writes.
 */
// deno-lint-ignore no-explicit-any
type Handler = (req: Request, deps: any) => Promise<Response>;
const CALLERS: [string, Handler][] = [
  ["search-schools", searchSchools],
  ["resolve-login-id", resolveLoginId],
  ["request-password-reset", requestPasswordReset],
  ["signup-organization", signupOrganization],
];

async function keysFor(handler: Handler, requests: Record<string, string>[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const withinLimit = (k: string) => { keys.add(k); return Promise.resolve(false); };
  for (const headers of requests) {
    const res = await handler(
      new Request("https://example.com/f", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }),
      { admin: new FakeSupabaseClient(), withinLimit },
    );
    assertEquals(res.status, 429);
    await res.body?.cancel();
  }
  return keys;
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const rotating = (n: number, make: (i: number) => Record<string, string>) => Array.from({ length: n }, (_, i) => make(i));

for (const [name, handler] of CALLERS) {
  describe(`${name}: spoofed addresses share one allowance`, () => {
    it("Supabase Cloud: a rotating X-Forwarded-For doesn't change the caller", async () => {
      const keys = await keysFor(handler, rotating(10, (i) => ({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `10.${i}.0.1, 172.16.0.${i}` })));
      assertEquals(keys.size, 1);
    });

    it("Supabase Cloud: no CF-Connecting-IP, whatever else is sent, is one shared 'unknown' allowance", async () => {
      const keys = await keysFor(handler, [
        {}, { "x-forwarded-for": "6.6.6.6" }, { "x-forwarded-for": "7.7.7.7, 8.8.8.8" }, { "x-real-ip": "9.9.9.9" }, { "cf-connecting-ip": "spoof" },
      ]);
      assertEquals(keys.size, 1);
    });

    it("AWS: rotating the X-Forwarded-For entries left of the ALB's, or a fake CF-Connecting-IP, doesn't change the caller", async () => {
      await withEnv({ CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "2" }, async () => {
        const keys = await keysFor(handler, rotating(10, (i) => ({
          "x-forwarded-for": `${i}.${i}.${i}.${i}, 203.0.113.7, 10.0.1.23`,
          "cf-connecting-ip": `6.6.6.${i}`,
        })));
        assertEquals(keys.size, 1);
        const other = await keysFor(handler, [{ "x-forwarded-for": "198.51.100.9, 10.0.1.23" }]);
        assertNotEquals([...keys][0], [...other][0]);
      });
    });
  });
}
