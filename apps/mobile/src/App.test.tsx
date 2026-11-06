import { Text as MockText } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as shared from "@figbloom/shared";
import App from "../App";
import { NO_CONNECTION_TITLE, SAVED_COPY_MESSAGE, TRY_AGAIN } from "./components/OfflineNotice";

// FIG-1487: opening the app with no signal showed the sign-in screen, so the saved fees and results could never be
// reached. "Cannot reach the server" is not "signed out".

// Everything the App renders around the sign-in decision is replaced by a marker: what is tested is which one shows.
jest.mock("react-native-safe-area-context", () => ({ SafeAreaProvider: ({ children }: { children: unknown }) => children }));
jest.mock("./lib/client", () => ({}));
jest.mock("./lib/signOut", () => ({ signOutOfThisPhone: jest.fn(() => Promise.resolve()) }));
jest.mock("./pushNotifications", () => ({ registerPushToken: jest.fn() }));
jest.mock("./screens/driver/locationTask", () => ({ stopLocationTracking: jest.fn() }));
jest.mock("./components/FingerprintLock", () => ({ FingerprintLock: ({ children }: { children: unknown }) => children }));
jest.mock("./data", () => ({ ParentDataProvider: ({ children }: { children: unknown }) => children }));
jest.mock("./studentData", () => ({ StudentDataProvider: ({ children }: { children: unknown }) => children }));
jest.mock("./screens/SignIn", () => ({ SignIn: () => <MockText>SIGN-IN SCREEN</MockText> }));
jest.mock("./screens/ChoosePassword", () => ({ ChoosePassword: () => <MockText>CHOOSE-PASSWORD SCREEN</MockText> }));
jest.mock("./navigation", () => ({ Navigation: ({ role }: { role: string }) => <MockText>HOME OF THE {role.toUpperCase()}</MockText> }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), supabase: jest.fn() }));

const supabase = shared.supabase as unknown as jest.Mock;

const NO_SIGNAL = { name: "AuthRetryableFetchError", message: "Network request failed", status: 0 };
const REFUSED = { name: "AuthApiError", message: "invalid JWT", status: 401 };
const NO_LOGIN = { name: "AuthSessionMissingError", message: "Auth session missing!" };

type Profile = { role: string; tenant_id: string | null; full_name: string; login_id: string | null; must_change_password: boolean };
const parentProfile: Profile = { role: "parent", tenant_id: "school-1", full_name: "Rose A.", login_id: "PT-0002", must_change_password: false };

/** The server, with what it would answer when it is up. `down`: nothing can be reached. `refuses`: it answers, and says no. */
const server = { down: false, refuses: null as null | typeof REFUSED | typeof NO_LOGIN, profile: parentProfile as Profile | null };

const fake = {
  auth: {
    getUser: async () => {
      if (server.down) return { data: { user: null }, error: NO_SIGNAL };
      if (server.refuses) return { data: { user: null }, error: server.refuses };
      return { data: { user: { id: "ann" } }, error: null };
    },
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
  from: (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          if (server.down) return { data: null, error: { message: "TypeError: Network request failed" } };
          return { data: table === "profiles" ? server.profile : { accent: "#7A1F2B", country: "KE" }, error: null };
        },
      }),
    }),
  }),
};

const LOGIN_KEY = "sb-127-auth-token";
const SAVED_KEY = "figbloom.session.v1.ann";
const savedParent = { role: "parent", accent: "#7A1F2B", profileId: "ann", country: "KE", tenantId: "school-1" };
const storeLogin = () => AsyncStorage.setItem(LOGIN_KEY, JSON.stringify({ access_token: "a.b.c", user: { id: "ann" } }));
const savePhoneIdentity = () => AsyncStorage.setItem(SAVED_KEY, JSON.stringify(savedParent));

beforeEach(async () => {
  await AsyncStorage.clear();
  server.down = false;
  server.refuses = null;
  server.profile = parentProfile;
  supabase.mockReset().mockReturnValue(fake);
});

const open = () => render(<App />);

describe("opening the app", () => {
  it("shows the sign-in screen when the server says nobody is signed in", async () => {
    server.refuses = NO_LOGIN;
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });

  it("opens the person's home and saves who they are when the server answers", async () => {
    await storeLogin();
    open();
    expect(await screen.findByText("HOME OF THE PARENT")).toBeTruthy();
    expect(screen.queryByText(SAVED_COPY_MESSAGE)).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem(SAVED_KEY)) ?? "null")).toEqual(savedParent);
  });

  it("with no signal, opens the saved home with a note that it may be out of date, not the sign-in screen", async () => {
    await storeLogin();
    await savePhoneIdentity();
    server.down = true;
    open();
    expect(await screen.findByText("HOME OF THE PARENT")).toBeTruthy();
    expect(screen.getByText(SAVED_COPY_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("SIGN-IN SCREEN")).toBeNull();
  });

  it("goes back to normal when Try again finds the server", async () => {
    await storeLogin();
    await savePhoneIdentity();
    server.down = true;
    open();
    await screen.findByText(SAVED_COPY_MESSAGE);

    server.down = false;
    await act(async () => { fireEvent.press(screen.getByText(TRY_AGAIN)); });

    await screen.findByText("HOME OF THE PARENT");
    expect(screen.queryByText(SAVED_COPY_MESSAGE)).toBeNull();
  });

  it("with no signal and nothing saved yet, says there is no connection instead of asking for a password", async () => {
    await storeLogin();
    server.down = true;
    open();
    expect(await screen.findByText(NO_CONNECTION_TITLE)).toBeTruthy();
    expect(screen.queryByText("SIGN-IN SCREEN")).toBeNull();
  });

  it("shows the sign-in screen with no signal when nobody is signed in on the phone", async () => {
    await savePhoneIdentity(); // left over, with no login to go with it: it must not open anything
    server.down = true;
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });

  it("does not open a saved home for a login the server refuses", async () => {
    await storeLogin();
    await savePhoneIdentity();
    server.refuses = REFUSED;
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
    expect(screen.queryByText("HOME OF THE PARENT")).toBeNull();
  });

  it("opens the saved home when the login is confirmed but the profile cannot be read", async () => {
    await storeLogin();
    await savePhoneIdentity();
    // The login check gets through, then the profile read fails.
    supabase.mockReturnValue({ ...fake, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "Network request failed" } }) }) }) }) });
    open();
    expect(await screen.findByText(SAVED_COPY_MESSAGE)).toBeTruthy();
    expect(screen.getByText("HOME OF THE PARENT")).toBeTruthy();
  });

  it("opens a driver's home when the server answers, but saves nothing for a driver", async () => {
    await storeLogin();
    server.profile = { ...parentProfile, role: "driver", full_name: "James Kariuki" };
    open();
    expect(await screen.findByText("HOME OF THE DRIVER")).toBeTruthy();
    expect(await AsyncStorage.getItem(SAVED_KEY)).toBeNull();
  });

  it("gives a driver the no-connection page with no signal: the driver's screen is all live data", async () => {
    await storeLogin();
    server.down = true;
    server.profile = { ...parentProfile, role: "driver", full_name: "James Kariuki" };
    open();
    expect(await screen.findByText(NO_CONNECTION_TITLE)).toBeTruthy();
    expect(screen.queryByText("SIGN-IN SCREEN")).toBeNull();
  });

  it("keeps a staff login (a role this app has no home for) on the sign-in screen", async () => {
    await storeLogin();
    server.profile = { ...parentProfile, role: "teacher" };
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });
});
