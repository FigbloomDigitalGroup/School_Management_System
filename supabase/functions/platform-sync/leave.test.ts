// platform-sync leave_history_import (SCHOOLS_HR_LEAVE_CONTRACT.md section 3), against the fake HR.
import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { FakePlatform } from "../_shared/fakePlatform.ts";
import { FakeHr, HR_BASE } from "../_shared/fakeHr.ts";
import { handle } from "./index.ts";

const SYNC_KEY = "s".repeat(40);
const SCHOOL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNKNOWN_SCHOOL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

function setup({ configured = true, hrUrl = HR_BASE as string | null, linked = true } = {}) {
  const db = new FakeSupabaseClient();
  db.seed("tenants", [{ id: SCHOOL, name: "Hillside Primary", slug: "hillside" }]);
  if (linked) db.seed("platform_links", [{ kind: "tenant", local_id: SCHOOL, platform_id: "pt-1" }]);
  db.seed("profiles", [
    { id: T1, tenant_id: SCHOOL, role: "teacher", full_name: "Sketch Kamau" },
    { id: T2, tenant_id: SCHOOL, role: "staff", full_name: "Cate Cook" },
    { id: NEW, tenant_id: SCHOOL, role: "teacher", full_name: "Nina New" },
  ]);
  // staff HR knows: their schools.staff event was delivered (NEW's was skipped: the platform didn't know them)
  db.seed("platform_sync_queue", [
    { id: 1, kind: "staff", local_id: T1, tenant_id: SCHOOL, done_at: "2026-11-01T00:00:00Z", skipped: null },
    { id: 2, kind: "staff", local_id: T2, tenant_id: SCHOOL, done_at: "2026-11-01T00:00:00Z", skipped: null },
    { id: 3, kind: "staff", local_id: NEW, tenant_id: SCHOOL, done_at: "2026-11-01T00:00:00Z", skipped: "skipped_unlinked" },
  ]);
  db.seed("leave_requests", [
    { id: "l-1", tenant_id: SCHOOL, teacher_id: T1, starts_on: "2026-03-02", ends_on: "2026-03-06", status: "approved", source: "schools", reason: "Funeral" },
    { id: "l-2", tenant_id: SCHOOL, teacher_id: T2, starts_on: "2026-05-14", ends_on: "2026-05-14", status: "approved", source: "schools" },
    { id: "l-3", tenant_id: SCHOOL, teacher_id: T1, starts_on: "2026-06-01", ends_on: "2026-06-02", status: "rejected", source: "schools" },
    { id: "l-4", tenant_id: SCHOOL, teacher_id: T1, starts_on: "2026-07-01", ends_on: "2026-07-02", status: "pending", source: "schools" },
    { id: "l-5", tenant_id: SCHOOL, teacher_id: NEW, starts_on: "2026-08-03", ends_on: "2026-08-04", status: "approved", source: "schools" },
    { id: "l-6", tenant_id: SCHOOL, teacher_id: T1, starts_on: "2026-11-10", ends_on: "2026-11-11", status: "approved", source: "hr", hr_application_id: "app-1" },
  ]);
  const hr = new FakeHr();
  hr.link(SCHOOL, "company");
  hr.hire("company", T1, { number: "EMP-1", name: "Sketch Kamau" });
  hr.hire("company", T2, { number: "EMP-2", name: "Cate Cook" });
  const platform = new FakePlatform();
  const env = { get: (k: string) => ({ PLATFORM_SYNC_KEY: SYNC_KEY } as Record<string, string>)[k] };
  const call = async (body: unknown) => {
    const res = await handle(new Request("https://abc.supabase.co/functions/v1/platform-sync", {
      method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${SYNC_KEY}` },
    }), { admin: db, client: configured ? platform.client() : null, env, hrUrl, fetch: hr.fetch });
    return { status: res.status, out: await res.json() };
  };
  return { db, hr, call };
}

const exported = (db: FakeSupabaseClient) => db.rowsIn("leave_requests").filter((l) => l.hr_exported_at).map((l) => l.id).sort();

describe("platform-sync leave_history_import", () => {
  it("a dry run (the default) lists the approved Schools leave of staff HR knows, and who is left out; nothing is sent", async () => {
    const { call, hr, db } = setup({ configured: false, hrUrl: null });
    const { status, out } = await call({ action: "leave_history_import", school_id: SCHOOL });
    assertEquals(status, 200);
    assertEquals(out.dry_run, true);
    assertEquals(out.count, 2);
    assertEquals(out.records.map((r: { source_id: string }) => r.source_id), ["l-1", "l-2"]);
    assertEquals(out.records[0], {
      source_id: "l-1", external_id: T1, full_name: "Sketch Kamau", leave_type_name: "Imported from Schools",
      start_date: "2026-03-02", end_date: "2026-03-06", days: 5, status: "approved", reason: "Funeral",
    });
    assertEquals(out.not_linked, [{ external_id: NEW, full_name: "Nina New", source_id: "l-5" }]);
    assertEquals(hr.calls.length, 0);
    assertEquals(exported(db), []);
  });

  it("for real: sends them to HR's import (the school, no person), marks them exported; a second run sends nothing", async () => {
    const { call, hr, db } = setup();
    let r = await call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals(r.status, 200);
    assertEquals([r.out.sent, r.out.marked, r.out.refused_by_hr], [2, 2, []]);
    const sent = hr.calls[0]!;
    assertEquals([sent.method, sent.path, sent.school, sent.person], ["POST", "import/leave-history", SCHOOL, null]);
    // deno-lint-ignore no-explicit-any
    const body = sent.body as any;
    assertEquals(body.dry_run, false);
    assertEquals(body.records[1], { external_id: T2, leave_type_name: "Imported from Schools", start_date: "2026-05-14", end_date: "2026-05-14", days: 1, status: "approved", source_id: "l-2" });
    assertEquals(hr.imported.get("company")!.size, 2);
    assertEquals(exported(db), ["l-1", "l-2"]);
    assertEquals(db.rowsIn("audit_events").map((a) => a.event), ["2 leave records sent to Figbloom HR"]);

    r = await call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals([r.status, r.out.count, r.out.sent], [200, 0, 0]);
    assertEquals(hr.calls.length, 1);
  });

  it("a record HR skips (a person it doesn't have) is not marked, and is listed", async () => {
    const { call, hr, db } = setup();
    hr.people.delete(`company:${T2}`);
    const r = await call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals(r.out.refused_by_hr, [{ source_id: "l-2", reason: "unknown_person" }]);
    assertEquals(exported(db), ["l-1"]);
  });

  it("HR failing: 502, nothing marked, so the next run sends it all again (HR is idempotent on source_id)", async () => {
    const { call, hr, db } = setup();
    hr.down = 500;
    const r = await call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals([r.status, r.out.error.code], [502, "hr_error"]);
    assertEquals(exported(db), []);
  });

  it("needs a school id and a school Schools has; for real, the secrets and HR_MY_HR_URL, and a school the platform knows", async () => {
    let s = setup();
    assertEquals((await s.call({ action: "leave_history_import", school_id: "hillside" })).status, 400);
    assertEquals((await s.call({ action: "leave_history_import", school_id: UNKNOWN_SCHOOL })).status, 404);
    s = setup({ hrUrl: null });
    let r = await s.call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals([r.status, r.out.error.code], [503, "hr_not_configured"]);
    s = setup({ configured: false });
    r = await s.call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals(r.status, 503);
    s = setup({ linked: false });
    r = await s.call({ action: "leave_history_import", school_id: SCHOOL, dry_run: false });
    assertEquals([r.status, r.out.error.code], [409, "school_not_linked"]);
    assertEquals(s.hr.calls.length, 0);
    assertEquals(exported(s.db), []);
  });

  it("refuses a caller without the key", async () => {
    const { db, hr } = setup();
    const res = await handle(new Request("https://abc.supabase.co/functions/v1/platform-sync", {
      method: "POST", body: JSON.stringify({ action: "leave_history_import", school_id: SCHOOL, dry_run: false }),
    }), { admin: db, client: null, env: { get: () => undefined }, hrUrl: HR_BASE, fetch: hr.fetch });
    assertEquals(res.status, 401);
    assertEquals(hr.calls.length, 0);
  });
});
