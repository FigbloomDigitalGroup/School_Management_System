import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

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

const ACCOUNT = { project_id: "test-project", client_email: "test@test-project.iam.gserviceaccount.com", private_key: TEST_PRIVATE_KEY };
const DRIVER_ID = "driver-1";
const TRIP_ID = "trip-1";
const NOW = new Date("2026-10-27T13:00:00Z");
const RECENT = "2026-10-27T12:50:00Z";

function setup(opts: { caller?: string } = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("trips", [{ id: TRIP_ID, driver_id: DRIVER_ID }]);
  admin.seed("students", [
    { id: "s-amani", full_name: "Amani Otieno" },
    { id: "s-wanjiru", full_name: "Wanjiru Kamau" },
  ]);
  admin.seed("guardians", [
    { profile_id: "parent-amani", student_id: "s-amani" },
    { profile_id: "parent-wanjiru", student_id: "s-wanjiru" },
  ]);
  admin.seed("device_tokens", [
    { id: "tok-1", token: "phone-amani", profile_id: "parent-amani" },
    { id: "tok-2", token: "phone-wanjiru", profile_id: "parent-wanjiru" },
  ]);
  admin.seed("bus_updates", []);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: opts.caller ?? DRIVER_ID };
  return { admin, asUser };
}

function update(id: string, fields: Record<string, unknown>) {
  return { id, trip_id: TRIP_ID, kind: "boarded", student_ids: ["s-amani"], title: "Amani got on the bus at 15:31", body: "Left school on KCA 123A.", pushed_at: null, created_at: RECENT, ...fields };
}

function request(body: unknown = { trip_id: TRIP_ID }) {
  return new Request("https://example.com/rider-update", { method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify(body) });
}

/** FCM's token endpoint, then each send: records who got what. */
function fakeFetch(sent: { token: string; title: string }[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    if (href.includes("fcm.googleapis.com")) {
      const { message } = JSON.parse(String(init?.body));
      sent.push({ token: message.token, title: message.notification.title });
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${href}`);
  }) as unknown as typeof fetch;
}

describe("rider-update handle", () => {
  it("refuses anyone but the trip's own driver", async () => {
    const { admin, asUser } = setup({ caller: "someone-else" });
    const res = await handle(request(), { admin, asUser, account: ACCOUNT }, fakeFetch([]), NOW);
    assertEquals(res.status, 403);
  });

  it("pushes each unpushed rider update to that child's guardians only, once", async () => {
    const { admin, asUser } = setup();
    admin.seed("bus_updates", [
      update("u1", {}),
      update("u2", { kind: "distance", title: "Bus is 1 km away" }), // bus-tick's own, already pushed by it
      update("u3", { pushed_at: RECENT }),
      update("u4", { created_at: "2026-10-27T08:00:00Z" }), // stale
    ]);
    const sent: { token: string; title: string }[] = [];
    const res = await handle(request(), { admin, asUser, account: ACCOUNT }, fakeFetch(sent), NOW);
    assertEquals((await res.json()).pushed, 1);
    assertEquals(sent, [{ token: "phone-amani", title: "Amani got on the bus at 15:31" }]);
    assertEquals(admin.rowsIn("bus_updates").find((u) => u.id === "u1")!.pushed_at, NOW.toISOString());

    const again: { token: string; title: string }[] = [];
    await handle(request(), { admin, asUser, account: ACCOUNT }, fakeFetch(again), NOW);
    assertEquals(again, []);
  });

  it("names each family's own child in a breakdown", async () => {
    const { admin, asUser } = setup();
    admin.seed("bus_updates", [update("b1", { kind: "breakdown", student_ids: ["s-amani", "s-wanjiru"], title: "Bus has broken down (15:40)" })]);
    const sent: { token: string; title: string }[] = [];
    await handle(request(), { admin, asUser, account: ACCOUNT }, fakeFetch(sent), NOW);
    assertEquals(sent, [
      { token: "phone-amani", title: "Amani's bus has broken down (15:40)" },
      { token: "phone-wanjiru", title: "Wanjiru's bus has broken down (15:40)" },
    ]);
  });

  it("leaves updates unclaimed when push isn't configured", async () => {
    const { admin, asUser } = setup();
    admin.seed("bus_updates", [update("u1", {})]);
    const res = await handle(request(), { admin, asUser, account: null }, fakeFetch([]), NOW);
    assertEquals((await res.json()).pushed, 0);
    assertEquals(admin.rowsIn("bus_updates")[0]!.pushed_at, null);
  });
});
