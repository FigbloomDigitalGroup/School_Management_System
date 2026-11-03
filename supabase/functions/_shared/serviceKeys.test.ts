import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals } from "jsr:@std/assert";
import { describeKey, injectedServerKeys, matchesAnyKey } from "./serviceKeys.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

describe("injectedServerKeys", () => {
  it("collects the legacy service_role key and every named secret key", () => {
    assertEquals(injectedServerKeys(env({
      SUPABASE_SERVICE_ROLE_KEY: " legacy ", SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_a", ci: "sb_secret_b" }),
    })), ["legacy", "sb_secret_a", "sb_secret_b"]);
  });
  it("copes with neither, or with a SUPABASE_SECRET_KEYS that isn't JSON", () => {
    assertEquals(injectedServerKeys(env({})), []);
    assertEquals(injectedServerKeys(env({ SUPABASE_SERVICE_ROLE_KEY: "legacy", SUPABASE_SECRET_KEYS: "{oops" })), ["legacy"]);
  });
});

describe("matchesAnyKey", () => {
  it("matches any of the keys, exactly", () => {
    assert(matchesAnyKey("b", ["a", "b"]));
    assert(!matchesAnyKey("b ", ["a", "b"]));
    assert(!matchesAnyKey("", ["a"]));
    assert(!matchesAnyKey(null, ["a"]));
    assert(!matchesAnyKey("a", []));
  });
});

describe("describeKey", () => {
  it("says what kind of key it is without giving it away", () => {
    const jwt = `${b64({ alg: "HS256" })}.${b64({ role: "service_role", ref: "ynxxzyyespdzvmerozyd", iat: 1700000000 })}.c2lnbmF0dXJl`;
    assertEquals(describeKey(jwt), `JWT (${jwt.length} chars; role=service_role, ref=ynxxzyyespdzvmerozyd, iat=1700000000)`);
    assertEquals(describeKey("sb_secret_0123456789"), "sb_secret_ key (20 chars)");
    assertEquals(describeKey("sb_publishable_x"), "sb_publishable_ key (16 chars)");
    assertEquals(describeKey("x".repeat(40)), "other (40 chars)");
    assertEquals(describeKey(null), "none");
    assert(!describeKey(jwt).includes("c2lnbmF0dXJl"));
  });
});
