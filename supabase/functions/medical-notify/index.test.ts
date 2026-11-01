import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle, mayNotify } from "./index.ts";

function clients(caller: Record<string, unknown>, areas: string[] = []) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: "u1", tenant_id: "t1", ...caller }]);
  admin.seed("staff_permissions", areas.map((area) => ({ tenant_id: "t1", profile_id: "u1", area })));
  admin.seed("sick_bay_visits", [{ id: "v1", tenant_id: "t1" }]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "u1" };
  return { admin, asUser };
}

Deno.test("the office and whoever holds the medical area may ask for pushes", async () => {
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "school_admin", tenant_id: "t1" }, "t1"), true);
  assertEquals(await mayNotify(clients({}, ["medical"]).admin, { id: "u1", role: "staff", tenant_id: "t1" }, "t1"), true);
  assertEquals(await mayNotify(clients({}, ["medical"]).admin, { id: "u1", role: "teacher", tenant_id: "t1" }, "t1"), true);
});

Deno.test("anyone else may not: no area, another area, another school, a parent", async () => {
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "teacher", tenant_id: "t1" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["people"]).admin, { id: "u1", role: "staff", tenant_id: "t1" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["medical"]).admin, { id: "u1", role: "staff", tenant_id: "t2" }, "t1"), false);
  assertEquals(await mayNotify(clients({}).admin, { id: "u1", role: "school_admin", tenant_id: "t2" }, "t1"), false);
  assertEquals(await mayNotify(clients({}, ["medical"]).admin, { id: "u1", role: "parent", tenant_id: "t1" }, "t1"), false);
});

const request = (body: unknown = { visit_id: "v1" }) => new Request("https://example.com/medical-notify", {
  method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify(body),
});

Deno.test("a teacher without the medical area is refused", async () => {
  const res = await handle(request(), { ...clients({ role: "teacher" }), account: null });
  assertEquals(res.status, 403);
});

Deno.test("an unknown visit is a 404, a missing id a 400", async () => {
  assertEquals((await handle(request({ visit_id: "nope" }), { ...clients({ role: "school_admin" }), account: null })).status, 404);
  assertEquals((await handle(request({}), { ...clients({ role: "school_admin" }), account: null })).status, 400);
});

Deno.test("the nurse gets through (nothing to push without FCM configured, and nothing claimed)", async () => {
  const c = clients({ role: "staff" }, ["medical"]);
  c.admin.seed("medical_notices", [{ id: "n1", visit_id: "v1", profile_id: "p1", title: "t", body: "b", pushed_at: null, created_at: new Date().toISOString() }]);
  const res = await handle(request(), { ...c, account: null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).skipped, "push is not configured on this project");
  const { data } = await c.admin.from("medical_notices").select("pushed_at").eq("id", "n1").maybeSingle();
  assertEquals(data?.pushed_at, null);
});
