import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { FakeSupabaseClient } from "./fakeSupabase.ts";
import { formatLoginId, nextLoginId } from "./loginId.ts";

const TENANT = "tenant-1";

function clientWith(profiles: Record<string, unknown>[]) {
  const admin = new FakeSupabaseClient();
  admin.seed("profiles", profiles);
  return admin;
}

describe("nextLoginId", () => {
  it("is 0001 for a role with no accounts yet", async () => {
    assertEquals(await nextLoginId(clientWith([]), TENANT, "teacher"), "TC-0001");
  });

  it("is one past the highest number, even with gaps from deleted accounts", async () => {
    const admin = clientWith([
      { tenant_id: TENANT, role: "teacher", login_id: "TC-0001" },
      { tenant_id: TENANT, role: "teacher", login_id: "TC-0006" },
    ]);
    assertEquals(await nextLoginId(admin, TENANT, "teacher"), "TC-0007");
  });

  it("goes past four digits without padding trouble", async () => {
    const admin = clientWith([{ tenant_id: TENANT, role: "student", login_id: "ST-9999" }]);
    assertEquals(await nextLoginId(admin, TENANT, "student"), "ST-10000");
  });

  it("only looks at this school and this role", async () => {
    const admin = clientWith([
      { tenant_id: "tenant-2", role: "teacher", login_id: "TC-0050" },
      { tenant_id: TENANT, role: "parent", login_id: "PT-0040" },
      { tenant_id: TENANT, role: "teacher", login_id: "TC-0002" },
    ]);
    assertEquals(await nextLoginId(admin, TENANT, "teacher"), "TC-0003");
  });

  it("ignores accounts that have no login ID (email sign-in roles)", async () => {
    const admin = clientWith([{ tenant_id: TENANT, role: "teacher", login_id: null }]);
    assertEquals(await nextLoginId(admin, TENANT, "teacher"), "TC-0001");
  });

  it("throws, rather than guessing, when the lookup fails", async () => {
    const admin = clientWith([]);
    admin.failNextRpc("database unavailable");
    await assertRejects(() => nextLoginId(admin, TENANT, "teacher"), Error, "database unavailable");
  });

  it("throws for a role that has no ID prefix", async () => {
    await assertRejects(() => nextLoginId(clientWith([]), TENANT, "super_admin"), Error, "No login ID prefix");
  });
});

describe("formatLoginId", () => {
  it("zero-pads to four digits and keeps longer numbers whole", () => {
    assertEquals(formatLoginId("PT", 29), "PT-0029");
    assertEquals(formatLoginId("PT", 12345), "PT-12345");
  });
});
