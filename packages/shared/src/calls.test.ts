import { describe, expect, it } from "vitest";
import { CALL_RING_SECONDS, callDuration, isRingExpired, liveClassTitle, otherParty } from "./calls";

const at = (iso: string) => new Date(iso);

describe("isRingExpired", () => {
  it("lets a call ring for CALL_RING_SECONDS, then counts it missed", () => {
    const call = { status: "ringing" as const, created_at: "2026-10-27T08:00:00Z" };
    expect(isRingExpired(call, at("2026-10-27T08:00:30Z"))).toBe(false);
    expect(isRingExpired(call, new Date(at("2026-10-27T08:00:00Z").getTime() + (CALL_RING_SECONDS + 1) * 1000))).toBe(true);
  });

  it("never expires a call that was answered", () => {
    expect(isRingExpired({ status: "accepted", created_at: "2026-10-27T08:00:00Z" }, at("2026-10-27T09:00:00Z"))).toBe(false);
  });
});

describe("callDuration", () => {
  it("is null for a call nobody answered", () => {
    expect(callDuration({ answered_at: null, ended_at: "2026-10-27T08:01:00Z" })).toBeNull();
  });

  it("reads m:ss, and h:mm:ss past the hour", () => {
    expect(callDuration({ answered_at: "2026-10-27T08:00:00Z", ended_at: "2026-10-27T08:04:07Z" })).toBe("4:07");
    expect(callDuration({ answered_at: "2026-10-27T08:00:00Z", ended_at: "2026-10-27T09:02:30Z" })).toBe("1:02:30");
  });

  it("counts up to now while the call is still on", () => {
    expect(callDuration({ answered_at: "2026-10-27T08:00:00Z", ended_at: null }, at("2026-10-27T08:00:09Z"))).toBe("0:09");
  });
});

describe("names", () => {
  it("shows the other person from either side of the call", () => {
    const call = { caller_id: "p1", caller_name: "Peter Otieno", callee_name: "Grace Wanjiru" };
    expect(otherParty(call, "p1")).toBe("Grace Wanjiru");
    expect(otherParty(call, "t1")).toBe("Peter Otieno");
  });

  it("titles a live class by class and subject", () => {
    expect(liveClassTitle("Form 2 East", "Mathematics")).toBe("Form 2 East · Mathematics");
    expect(liveClassTitle("Form 2 East", null)).toBe("Form 2 East");
  });
});
