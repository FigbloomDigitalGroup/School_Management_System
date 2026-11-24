import { describe, expect, it, vi } from "vitest";
import { createMemoryTokenStore, isStoredSession } from "./tokenStore";

const S = { token: "t", expiresAt: "2099-01-01T00:00:00Z" };

describe("createMemoryTokenStore", () => {
  it("keeps what it is given, and forgets on clear", () => {
    const store = createMemoryTokenStore();
    expect(store.get()).toBeNull();
    store.set(S);
    expect(store.get()).toEqual(S);
    store.clear();
    expect(store.get()).toBeNull();
  });
  it("tells listeners on set and on clear, not on a clear of nothing", () => {
    const store = createMemoryTokenStore();
    const l = vi.fn();
    const stop = store.subscribe(l);
    store.clear();
    expect(l).not.toHaveBeenCalled();
    store.set(S);
    store.clear();
    expect(l).toHaveBeenCalledTimes(2);
    stop();
    store.set(S);
    expect(l).toHaveBeenCalledTimes(2);
  });
});

describe("isStoredSession", () => {
  it("accepts a token with a date, with or without a user id", () => {
    expect(isStoredSession(S)).toBe(true);
    expect(isStoredSession({ ...S, userId: "u" })).toBe(true);
  });
  it("refuses anything else", () => {
    for (const v of [null, undefined, "x", 1, {}, { token: "" , expiresAt: S.expiresAt }, { token: "t" }, { token: "t", expiresAt: "soon" }, { ...S, userId: 5 }]) {
      expect(isStoredSession(v)).toBe(false);
    }
  });
});
