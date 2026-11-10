import AsyncStorage from "@react-native-async-storage/async-storage";
import { readSavedSession, saveSession, type AppSession } from "./savedSession";

// FIG-1487: who the phone last opened as, saved so the app can open with no signal.

const parent: AppSession = { role: "parent", accent: "#7A1F2B", profileId: "ann", country: "KE", tenantId: "school-1" };
const KEY = "figbloom.session.v1.ann";

beforeEach(() => AsyncStorage.clear());

describe("saved session", () => {
  it("is read back as it was saved, under the person's own key", async () => {
    await saveSession("ann", parent);
    expect(await AsyncStorage.getAllKeys()).toEqual([KEY]);
    await expect(readSavedSession("ann")).resolves.toEqual(parent);
  });

  it("is nothing for someone who has none", async () => {
    await expect(readSavedSession("ben")).resolves.toBeNull();
  });

  it("is never someone else's: an entry whose profile does not match the key is refused", async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...parent, profileId: "ben" }));
    await expect(readSavedSession("ann")).resolves.toBeNull();
  });

  it("is refused when it is not whole, or not an identity the app understands", async () => {
    for (const broken of [
      "not json", "null", "[]", "{}",
      JSON.stringify({ ...parent, tenantId: "" }),
      JSON.stringify({ ...parent, accent: undefined }),
      JSON.stringify({ ...parent, country: undefined }),
      JSON.stringify({ ...parent, role: "school_admin" }),
      JSON.stringify({ role: "driver", accent: "#7A1F2B", profileId: "ann", tenantId: "school-1" }), // a driver needs a name
      JSON.stringify({ ...parent, role: "teacher" }), // staff are never saved: their screens are live data (lib/staffSession.ts)
      JSON.stringify({ role: "teacher", accent: "#7A1F2B", profileId: "ann", tenantId: "school-1", fullName: "Ann Wanjiru", country: "KE" }),
    ]) {
      await AsyncStorage.setItem(KEY, broken);
      await expect(readSavedSession("ann")).resolves.toBeNull();
    }
  });

  it("accepts a whole driver identity", async () => {
    const driver: AppSession = { role: "driver", accent: "#7A1F2B", profileId: "ann", tenantId: "school-1", fullName: "James Kariuki" };
    await saveSession("ann", driver);
    await expect(readSavedSession("ann")).resolves.toEqual(driver);
  });
});
