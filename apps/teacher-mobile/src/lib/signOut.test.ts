import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as shared from "@figbloom/shared";
import { forgetPushToken } from "../pushNotifications";
import { queue } from "../storage";
import { signOutOfThisPhone } from "./signOut";

// FIG-1489: signing out left the phone's notification token on the teacher's account, and their unsent registers
// and marks on the phone.

jest.mock("../pushNotifications", () => ({ forgetPushToken: jest.fn() }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), supabase: jest.fn() }));

const forgetToken = forgetPushToken as unknown as jest.Mock;
const supabase = shared.supabase as unknown as jest.Mock;
const endLogin = jest.fn();

/** What the login library keeps on the phone for a signed-in person (it removes it when it signs them out). */
const LOGIN_KEY = "sb-127-auth-token";
const storeLogin = () => AsyncStorage.setItem(LOGIN_KEY, JSON.stringify({ access_token: "a.b.c", user: { id: "ann" } }));

/** What happened, in order, across the phone's token and the login. */
let log: string[];

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

const pressButton = (index: number) =>
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => { buttons?.[index]?.onPress?.(); });

async function queueTwoForAnnAndOneForBen() {
  await queue.enqueue("attendance", [{}]);
  await queue.enqueue("marks", [{}]);
  queue.setUser("ben");
  await queue.enqueue("announcements", [{}]);
  queue.setUser("ann");
}

describe("signOutOfThisPhone (teacher app)", () => {
  it("removes the phone's token while the login still works, then ends the login", async () => {
    const asked = jest.spyOn(Alert, "alert");
    await signOutOfThisPhone();
    expect(log).toEqual(["token removed", "login ended"]);
    expect(endLogin).toHaveBeenCalledWith({ scope: "local" });
    expect(asked).not.toHaveBeenCalled();
  });

  it("still signs out when the token cannot be removed (no signal)", async () => {
    forgetToken.mockRejectedValue(new Error("Network request failed"));
    await signOutOfThisPhone();
    expect(endLogin).toHaveBeenCalledTimes(1);
  });

  it("signs out with no signal and an expired access token, when the library fails and keeps the login", async () => {
    await queue.enqueue("attendance", [{}]);
    forgetToken.mockRejectedValue(new Error("Network request failed"));
    // The library cannot refresh the expired token, answers with an error and leaves the login stored, the first time.
    endLogin.mockImplementationOnce(async () => ({ error: { name: "AuthRetryableFetchError", message: "Network request failed" } }));
    pressButton(1);

    await signOutOfThisPhone();

    expect(endLogin).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem(LOGIN_KEY)).toBeNull();
    expect(await queue.unsentFor("ann")).toEqual([]);
  });

  it("asks before throwing away a register or marks that could not be sent, and changes nothing while the teacher stays", async () => {
    await queueTwoForAnnAndOneForBen();
    const asked = pressButton(0);

    await signOutOfThisPhone();

    expect(asked).toHaveBeenCalledTimes(1);
    expect(String(asked.mock.calls[0]![1])).toMatch(/2 items saved on this phone have not reached the school yet/);
    expect(forgetToken).not.toHaveBeenCalled();
    expect(endLogin).not.toHaveBeenCalled();
    expect(await queue.unsentFor("ann")).toHaveLength(2);
  });

  it("signs out and deletes this teacher's writes, and only theirs, when they choose to lose them", async () => {
    await queueTwoForAnnAndOneForBen();
    pressButton(1);

    await signOutOfThisPhone();

    expect(log).toEqual(["token removed", "login ended"]);
    expect(await queue.unsentFor("ann")).toEqual([]);
    expect((await queue.unsentFor("ben")).map((w) => w.table)).toEqual(["announcements"]);
  });
});
