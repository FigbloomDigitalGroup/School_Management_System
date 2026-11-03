import { Alert, Platform } from "react-native";
import Geolocation from "react-native-geolocation-service";
import { check, request, RESULTS } from "react-native-permissions";
import { checkLocationSwitch, ensureLocationPermissions, locationSwitchFromError } from "./locationTask";

// FIG-1491: a trip must not start with the phone's Location switched off, and the driver must be told before Android
// sends them to its Settings page to choose "Allow all the time".

jest.mock("react-native-background-actions", () => ({ __esModule: true, default: { start: jest.fn(), stop: jest.fn(), isRunning: jest.fn(() => false) } }));
jest.mock("react-native-geolocation-service", () => ({ __esModule: true, default: { getCurrentPosition: jest.fn(), watchPosition: jest.fn(), clearWatch: jest.fn() } }));
jest.mock("react-native-permissions", () => ({
  PERMISSIONS: {
    ANDROID: { ACCESS_FINE_LOCATION: "fine", ACCESS_BACKGROUND_LOCATION: "background" },
    IOS: { LOCATION_WHEN_IN_USE: "when-in-use", LOCATION_ALWAYS: "always" },
  },
  RESULTS: { GRANTED: "granted", DENIED: "denied", BLOCKED: "blocked", UNAVAILABLE: "unavailable" },
  check: jest.fn(),
  request: jest.fn(),
}));

const geo = Geolocation.getCurrentPosition as unknown as jest.Mock;
const checkMock = check as unknown as jest.Mock;
const requestMock = request as unknown as jest.Mock;
const asAndroid = (version = 30) => {
  jest.replaceProperty(Platform, "OS", "android");
  jest.spyOn(Platform, "Version", "get").mockReturnValue(version);
};

beforeEach(() => {
  geo.mockReset();
  checkMock.mockReset();
  requestMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe("locationSwitchFromError", () => {
  it("says the switch is off for 'position unavailable' (2), what a Galaxy A14 answered with Location off, and for 'settings not satisfied' (5)", () => {
    expect(locationSwitchFromError(2)).toBe("off");
    expect(locationSwitchFromError(5)).toBe("off");
  });
  it("says nothing about the switch for a refused permission, a timeout (no sky indoors) or anything else", () => {
    for (const code of [1, 3, 4, -1, undefined]) expect(locationSwitchFromError(code)).toBe("unknown");
  });
});

describe("checkLocationSwitch", () => {
  it("is on when a position comes back, and asks quietly: no 'turn on Location' box", async () => {
    asAndroid();
    geo.mockImplementation((ok) => ok({ coords: { latitude: -1.2, longitude: 36.8 } }));
    await expect(checkLocationSwitch()).resolves.toBe("on");
    expect(geo.mock.calls[0]![2]).toMatchObject({ showLocationDialog: false, forceRequestLocation: false });
  });
  it("is off when the library says no position is available (what the phone answered with Location switched off)", async () => {
    asAndroid();
    geo.mockImplementation((_ok, fail) => fail({ code: 2, message: "Unable to retrieve location." }));
    await expect(checkLocationSwitch()).resolves.toBe("off");
  });
  it("is off when the library says the settings are not satisfied", async () => {
    asAndroid();
    geo.mockImplementation((_ok, fail) => fail({ code: 5, message: "Location service is not enabled" }));
    await expect(checkLocationSwitch()).resolves.toBe("off");
  });
  it("is unknown after a timeout (indoors, no fix yet), so the trip may still start", async () => {
    asAndroid();
    geo.mockImplementation((_ok, fail) => fail({ code: 3, message: "timeout" }));
    await expect(checkLocationSwitch()).resolves.toBe("unknown");
  });
  it("does not ask at all on iOS, where the permission step already covers it", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await expect(checkLocationSwitch()).resolves.toBe("unknown");
    expect(geo).not.toHaveBeenCalled();
  });
});

describe("ensureLocationPermissions on Android", () => {
  const answers = (fine: string, backgroundNow: string, backgroundAsked: string) => {
    checkMock.mockResolvedValue(backgroundNow);
    requestMock.mockImplementation(async (permission: string) => (permission === "fine" ? fine : backgroundAsked));
  };
  const confirmAlerts = () =>
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => { buttons?.[0]?.onPress?.(); });

  it("explains the Settings screen BEFORE sending the driver to it", async () => {
    asAndroid();
    answers("granted", "denied", "granted");
    const alert = confirmAlerts();
    const order: string[] = [];
    alert.mockImplementation((_t, _m, buttons) => { order.push("explained"); buttons?.[0]?.onPress?.(); });
    requestMock.mockImplementation(async (permission: string) => { order.push(permission); return "granted"; });
    await expect(ensureLocationPermissions()).resolves.toEqual({ ok: true });
    expect(order).toEqual(["fine", "explained", "background"]);
    expect(String(alert.mock.calls[0]![1])).toMatch(/Allow all the time/);
  });
  it("does not explain when 'all the time' is already allowed", async () => {
    asAndroid();
    answers("granted", "granted", "granted");
    const alert = confirmAlerts();
    await expect(ensureLocationPermissions()).resolves.toEqual({ ok: true });
    expect(alert).not.toHaveBeenCalled();
  });
  it("does not explain when the phone has no such setting (older Android)", async () => {
    asAndroid();
    answers("granted", "unavailable", "unavailable");
    const alert = confirmAlerts();
    await ensureLocationPermissions();
    expect(alert).not.toHaveBeenCalled();
  });
  it("still says what to change in Settings when it is refused", async () => {
    asAndroid();
    answers("granted", "denied", "denied");
    confirmAlerts();
    const refused = await ensureLocationPermissions();
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/Allow all the time/);
  });
  it("does not explain a Settings page it will never open, when the first step is refused", async () => {
    asAndroid();
    answers("denied", "denied", "denied");
    const alert = confirmAlerts();
    const noForeground = await ensureLocationPermissions();
    expect(noForeground.ok).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
  it("carries on if the driver dismisses the explanation", async () => {
    asAndroid();
    answers("granted", "denied", "granted");
    jest.spyOn(Alert, "alert").mockImplementation((_t, _m, _b, options) => { options?.onDismiss?.(); });
    await expect(ensureLocationPermissions()).resolves.toEqual({ ok: true });
  });
});

void RESULTS;
