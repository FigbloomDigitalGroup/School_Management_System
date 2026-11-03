import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { PlatformClient, platformConfigFromEnv, PlatformError } from "./platformClient.ts";
import { FakePlatform, PLATFORM_CONFIG } from "./fakePlatform.ts";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("platformConfigFromEnv", () => {
  const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
  it("needs all four secrets", () => {
    assertEquals(platformConfigFromEnv(env({ PLATFORM_CLIENT_ID: "a", PLATFORM_CLIENT_SECRET: "b", PLATFORM_TOKEN_URL: "c" })), null);
    assertEquals(platformConfigFromEnv(env({})), null);
  });
  it("trims the API address's trailing slash", () => {
    const c = platformConfigFromEnv(env({ PLATFORM_CLIENT_ID: "a", PLATFORM_CLIENT_SECRET: "b", PLATFORM_TOKEN_URL: "https://t/oauth2/token", PLATFORM_API_URL: "https://api.test/" }));
    assertEquals(c?.apiUrl, "https://api.test");
  });
});

describe("PlatformClient tokens", () => {
  it("gets a client-credentials token with Basic auth and Schools' scopes, and sends it as a bearer token", async () => {
    const platform = new FakePlatform();
    await platform.client().putOrganization(ORG, { name: "Hillside Schools" });
    assertEquals(platform.tokensIssued, 1);
    assertEquals(platform.calls[0].token, "token-1");
  });

  it("keeps the token for later calls", async () => {
    const platform = new FakePlatform();
    const client = platform.client();
    await client.putOrganization(ORG, { name: "A" });
    await client.getOrganization(ORG);
    await client.putDecisionWebhook("https://schools.test/functions/v1/platform-decisions");
    assertEquals(platform.tokensIssued, 1);
  });

  it("fetches a new one a minute before the old one expires", async () => {
    const platform = new FakePlatform();
    platform.tokenSeconds = 600;
    let now = 0;
    const client = platform.client(() => now);
    await client.accessToken();
    now = 538_000; // 8:58, more than a minute left
    await client.accessToken();
    assertEquals(platform.tokensIssued, 1);
    now = 541_000; // 9:01, less than a minute left
    assertEquals(await client.accessToken(), "token-2");
  });

  it("on a 401, drops the token and tries once more with a new one", async () => {
    const platform = new FakePlatform();
    const client = platform.client();
    await client.accessToken();
    platform.revokeNext = 1;
    await client.putOrganization(ORG, { name: "A" });
    assertEquals(platform.tokensIssued, 2);
    assertEquals(platform.organizations.size, 1);
  });

  it("gives up after the second 401", async () => {
    const platform = new FakePlatform();
    platform.revokeNext = 5;
    const err = await assertRejects(() => platform.client().getOrganization(ORG), PlatformError);
    assertEquals(err.status, 401);
  });

  it("a refused token says so without repeating the secret", async () => {
    const platform = new FakePlatform();
    const client = new PlatformClient({ ...PLATFORM_CONFIG, clientSecret: "wrong-secret" }, { fetch: platform.fetch });
    const err = await assertRejects(() => client.accessToken(), PlatformError);
    assertEquals(err.code, "token_failed");
    assert(!err.message.includes("wrong-secret"));
  });
});

describe("PlatformClient calls", () => {
  it("sends the four calls to Schools' own product paths", async () => {
    const platform = new FakePlatform();
    const client = platform.client();
    await client.putOrganization(ORG, { name: "Hillside", owner_email: "owner@hillside.test" });
    await client.putTenant("22222222-2222-4222-8222-222222222222", { name: "Hillside Primary", slug: "hillside-primary", organization_local_id: ORG });
    await client.getOrganization(ORG);
    await client.putDecisionWebhook("https://schools.test/functions/v1/platform-decisions");
    assertEquals(platform.calls.map((c) => `${c.method} ${c.path}`), [
      `PUT /products/schools/organizations/${ORG}`,
      "PUT /products/schools/tenants/22222222-2222-4222-8222-222222222222",
      `GET /products/schools/organizations/${ORG}`,
      "PUT /products/schools/decision-webhook",
    ]);
    assertEquals(platform.tenants.get("22222222-2222-4222-8222-222222222222")?.local_slug, "hillside-primary");
  });

  it("turns the platform's error into a PlatformError with its code", async () => {
    const platform = new FakePlatform();
    const err = await assertRejects(
      () => platform.client().putTenant("t1", { name: "X", slug: "x-school", organization_local_id: ORG }), PlatformError);
    assertEquals([err.status, err.code, err.retryable], [409, "organization_not_registered", false]);
  });

  it("an unreachable platform is status 0, worth retrying", async () => {
    const platform = new FakePlatform();
    platform.down = 0;
    const err = await assertRejects(() => platform.client().getOrganization(ORG), PlatformError);
    assertEquals([err.status, err.code, err.retryable], [0, "unreachable", true]);
  });

  it("a 5xx is worth retrying", async () => {
    const platform = new FakePlatform();
    platform.down = 503;
    const err = await assertRejects(() => platform.client().getOrganization(ORG), PlatformError);
    assertEquals([err.status, err.retryable], [503, true]);
  });
});
