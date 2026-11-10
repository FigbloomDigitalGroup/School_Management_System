import { describe, expect, it } from "vitest";
import { isNoSignalError, openSession, type OpenParts, type ProfileRead, type WhoIsSignedIn } from "./openSession";

// FIG-1487: opening the phone app with no signal showed the sign-in screen, so the saved fees and results could
// never be reached. "Cannot reach the server" is not "signed out".

type Session = { profileId: string; role: string };
type Extra = { mustChoosePassword: boolean };

const ann: Session = { profileId: "ann", role: "parent" };
const saved: Session = { profileId: "ann", role: "parent" };

/** Parts for a phone that is online and signed in as Ann, with `overrides` changing one answer. */
function setup(overrides: Partial<OpenParts<Session, Extra>> = {}) {
  const log: string[] = [];
  const store = new Map<string, Session>();
  const parts: OpenParts<Session, Extra> = {
    whoIsSignedIn: async () => { log.push("whoIsSignedIn"); return { id: "ann" }; },
    storedUserId: async () => { log.push("storedUserId"); return "ann"; },
    readProfile: async () => { log.push("readProfile"); return { session: ann, extra: { mustChoosePassword: false } }; },
    readSaved: async (id) => { log.push("readSaved"); return store.get(id) ?? null; },
    save: async (id, session) => { log.push("save"); store.set(id, session); },
    ...overrides,
  };
  return { parts, log, store };
}

const noSignal = async (): Promise<WhoIsSignedIn> => "no-signal";

describe("openSession: the server answers", () => {
  it("opens as the person and saves who they are for the next time there is no signal", async () => {
    const { parts, store } = setup();
    await expect(openSession(parts)).resolves.toEqual({ status: "online", session: ann, extra: { mustChoosePassword: false } });
    expect(store.get("ann")).toEqual(ann);
  });

  it("hands back what only a fresh read knows", async () => {
    const { parts } = setup({ readProfile: async () => ({ session: ann, extra: { mustChoosePassword: true } }) });
    await expect(openSession(parts)).resolves.toMatchObject({ status: "online", extra: { mustChoosePassword: true } });
  });

  it("is signed out when the server says nobody is, and reads nothing more", async () => {
    const { parts, log } = setup({ whoIsSignedIn: async () => "signed-out" });
    await expect(openSession(parts)).resolves.toEqual({ status: "signed-out" });
    expect(log).toEqual([]);
  });

  it("is signed out for a role the app has no home for, and saves nothing", async () => {
    const { parts, store } = setup({ readProfile: async () => "unsupported" });
    await expect(openSession(parts)).resolves.toEqual({ status: "signed-out" });
    expect(store.size).toBe(0);
  });

  it("still opens when saving the identity fails", async () => {
    const { parts } = setup({ save: async () => { throw new Error("disk full"); } });
    await expect(openSession(parts)).resolves.toMatchObject({ status: "online" });
  });
});

describe("openSession: the server cannot be reached", () => {
  it("opens from the saved identity instead of the sign-in screen", async () => {
    const { parts, store } = setup({ whoIsSignedIn: noSignal });
    store.set("ann", saved);
    await expect(openSession(parts)).resolves.toEqual({ status: "saved-copy", session: saved });
  });

  it("opens from the saved identity when the profile read fails after the login was confirmed", async () => {
    const { parts, store } = setup({ readProfile: async (): Promise<ProfileRead<Session, Extra>> => "no-signal" });
    store.set("ann", saved);
    await expect(openSession(parts)).resolves.toEqual({ status: "saved-copy", session: saved });
  });

  it("says there is no connection, not 'sign in', when the person is signed in but nothing was saved yet", async () => {
    const { parts } = setup({ whoIsSignedIn: noSignal });
    await expect(openSession(parts)).resolves.toEqual({ status: "no-signal" });
  });

  it("says the same when the saved identity cannot be read", async () => {
    const { parts } = setup({ whoIsSignedIn: noSignal, readSaved: async () => { throw new Error("corrupt"); } });
    await expect(openSession(parts)).resolves.toEqual({ status: "no-signal" });
  });

  it("is signed out when no login is stored on the phone, signal or not", async () => {
    const { parts, store } = setup({ whoIsSignedIn: noSignal, storedUserId: async () => null });
    store.set("ann", saved);
    await expect(openSession(parts)).resolves.toEqual({ status: "signed-out" });
  });

  it("treats a failure to ask as no signal, not as signed out", async () => {
    const { parts, store } = setup({ whoIsSignedIn: async () => { throw new TypeError("Network request failed"); } });
    store.set("ann", saved);
    await expect(openSession(parts)).resolves.toEqual({ status: "saved-copy", session: saved });
  });

  it("does not wait for ever for a server that never answers", async () => {
    const { parts, store } = setup({ whoIsSignedIn: () => new Promise<WhoIsSignedIn>(() => {}) });
    store.set("ann", saved);
    await expect(openSession(parts, { waitMs: 20 })).resolves.toEqual({ status: "saved-copy", session: saved });
  });

  it("does not wait for ever for a profile that never arrives", async () => {
    const { parts, store } = setup({ readProfile: () => new Promise<ProfileRead<Session, Extra>>(() => {}) });
    store.set("ann", saved);
    await expect(openSession(parts, { waitMs: 20 })).resolves.toEqual({ status: "saved-copy", session: saved });
  });

  it("uses the person the server confirmed, not whoever is stored, for the saved identity", async () => {
    const { parts, store } = setup({ readProfile: async () => "no-signal", storedUserId: async () => "ben" });
    store.set("ann", saved);
    store.set("ben", { profileId: "ben", role: "driver" });
    await expect(openSession(parts)).resolves.toEqual({ status: "saved-copy", session: saved });
  });
});

describe("isNoSignalError", () => {
  it("recognises the login library's no-network error and a status of 0", () => {
    expect(isNoSignalError({ name: "AuthRetryableFetchError", message: "Network request failed", status: 0 })).toBe(true);
    expect(isNoSignalError({ status: 0 })).toBe(true);
  });
  it("does not mistake an answer from the server for no signal", () => {
    expect(isNoSignalError({ name: "AuthSessionMissingError", message: "Auth session missing!" })).toBe(false);
    expect(isNoSignalError({ name: "AuthApiError", status: 401 })).toBe(false);
    expect(isNoSignalError(null)).toBe(false);
    expect(isNoSignalError(undefined)).toBe(false);
  });
});
