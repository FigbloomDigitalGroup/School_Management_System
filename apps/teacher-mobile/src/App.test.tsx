import { Text as MockText } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as shared from "@figbloom/shared";
import App from "../App";
import { NO_CONNECTION_TITLE, TRY_AGAIN } from "./components/OfflineNotice";

// FIG-1487: opening the app with no signal showed the sign-in screen to a teacher who is still signed in.
// "Cannot reach the server" is not "signed out".

// Everything the App renders around the sign-in decision is replaced by a marker: what is tested is which one shows.
jest.mock("react-native-safe-area-context", () => ({ SafeAreaProvider: ({ children }: { children: unknown }) => children }));
jest.mock("./lib/client", () => ({}));
jest.mock("./lib/signOut", () => ({ signOutOfThisPhone: jest.fn(() => Promise.resolve()) }));
jest.mock("./pushNotifications", () => ({ registerPushToken: jest.fn() }));
jest.mock("./components/FingerprintLock", () => ({ FingerprintLock: ({ children }: { children: unknown }) => children }));
jest.mock("./screens/SignIn", () => ({ SignIn: () => <MockText>SIGN-IN SCREEN</MockText> }));
jest.mock("./screens/ChoosePassword", () => ({ ChoosePassword: () => <MockText>CHOOSE-PASSWORD SCREEN</MockText> }));
jest.mock("./navigation", () => ({ Navigation: () => <MockText>TEACHER HOME</MockText> }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), supabase: jest.fn() }));

const supabase = shared.supabase as unknown as jest.Mock;

const NO_SIGNAL = { name: "AuthRetryableFetchError", message: "Network request failed", status: 0 };
const REFUSED = { name: "AuthApiError", message: "invalid JWT", status: 401 };
const NO_LOGIN = { name: "AuthSessionMissingError", message: "Auth session missing!" };

type Profile = { role: string; tenant_id: string | null; full_name: string; login_id: string | null; must_change_password: boolean };
const teacherProfile: Profile = { role: "teacher", tenant_id: "school-1", full_name: "Ann Wanjiru", login_id: "TC-0002", must_change_password: false };

/** The server, with what it would answer when it is up. `down`: nothing can be reached. `refuses`: it answers, and says no. */
const server = { down: false, refuses: null as null | typeof REFUSED | typeof NO_LOGIN, profile: teacherProfile as Profile | null };

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

const storeLogin = () => AsyncStorage.setItem("sb-127-auth-token", JSON.stringify({ access_token: "a.b.c", user: { id: "ann" } }));

beforeEach(async () => {
  await AsyncStorage.clear();
  server.down = false;
  server.refuses = null;
  server.profile = teacherProfile;
  supabase.mockReset().mockReturnValue(fake);
});

const open = () => render(<App />);

describe("opening the teacher app", () => {
  it("shows the sign-in screen when the server says nobody is signed in", async () => {
    server.refuses = NO_LOGIN;
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });

  it("opens the teacher's home when the server answers", async () => {
    await storeLogin();
    open();
    expect(await screen.findByText("TEACHER HOME")).toBeTruthy();
  });

  it("with no signal, says there is no connection to a teacher who is still signed in, not 'sign in'", async () => {
    await storeLogin();
    server.down = true;
    open();
    expect(await screen.findByText(NO_CONNECTION_TITLE)).toBeTruthy();
    expect(screen.queryByText("SIGN-IN SCREEN")).toBeNull();
  });

  it("goes to the home when Try again finds the server", async () => {
    await storeLogin();
    server.down = true;
    open();
    await screen.findByText(NO_CONNECTION_TITLE);

    server.down = false;
    await act(async () => { fireEvent.press(screen.getByText(TRY_AGAIN)); });

    expect(await screen.findByText("TEACHER HOME")).toBeTruthy();
    expect(screen.queryByText(NO_CONNECTION_TITLE)).toBeNull();
  });

  it("says there is no connection when the login is confirmed but the profile cannot be read", async () => {
    await storeLogin();
    supabase.mockReturnValue({ ...fake, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "Network request failed" } }) }) }) }) });
    open();
    expect(await screen.findByText(NO_CONNECTION_TITLE)).toBeTruthy();
  });

  it("shows the sign-in screen with no signal when nobody is signed in on the phone", async () => {
    server.down = true;
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });

  it("shows the sign-in screen for a login the server refuses", async () => {
    await storeLogin();
    server.refuses = REFUSED;
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });

  it("keeps a login that is not a teacher's on the sign-in screen", async () => {
    await storeLogin();
    server.profile = { ...teacherProfile, role: "parent" };
    open();
    expect(await screen.findByText("SIGN-IN SCREEN")).toBeTruthy();
  });
});
