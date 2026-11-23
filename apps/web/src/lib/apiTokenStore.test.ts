import { afterEach, describe, expect, it, vi } from "vitest";
import { API_SESSION_KEY, createWebTokenStore } from "./apiTokenStore";

const S = { token: "tok", expiresAt: "2099-01-01T00:00:00.000Z", userId: "u1" };

/** A window with a localStorage that can be made to throw, and the `storage` event another tab would cause. */
function fakeWindow(opts: { throws?: boolean } = {}) {
  const data = new Map<string, string>();
  const handlers: ((e: { key: string | null }) => void)[] = [];
  const localStorage = {
    getItem: (k: string) => { if (opts.throws) throw new Error("blocked"); return data.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (opts.throws) throw new Error("blocked"); data.set(k, v); },
    removeItem: (k: string) => { if (opts.throws) throw new Error("blocked"); data.delete(k); },
  };
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: (type: string, h: (e: { key: string | null }) => void) => { if (type === "storage") handlers.push(h); },
  });
  return { data, otherTab: (key: string | null) => handlers.forEach((h) => h({ key })) };
}

afterEach(() => vi.unstubAllGlobals());

describe("the web token store", () => {
  it("keeps the session in localStorage under one key", () => {
    const w = fakeWindow();
    const store = createWebTokenStore();
    expect(store.get()).toBeNull();
    store.set(S);
    expect(JSON.parse(w.data.get(API_SESSION_KEY)!)).toEqual(S);
    expect(store.get()).toEqual(S);
    store.clear();
    expect(w.data.has(API_SESSION_KEY)).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("reads what an earlier page load stored", () => {
    const w = fakeWindow();
    w.data.set(API_SESSION_KEY, JSON.stringify(S));
    expect(createWebTokenStore().get()).toEqual(S);
  });

  it("treats a value it cannot read as no session", () => {
    const w = fakeWindow();
    for (const junk of ["not json", "{}", JSON.stringify({ token: 5 }), "null", JSON.stringify({ token: "t", expiresAt: "never" })]) {
      w.data.set(API_SESSION_KEY, junk);
      expect(createWebTokenStore().get()).toBeNull();
    }
  });

  it("tells its listeners on set and clear, and not on a clear of nothing", () => {
    fakeWindow();
    const store = createWebTokenStore();
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

  it("tells its listeners when another tab signs in or out", () => {
    const w = fakeWindow();
    const store = createWebTokenStore();
    const l = vi.fn();
    store.subscribe(l);
    w.data.set(API_SESSION_KEY, JSON.stringify(S));
    w.otherTab(API_SESSION_KEY);
    expect(l).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(S);
    w.otherTab(null); // localStorage.clear() in the other tab
    expect(l).toHaveBeenCalledTimes(2);
    w.otherTab("some.other.key");
    expect(l).toHaveBeenCalledTimes(2);
  });

  it("falls back to this page's memory when storage is blocked, and still works", () => {
    fakeWindow({ throws: true });
    const store = createWebTokenStore();
    const l = vi.fn();
    store.subscribe(l);
    expect(store.get()).toBeNull();
    store.set(S);
    expect(store.get()).toEqual(S);
    store.clear();
    expect(store.get()).toBeNull();
    expect(l).toHaveBeenCalledTimes(2);
  });
});
