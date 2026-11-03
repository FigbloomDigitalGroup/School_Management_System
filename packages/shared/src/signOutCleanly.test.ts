import { describe, expect, it } from "vitest";
import { WriteError, WriteQueue, type QueuedWrite } from "./queue";
import { endLoginEvenOffline, isStoredLoginKey, signOutCleanly, unsentWarning, userIdFromStoredLogin, type SignOutParts } from "./signOut";

// FIG-1489: signing out left the phone's notification token on the person's account, and their cached data and
// unsent writes on the phone.

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

/** Parts that write each call into `log`, on top of a real queue. `overrides` change one step. */
function setup(overrides: Partial<SignOutParts> = {}, flushFn: (w: QueuedWrite) => Promise<void> = async () => {}) {
  const log: string[] = [];
  const store = memoryStore();
  const queue = new WriteQueue(store, flushFn);
  const watched = {
    flush: () => { log.push("flush"); return queue.flush(); },
    unsentFor: (id: string) => { log.push("unsentFor"); return queue.unsentFor(id); },
    forgetUser: (id: string) => { log.push("forgetUser"); return queue.forgetUser(id); },
  };
  const parts: SignOutParts = {
    userId: async () => "ann",
    queue: watched,
    forgetDevice: async () => { log.push("forgetDevice"); },
    forgetCachedData: async () => { log.push("forgetCachedData"); },
    endSession: async () => { log.push("endSession"); },
    ...overrides,
  };
  return { parts, log, queue, store };
}

const asAnn = (queue: WriteQueue) => { queue.setUser("ann"); return queue; };

describe("signOutCleanly", () => {
  it("removes the phone's token while the login still works, ends the login, then deletes the stored data", async () => {
    const { parts, log } = setup();
    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    expect(log).toEqual(["flush", "unsentFor", "forgetDevice", "endSession", "forgetCachedData", "forgetUser"]);
  });

  it("deletes this person's queued writes and nobody else's", async () => {
    const noSignal = async () => { throw new Error("Failed to fetch"); };
    const { parts, store } = setup({}, noSignal);
    const queueOf = (user?: string) => { const q = new WriteQueue(store, noSignal); if (user) q.setUser(user); return q; };
    await queueOf("ann").enqueue("attendance", [{}]);
    await queueOf("ben").enqueue("marks", [{}]);
    // A write from before owners were recorded: nobody can say whose it is, so it stays.
    await queueOf().enqueue("announcements", [{}]);

    await expect(signOutCleanly(parts, { discardUnsent: true })).resolves.toEqual({ done: true });

    expect((await queueOf("ann").pending()).map((w) => w.table)).toEqual(["announcements"]);
    expect((await queueOf("ben").pending()).map((w) => w.table)).toEqual(["marks", "announcements"]);
  });

  it("sends what is waiting first, so a person with signal loses nothing", async () => {
    const sent: string[] = [];
    const { parts, queue, log } = setup({}, async (w) => { sent.push(w.table); });
    await asAnn(queue).enqueue("attendance", [{}]);
    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    expect(sent).toEqual(["attendance"]);
    expect(log).toContain("endSession");
  });

  it("stops and says how many are unsent, touching nothing, when they cannot be sent", async () => {
    const { parts, queue, log } = setup({}, async () => { throw new Error("Failed to fetch"); });
    await asAnn(queue).enqueue("attendance", [{}]);
    await asAnn(queue).enqueue("marks", [{}]);

    await expect(signOutCleanly(parts)).resolves.toEqual({ done: false, unsent: 2 });
    expect(log).toEqual(["flush", "unsentFor"]);
    expect(await queue.unsentFor("ann")).toHaveLength(2);
  });

  it("goes ahead when the person chose to lose the unsent writes", async () => {
    const { parts, queue, log } = setup({}, async () => { throw new Error("Failed to fetch"); });
    await asAnn(queue).enqueue("attendance", [{}]);

    await expect(signOutCleanly(parts, { discardUnsent: true })).resolves.toEqual({ done: true });
    expect(log).toContain("forgetDevice");
    expect(log).toContain("endSession");
    expect(await queue.unsentFor("ann")).toEqual([]);
  });

  it("does not count what the server refused for good as unsent, and deletes it", async () => {
    const { parts, queue } = setup({}, async () => { throw new WriteError("not allowed", false, 403); });
    await asAnn(queue).enqueue("marks", [{}]);

    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    queue.setUser("ann");
    expect(await queue.rejected()).toEqual([]);
  });

  it("still signs out when the token cannot be removed (no signal)", async () => {
    const { parts, log } = setup({ forgetDevice: async () => { throw new Error("Network request failed"); } });
    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    expect(log).toContain("endSession");
    expect(log).toContain("forgetCachedData");
  });

  it("still signs out when removing the token never answers", async () => {
    const { parts, log } = setup({ forgetDevice: () => new Promise<void>(() => {}) });
    await expect(signOutCleanly(parts, { stepMs: 20 })).resolves.toEqual({ done: true });
    expect(log).toContain("endSession");
  });

  it("still deletes the cached data when deleting the queued writes fails", async () => {
    const { parts, log } = setup();
    parts.queue = { ...parts.queue, forgetUser: async () => { throw new Error("disk full"); } };
    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    expect(log).toContain("forgetCachedData");
  });

  it("with nobody known to be signed in, just ends the login and deletes the cached data", async () => {
    const { parts, log } = setup({ userId: async () => null });
    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    expect(log).toEqual(["endSession", "forgetCachedData"]);
  });

  it("with a stored login that cannot be read, does the same instead of failing", async () => {
    const { parts, log } = setup({ userId: async () => { throw new Error("storage"); } });
    await expect(signOutCleanly(parts)).resolves.toEqual({ done: true });
    expect(log).toEqual(["endSession", "forgetCachedData"]);
  });

  it("does not hide a failure to end the login", async () => {
    const { parts, log } = setup({ endSession: async () => { throw new Error("auth is down"); } });
    await expect(signOutCleanly(parts)).rejects.toThrow("auth is down");
    expect(log).not.toContain("forgetCachedData");
  });
});

describe("isStoredLoginKey", () => {
  it("matches where the login library keeps the session, for any project, and its code verifier", () => {
    for (const key of ["sb-127-auth-token", "sb-abcdefghij-auth-token", "sb-abcdefghij-auth-token-code-verifier"]) expect(isStoredLoginKey(key)).toBe(true);
  });
  it("leaves every other key of the app alone", () => {
    for (const key of ["figbloom.queue.v1", "figbloom.parentData.v1.ann", "figbloom.themePref.v1", "sb-127-other", "auth-token", "xsb-127-auth-token"]) expect(isStoredLoginKey(key)).toBe(false);
  });
});

describe("userIdFromStoredLogin", () => {
  it("reads who is signed in from the stored session, with no network", () => {
    expect(userIdFromStoredLogin(JSON.stringify({ access_token: "a.b.c", user: { id: "ann", email: "ann@x" } }))).toBe("ann");
  });
  it("is null for nothing stored, for text that is not a session, and for a session without a person", () => {
    for (const raw of [null, "", "not json", "null", "[]", "{}", JSON.stringify({ user: {} }), JSON.stringify({ user: { id: 7 } })]) expect(userIdFromStoredLogin(raw)).toBeNull();
  });
});

describe("endLoginEvenOffline", () => {
  it("is done after one sign-out when the library ends the login", async () => {
    const calls: string[] = [];
    await endLoginEvenOffline({
      signOut: async () => { calls.push("signOut"); return { error: null }; },
      removeStoredLogin: async () => { calls.push("removeStoredLogin"); },
    });
    expect(calls).toEqual(["signOut"]);
  });

  it("deletes the stored login by hand and asks again when the library fails and keeps it (expired access token, no signal)", async () => {
    const calls: string[] = [];
    let stored = true;
    await endLoginEvenOffline({
      signOut: async () => {
        calls.push(stored ? "signOut (login still stored)" : "signOut (nothing stored)");
        return { error: stored ? { name: "AuthRetryableFetchError", message: "Network request failed" } : null };
      },
      removeStoredLogin: async () => { calls.push("removeStoredLogin"); stored = false; },
    });
    expect(calls).toEqual(["signOut (login still stored)", "removeStoredLogin", "signOut (nothing stored)"]);
  });

  it("raises the error when the stored login cannot be deleted, instead of pretending to have signed out", async () => {
    await expect(endLoginEvenOffline({
      signOut: async () => ({ error: new Error("no signal") }),
      removeStoredLogin: async () => { throw new Error("storage unavailable"); },
    })).rejects.toThrow("storage unavailable");
  });
});

describe("unsentWarning", () => {
  it("says it in the singular for one item", () => {
    const w = unsentWarning(1);
    expect(w.message).toBe("1 item saved on this phone has not reached the school yet. If you sign out now, it will be lost. Stay signed in and connect to the internet so it can be sent.");
    expect(w.leave).toBe("Sign out and lose it");
  });
  it("says it in the plural otherwise", () => {
    const w = unsentWarning(3);
    expect(w.message).toBe("3 items saved on this phone have not reached the school yet. If you sign out now, they will be lost. Stay signed in and connect to the internet so they can be sent.");
    expect(w.leave).toBe("Sign out and lose them");
    expect(w.stay).toBe("Stay signed in");
  });
});
