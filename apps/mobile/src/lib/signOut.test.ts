import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as shared from "@figbloom/shared";
import { forgetPushToken } from "../pushNotifications";
import { queue } from "../storage";
import { forgetCachedData, signOutOfThisPhone } from "./signOut";

// FIG-1489: signing out left the phone's notification token on the person's account, and their cached data and
// unsent writes on the phone.

jest.mock("../pushNotifications", () => ({ forgetPushToken: jest.fn() }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), supabase: jest.fn() }));

const forgetToken = forgetPushToken as unknown as jest.Mock;
const supabase = shared.supabase as unknown as jest.Mock;
const endLogin = jest.fn();

/** What the login library keeps on the phone for a signed-in person (it removes it when it signs them out). */
const LOGIN_KEY = "sb-127-auth-token";
const storeLogin = () => AsyncStorage.setItem(LOGIN_KEY, JSON.stringify({ access_token: "a.b.c", user: { id: "ann" } }));

/** What happened, in order, across the phone's token, the login and the phone's storage. */
let log: string[];

/** Everything stored except the write queue, which keeps its key (holding an empty list) and is checked through its own methods. */
async function storedKeys() {
  return [...(await AsyncStorage.getAllKeys())].filter((key) => key !== "figbloom.queue.v1").sort();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  log = [];
  await storeLogin();
  forgetToken.mockReset().mockImplementation(async () => { log.push("token removed"); });
  endLogin.mockReset().mockImplementation(async () => { log.push("login ended"); await AsyncStorage.removeItem(LOGIN_KEY); return { error: null }; });
  supabase.mockReset().mockReturnValue({ auth: { signOut: endLogin } });
  queue.setUser("ann");
});
afterEach(() => jest.restoreAllMocks());

/** Answers the "Not sent yet" question by pressing its button: 0 is "Stay signed in", 1 is "Sign out and lose them". */
const pressButton = (index: number) =>
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => { buttons?.[index]?.onPress?.(); });

/** The cached copies a signed-in family and learner leave behind, plus what must survive. */
async function seedPhone() {
  await AsyncStorage.multiSet([
    ["figbloom.parentData.v1.ann", "{\"children\":[\"Faith\",\"Samuel\"]}"],
    ["figbloom.parentData.v1.ben", "{}"],
    ["figbloom.studentData.v1.cy", "{}"],
    ["figbloom.session.v1.ann", "{\"role\":\"parent\"}"], // who the phone last opened as (FIG-1487)
    ["figbloom.themePref.v1", "dark"],
    ["figbloom.fingerprintUnlock.v1.ann", "on"],
    ["figbloom.routeTrace.v1.route-1", "[]"],
  ]);
}
const SURVIVORS = ["figbloom.fingerprintUnlock.v1.ann", "figbloom.routeTrace.v1.route-1", "figbloom.themePref.v1"];

describe("forgetCachedData", () => {
  it("deletes every parent and learner copy on the phone, whoever's, and nothing else", async () => {
    await seedPhone();
    await forgetCachedData();
    expect(await storedKeys()).toEqual([...SURVIVORS, LOGIN_KEY]);
  });
  it("is fine with nothing stored", async () => {
    await expect(forgetCachedData()).resolves.toBeUndefined();
  });
});

describe("signOutOfThisPhone", () => {
  it("removes the phone's token while the login still works, ends the login, and deletes the cached data", async () => {
    await seedPhone();
    const asked = jest.spyOn(Alert, "alert");
    await signOutOfThisPhone();
    expect(log).toEqual(["token removed", "login ended"]);
    expect(endLogin).toHaveBeenCalledWith({ scope: "local" });
    expect(await storedKeys()).toEqual(SURVIVORS);
    expect(asked).not.toHaveBeenCalled();
  });

  it("still signs out, and still deletes the data, when the token cannot be removed (no signal)", async () => {
    await seedPhone();
    forgetToken.mockRejectedValue(new Error("Network request failed"));
    await signOutOfThisPhone();
    expect(endLogin).toHaveBeenCalledTimes(1);
    expect(await storedKeys()).toEqual(SURVIVORS);
  });

  it("signs out when no login can be read, and still deletes the cached data", async () => {
    await seedPhone();
    await AsyncStorage.removeItem(LOGIN_KEY);
    await signOutOfThisPhone();
    expect(forgetToken).not.toHaveBeenCalled();
    expect(endLogin).toHaveBeenCalledTimes(1);
    expect(await storedKeys()).toEqual(SURVIVORS);
  });

  it("signs out with no signal and an expired access token, when the library fails and keeps the login", async () => {
    await seedPhone();
    await queue.enqueue("attendance", [{}]);
    forgetToken.mockRejectedValue(new Error("Network request failed"));
    // The library cannot refresh the expired token, answers with an error and leaves the login stored, the first time.
    endLogin.mockImplementationOnce(async () => ({ error: { name: "AuthRetryableFetchError", message: "Network request failed" } }));
    pressButton(1);

    await signOutOfThisPhone();

    expect(endLogin).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem(LOGIN_KEY)).toBeNull();
    expect(log).toEqual(["login ended"]);
    expect(await storedKeys()).toEqual(SURVIVORS);
    expect(await queue.unsentFor("ann")).toEqual([]);
  });

  it("reads who is signed in from the phone's storage, so a stalled token refresh cannot hold the sign-out up", async () => {
    await seedPhone();
    await queue.enqueue("attendance", [{}]);
    // Nothing to ask the library: if it were asked, it would never answer.
    supabase.mockReturnValue({ auth: { signOut: endLogin, getSession: () => new Promise(() => {}) } });
    pressButton(1);

    await signOutOfThisPhone();

    expect(endLogin).toHaveBeenCalledTimes(1);
    expect(await queue.unsentFor("ann")).toEqual([]);
  });

  describe("with writes that could not be sent", () => {
    async function queueTwoForAnnAndOneForBen() {
      await queue.enqueue("attendance", [{}]);
      await queue.enqueue("marks", [{}]);
      queue.setUser("ben");
      await queue.enqueue("announcements", [{}]);
      queue.setUser("ann");
    }
    it("asks first, in plain words, and changes nothing while the person stays signed in", async () => {
      await seedPhone();
      await queueTwoForAnnAndOneForBen();
      const asked = pressButton(0);

      await signOutOfThisPhone();

      expect(asked).toHaveBeenCalledTimes(1);
      expect(asked.mock.calls[0]![0]).toBe("Not sent yet");
      expect(String(asked.mock.calls[0]![1])).toMatch(/2 items saved on this phone have not reached the school yet/);
      expect(forgetToken).not.toHaveBeenCalled();
      expect(endLogin).not.toHaveBeenCalled();
      expect(await storedKeys()).toContain("figbloom.parentData.v1.ann");
      expect(await queue.unsentFor("ann")).toHaveLength(2);
    });

    it("treats closing the question as staying signed in", async () => {
      await queueTwoForAnnAndOneForBen();
      jest.spyOn(Alert, "alert").mockImplementation((_t, _m, _b, options) => { options?.onDismiss?.(); });
      await signOutOfThisPhone();
      expect(endLogin).not.toHaveBeenCalled();
    });

    it("signs out and deletes this person's writes, and only theirs, when they choose to lose them", async () => {
      await seedPhone();
      await queueTwoForAnnAndOneForBen();
      pressButton(1);

      await signOutOfThisPhone();

      expect(log).toEqual(["token removed", "login ended"]);
      expect(await storedKeys()).toEqual(SURVIVORS);
      expect(await queue.unsentFor("ann")).toEqual([]);
      expect((await queue.unsentFor("ben")).map((w) => w.table)).toEqual(["announcements"]);
    });
  });
});
