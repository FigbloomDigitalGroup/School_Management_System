import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle, mayNotify } from "./index.ts";

Deno.test("the office and whoever keeps the visitor log may ask for pushes", () => {
  assertEquals(mayNotify({ role: "school_admin" }), true);
  assertEquals(mayNotify({ role: "staff", handles_visitors: true }), true);
});

Deno.test("other staff without the visitor log, teachers and the retired desk roles may not", () => {
  assertEquals(mayNotify({ role: "staff", handles_visitors: false }), false);
  assertEquals(mayNotify({ role: "staff", handles_visitors: null }), false);
  assertEquals(mayNotify({ role: "teacher", handles_visitors: true }), false);
  assertEquals(mayNotify({ role: "guard" }), false);
  assertEquals(mayNotify({ role: "receptionist" }), false);
});

function clients(caller: Record<string, unknown>) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", [{ id: "u1", tenant_id: "t1", ...caller }]);
  admin.seed("visits", [{ id: "v1", tenant_id: "t1", visitor_name: "Grace Atieno", purpose: "Fees query", host_kind: "office", host_id: null, student_name: null, escalated: false, status: "expected", host_pushed_at: null, escalation_pushed_at: null }]);
  const asUser = new FakeSupabaseClient();
  asUser.authUser = { id: "u1" };
  return { admin, asUser };
}

const request = () => new Request("https://example.com/visit-notify", {
  method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify({ visit_id: "v1" }),
});

Deno.test("other staff without the visitor log are refused", async () => {
  const res = await handle(request(), { ...clients({ role: "staff", handles_visitors: false }), account: null });
  assertEquals(res.status, 403);
});

Deno.test("other staff with the visitor log get through (nothing to push without FCM configured)", async () => {
  const res = await handle(request(), { ...clients({ role: "staff", handles_visitors: true }), account: null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).skipped, "push is not configured on this project");
});
