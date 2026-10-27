import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const invoke = vi.fn(() => Promise.resolve({ data: null, error: null }));
vi.mock("./supabase", () => ({
  supabase: () => ({ from: () => ({ upsert }), functions: { invoke } }),
}));

import { markRider } from "./fleet";
import { isRetryable, WriteError } from "./queue";

const input = { tenantId: "t1", tripId: "trip1", studentId: "s1", stopId: "stop1", status: "boarded" as const, markedAt: "2026-10-27T07:00:00.000Z" };

// braces matter: a function returned from beforeEach is run as cleanup, and mockReset() returns the mock
beforeEach(() => { upsert.mockReset(); invoke.mockClear(); });

describe("markRider", () => {
  it("upserts the mark on its natural key and asks for the family's update to be pushed", async () => {
    upsert.mockResolvedValue({ error: null, status: 201 });
    await markRider(input);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ trip_id: "trip1", student_id: "s1", status: "boarded", boarded_at: input.markedAt }),
      { onConflict: "trip_id,student_id" },
    );
    expect(invoke).toHaveBeenCalledWith("rider-update", { body: { trip_id: "trip1" } });
  });

  it("reports no answer at all as retryable, so the mark can be held on the phone", async () => {
    upsert.mockResolvedValue({ error: { message: "TypeError: Network request failed" }, status: 0 });
    const err = await markRider(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(isRetryable(err)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a server in trouble as retryable", async () => {
    upsert.mockResolvedValue({ error: { message: "upstream" }, status: 503 });
    expect(isRetryable(await markRider(input).catch((e: unknown) => e))).toBe(true);
  });

  it("reports the server's refusal as not retryable, with its own message", async () => {
    upsert.mockResolvedValue({ error: { message: "new row violates row-level security policy" }, status: 403 });
    const err = await markRider(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("new row violates row-level security policy");
    expect(isRetryable(err)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
