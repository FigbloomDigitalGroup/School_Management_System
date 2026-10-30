import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle, mayNotify } from "./index.ts";

function clients(caller: Record<string, unknown>, areas: string[] = []) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: "u1", tenant_id: "t1", ...caller }]);
  admin.seed("staff_permissions", areas.map((area) => ({ tenant_id: "t1", profile_id: "u1", area })));
  admin.seed("visits", [{ id: "v1", tenant_id: "t1", visitor_name: "Grace Atieno", purpose: "Fees query", host_kind: "office", host_id: null, student_name: null, escalated: false, status: "expected", host_pushed_at: null, escalation_pushed_at: null }]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "u1" };
  return { admin, asUser };
}

Deno.test("the office and whoever holds the visitors area may ask for pushes", async () => {
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "school_admin", tenant_id: "t1" }, "t1"), true);
  assertEquals(await mayNotify(clients({}, ["visitors"]).admin, { id: "u1", role: "staff", tenant_id: "t1" }, "t1"), true);
  // a teacher can hold the visitor log now too
  assertEquals(await mayNotify(clients({}, ["visitors"]).admin, { id: "u1", role: "teacher", tenant_id: "t1" }, "t1"), true);
});

Deno.test("anyone else may not: no area, another area, another school, the retired desk roles", async () => {
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "staff", tenant_id: "t1" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["fees"]).admin, { id: "u1", role: "staff", tenant_id: "t1" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["visitors"]).admin, { id: "u1", role: "staff", tenant_id: "t2" }, "t1"), false);
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "school_admin", tenant_id: "t2" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["visitors"]).admin, { id: "u1", role: "guard", tenant_id: "t1" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["visitors"]).admin, { id: "u1", role: "parent", tenant_id: "t1" }, "t1"), false);
});

const request = () => new Request("https://example.com/visit-notify", {
  method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify({ visit_id: "v1" }),
});

Deno.test("other staff without the visitors area are refused", async () => {
  const res = await handle(request(), { ...clients({ role: "staff" }), account: null });
  assertEquals(res.status, 403);
});

Deno.test("other staff with the visitors area get through (nothing to push without FCM configured)", async () => {
  const res = await handle(request(), { ...clients({ role: "staff" }, ["visitors"]), account: null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).skipped, "push is not configured on this project");
});
