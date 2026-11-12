import { describe, expect, it } from "vitest";
import { CALL_RING_SECONDS, callDuration, callOutcome, filterCallsByName, isRingExpired, liveClassNotice, liveClassSubtitle, liveClassTitle, otherParty, ringLeftMs } from "./calls";

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

describe("callOutcome", () => {
  const created_at = "2026-10-27T08:00:00Z";
  it("says answered, in progress, missed and declined in words, with a tone for each", () => {
    expect(callOutcome({ status: "ended", created_at })).toEqual({ label: "Answered", tone: "ok" });
    expect(callOutcome({ status: "accepted", created_at })).toEqual({ label: "In progress", tone: "info" });
    expect(callOutcome({ status: "missed", created_at })).toEqual({ label: "Missed", tone: "warn" });
    expect(callOutcome({ status: "declined", created_at })).toEqual({ label: "Declined", tone: "muted" });
  });
  it("says ringing while it rings, and missed once it stopped ringing and nobody closed it", () => {
    expect(callOutcome({ status: "ringing", created_at }, at("2026-10-27T08:00:10Z"))).toEqual({ label: "Ringing", tone: "info" });
    expect(callOutcome({ status: "ringing", created_at }, at("2026-10-27T08:05:00Z"))).toEqual({ label: "Missed", tone: "warn" });
  });
});

describe("filterCallsByName", () => {
  const calls = [
    { caller_name: "Mary Otieno", callee_name: "Ann Wanjiru" },
    { caller_name: "Ann Wanjiru", callee_name: "Joel Kamau" },
    { caller_name: "Ruth Njeri", callee_name: "Peter Mwangi" },
  ];
  it("finds the calls a person made or took, by any part of their name, in any case", () => {
    expect(filterCallsByName(calls, "ANN")).toHaveLength(2);
    expect(filterCallsByName(calls, " peter ")).toEqual([calls[2]]);
    expect(filterCallsByName(calls, "nobody")).toEqual([]);
  });
  it("lists every call when the filter is blank", () => {
    expect(filterCallsByName(calls, "")).toHaveLength(3);
  });
});

describe("ringLeftMs", () => {
  const call = { created_at: "2026-10-27T08:00:00Z" };

  it("counts down the ring, and is zero once it is over", () => {
    expect(ringLeftMs(call, at("2026-10-27T08:00:00Z"))).toBe(CALL_RING_SECONDS * 1000);
    expect(ringLeftMs(call, at("2026-10-27T08:00:15Z"))).toBe((CALL_RING_SECONDS - 15) * 1000);
    expect(ringLeftMs(call, at("2026-10-27T08:05:00Z"))).toBe(0);
  });
});

describe("live class room words", () => {
  it("tells a learner why their mic is off, a parent that they are watching, and says nothing to the teacher", () => {
    expect(liveClassNotice("learner", false)).toMatch(/until the teacher lets learners speak/);
    expect(liveClassNotice("learner", true)).toBeNull();
    expect(liveClassNotice("family", false)).toMatch(/You're watching/);
    expect(liveClassNotice("family", true)).toMatch(/You're watching/);
    expect(liveClassNotice("host", false)).toBeNull();
  });

  it("calls the teacher's room the one they teach", () => {
    expect(liveClassSubtitle("host")).toBe("You're teaching this live class");
    expect(liveClassSubtitle("learner")).toBe("Live class");
    expect(liveClassSubtitle("family")).toBe("Live class");
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
