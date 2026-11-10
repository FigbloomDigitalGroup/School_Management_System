import { Modal, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as unlock from "../lib/fingerprintUnlock";
import { ThemeProvider } from "../ui/ThemeContext";
import { FingerprintLock } from "./FingerprintLock";

// The admin screens always ask for the fingerprint. The person's own choice still rules everything else.

jest.mock("../lib/fingerprintUnlock", () => ({
  fingerprintSupport: jest.fn(),
  confirmFingerprint: jest.fn(),
  readFingerprintUnlock: jest.fn(),
  saveFingerprintUnlock: jest.fn(),
  forgetFingerprintUnlock: jest.fn(),
  openFingerprintSettings: jest.fn(),
}));
// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("../lib/signOut", () => ({ signOutOfThisPhone: jest.fn(() => Promise.resolve()) }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  supabase: () => ({ auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } }),
}));

const m = unlock as unknown as Record<
  "fingerprintSupport" | "confirmFingerprint" | "readFingerprintUnlock" | "saveFingerprintUnlock" | "forgetFingerprintUnlock" | "openFingerprintSettings",
  jest.Mock
>;

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") fn.mockReset();
  m.readFingerprintUnlock.mockResolvedValue(false);
  m.fingerprintSupport.mockResolvedValue("ready");
  m.confirmFingerprint.mockResolvedValue(true);
  m.saveFingerprintUnlock.mockResolvedValue(undefined);
  m.forgetFingerprintUnlock.mockResolvedValue(undefined);
});

type Props = { required?: boolean; onLeave?: { label: string; run: () => void } };
const tree = (props: Props) => (
  <ThemeProvider>
    <FingerprintLock profileId="ann" accent="#7A1F2B" {...props}>
      <Text>THE APP</Text>
    </FingerprintLock>
  </ThemeProvider>
);
const mount = (props: Props = {}) => render(tree(props));
/** The system tells the lock screen it is on show, which is what makes it ask (a real Modal does; the test renderer does not). */
const shown = () => act(async () => { fireEvent(screen.UNSAFE_getByType(Modal), "show"); });

describe("the fingerprint lock", () => {
  it("leaves the app open when the person has not chosen a lock and nothing requires one", async () => {
    mount();
    expect(await screen.findByText("THE APP")).toBeTruthy();
    expect(screen.queryByText("Figbloom is locked")).toBeNull();
  });

  it("locks when the person chose it, and opens with their fingerprint", async () => {
    m.readFingerprintUnlock.mockResolvedValue(true);
    mount();
    expect(await screen.findByText("Figbloom is locked")).toBeTruthy();
    await shown();
    expect(m.confirmFingerprint).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Figbloom is locked")).toBeNull();
    expect(screen.getByText("THE APP")).toBeTruthy();
  });

  it("locks when it is required, even though the person never chose a lock", async () => {
    mount({ required: true });
    expect(await screen.findByText("Figbloom is locked")).toBeTruthy();
    await shown();
    expect(screen.queryByText("Figbloom is locked")).toBeNull();
  });

  it("stays locked, and offers another try, when the fingerprint is not recognised", async () => {
    m.confirmFingerprint.mockResolvedValue(false);
    mount({ required: true });
    await screen.findByText("Figbloom is locked");
    await shown();
    expect(screen.getByText("That didn't unlock it. Tap the button to try again.")).toBeTruthy();
    expect(screen.getByText("Unlock with fingerprint")).toBeTruthy();
  });

  it("asks again when the admin screens come on show during a session, which an earlier unlock does not cover", async () => {
    const view = mount();
    await screen.findByText("THE APP");
    expect(screen.queryByText("Figbloom is locked")).toBeNull();

    view.rerender(tree({ required: true }));
    expect(await screen.findByText("Figbloom is locked")).toBeTruthy();
    expect(screen.getByText("THE APP")).toBeTruthy();
  });

  it("asks again for the admin screens even when the person's own lock was opened a moment ago", async () => {
    m.readFingerprintUnlock.mockResolvedValue(true);
    const view = mount();
    await screen.findByText("Figbloom is locked");
    await shown();
    expect(screen.queryByText("Figbloom is locked")).toBeNull();
    expect(m.confirmFingerprint).toHaveBeenCalledTimes(1);

    view.rerender(tree({ required: true }));
    expect(await screen.findByText("Figbloom is locked")).toBeTruthy();
    await shown();
    expect(m.confirmFingerprint).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Figbloom is locked")).toBeNull();
  });

  describe("on a phone that cannot give a fingerprint", () => {
    it("sends a person with a sensor but no fingerprint saved to the phone's settings, when the lock is required", async () => {
      m.fingerprintSupport.mockResolvedValue("not_enrolled");
      mount({ required: true });
      await screen.findByText("Figbloom is locked");
      await shown();
      expect(screen.getByText("Set up a fingerprint")).toBeTruthy();
      await act(async () => { fireEvent.press(screen.getByText("Open phone settings")); });
      expect(m.openFingerprintSettings).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Check again")).toBeTruthy();
    });

    it("says the admin screens cannot open on a phone with no usable sensor, and offers no way past", async () => {
      m.fingerprintSupport.mockResolvedValue("unavailable");
      mount({ required: true });
      await screen.findByText("Figbloom is locked");
      await shown();
      expect(screen.getByText("Admin screens need a fingerprint")).toBeTruthy();
      expect(screen.queryByText("Unlock with fingerprint")).toBeNull();
      expect(screen.getByText("Sign out")).toBeTruthy();
    });

    it("keeps its old words when only the person's own lock is on", async () => {
      m.readFingerprintUnlock.mockResolvedValue(true);
      m.fingerprintSupport.mockResolvedValue("not_enrolled");
      mount();
      await screen.findByText("Figbloom is locked");
      await shown();
      expect(screen.getByText("Fingerprint unavailable")).toBeTruthy();
      expect(screen.queryByText("Open phone settings")).toBeNull();
    });
  });

  it("gives a teacher who switched to the admin screens a way back to their own", async () => {
    const run = jest.fn();
    m.fingerprintSupport.mockResolvedValue("unavailable");
    mount({ required: true, onLeave: { label: "Back to teacher screens", run } });
    await screen.findByText("Figbloom is locked");
    await shown();
    await act(async () => { fireEvent.press(screen.getByText("Back to teacher screens")); });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
