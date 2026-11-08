import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIG-1514: saving the attendance settings reports success only when the database holds what was asked for (run 4: a screen must
 * never say "saved" for a setting that is not stored). The Supabase client is mocked: these tests pin what saveAttendanceSettings()
 * sends and how it treats the answer; the RLS rule itself is checked in supabase/rls-checks/afternoon_attendance.sql.
 */
type Answer = { data: unknown; error: { message: string } | null };
let answer: Answer = { data: null, error: null };
const calls: { method: string; args: unknown[] }[] = [];

function builder() {
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return undefined;
      if (method === "maybeSingle" || method === "single") return () => { calls.push({ method, args: [] }); return Promise.resolve(answer); };
      return (...args: unknown[]) => { calls.push({ method, args }); return proxy; };
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({ supabase: () => ({ from: (table: string) => { calls.push({ method: "from", args: [table] }); return builder(); } }) }));

import { saveAttendanceSettings } from "./attendanceSession";

beforeEach(() => { calls.length = 0; });

describe("saveAttendanceSettings", () => {
  it("upserts the school's row on tenant_id, reads it back, and returns what is stored", async () => {
    answer = { data: { afternoon_enabled: false, percentage_mode: "session" }, error: null };
    await expect(saveAttendanceSettings("t1", { afternoon_enabled: false, percentage_mode: "session" }))
      .resolves.toEqual({ afternoon_enabled: false, percentage_mode: "session" });
    expect(calls).toContainEqual({ method: "from", args: ["attendance_settings"] });
    expect(calls).toContainEqual({
      method: "upsert",
      args: [{ tenant_id: "t1", afternoon_enabled: false, percentage_mode: "session" }, { onConflict: "tenant_id" }],
    });
    expect(calls).toContainEqual({ method: "select", args: ["afternoon_enabled, percentage_mode"] });
  });

  it("turning the afternoon off sends false, not a missing field (an upsert would otherwise keep true)", async () => {
    answer = { data: { afternoon_enabled: false, percentage_mode: "day" }, error: null };
    await saveAttendanceSettings("t1", { afternoon_enabled: false, percentage_mode: "day" });
    const up = calls.find((c) => c.method === "upsert")!;
    expect((up.args[0] as Record<string, unknown>).afternoon_enabled).toBe(false);
  });

  it("a refusal from the database throws with its words (the panel shows them, not 'saved')", async () => {
    answer = { data: null, error: { message: 'new row violates row-level security policy for table "attendance_settings"' } };
    await expect(saveAttendanceSettings("t1", { afternoon_enabled: false, percentage_mode: "session" }))
      .rejects.toThrow(/row-level security/);
  });

  it("no row back (nothing was written) throws", async () => {
    answer = { data: null, error: null };
    await expect(saveAttendanceSettings("t1", { afternoon_enabled: false, percentage_mode: "session" }))
      .rejects.toThrow("The settings were not saved");
  });

  it("a stored row that differs from what was asked throws", async () => {
    answer = { data: { afternoon_enabled: true, percentage_mode: "session" }, error: null };
    await expect(saveAttendanceSettings("t1", { afternoon_enabled: false, percentage_mode: "session" }))
      .rejects.toThrow("The settings were not saved");
  });
});
