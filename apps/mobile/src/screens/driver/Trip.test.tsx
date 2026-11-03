import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { DriverTrip, LOCATION_OFF_MESSAGE, NO_FIX_AFTER_MS, NO_FIX_MESSAGE } from "./Trip";
import * as task from "./locationTask";

// FIG-1491: with the phone's Location switched off a trip used to go live, say "Waiting for the first location fix…" for
// ever, and show the school and parents a bus on the road that never moved.

// The icon library ships as untranspiled ES modules; the icons are not what this tests.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : () => null) }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  myAssignment: jest.fn(),
  myActiveTrip: jest.fn(),
  listRouteStops: jest.fn(),
  startTrip: jest.fn(),
  endTrip: jest.fn(),
  pingLocation: jest.fn(),
  locationPingRow: jest.fn(),
  stopsInTravelOrder: jest.fn(() => []),
  supabase: jest.fn(),
}));
jest.mock("../../storage", () => ({
  queue: { setUser: jest.fn(), flush: jest.fn(() => Promise.resolve()), pendingFor: jest.fn(() => Promise.resolve([])), enqueue: jest.fn() },
}));
// Signing out reaches for Firebase and the phone's storage; lib/signOut.test.ts covers it.
jest.mock("../../lib/signOut", () => ({ signOutOfThisPhone: jest.fn(() => Promise.resolve()) }));
jest.mock("./locationTask", () => ({
  ensureLocationPermissions: jest.fn(),
  checkLocationSwitch: jest.fn(),
  startLocationTracking: jest.fn(),
  stopLocationTracking: jest.fn(() => Promise.resolve()),
}));
// The map, the riders list and the other panels are not what this tests.
jest.mock("./TripMap", () => ({ TripMap: () => null }));
jest.mock("./TripRiders", () => ({ TripRiders: () => null }));
jest.mock("./RefusedPings", () => ({ RefusedPings: () => null }));
jest.mock("./ReportBreakdown", () => ({ ReportBreakdown: () => null }));
jest.mock("../../components/FingerprintSetting", () => ({ FingerprintSetting: () => null }));
jest.mock("../../components/PrivacyLinks", () => ({ PrivacyLinks: () => null }));
jest.mock("../../ui/AppearanceSetting", () => ({ AppearanceSetting: () => null }));

const mocked = (fn: unknown) => fn as jest.Mock;
const api = {
  myAssignment: mocked(shared.myAssignment),
  myActiveTrip: mocked(shared.myActiveTrip),
  listRouteStops: mocked(shared.listRouteStops),
  startTrip: mocked(shared.startTrip),
  pingLocation: mocked(shared.pingLocation),
};
const place = {
  ensureLocationPermissions: mocked(task.ensureLocationPermissions),
  checkLocationSwitch: mocked(task.checkLocationSwitch),
  startLocationTracking: mocked(task.startLocationTracking),
};

const trip = { id: "trip-1", vehicle_id: "bus-1", route_id: "route-1", direction: "to_school", started_at: "2026-11-02T06:30:00Z" };

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  api.myAssignment.mockResolvedValue({ vehicle_id: "bus-1", route_id: "route-1", vehicle: { plate_number: "KDA 123A" }, route: { name: "Route 1" } });
  api.myActiveTrip.mockResolvedValue(null);
  api.listRouteStops.mockResolvedValue([]);
  api.startTrip.mockReset().mockResolvedValue(trip);
  api.pingLocation.mockReset().mockResolvedValue(undefined);
  place.ensureLocationPermissions.mockReset().mockResolvedValue({ ok: true });
  place.checkLocationSwitch.mockReset();
  place.startLocationTracking.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

async function openScreen() {
  render(<DriverTrip driverId="driver-1" tenantId="school-1" accent="forest" fullName="Baraka Njoroge" />);
  await screen.findByText("Start trip");
}
const startTrip = () => fireEvent.press(screen.getByText("Start trip"));

describe("starting a trip with the phone's Location switch", () => {
  it("off: says so, in words, and does not create the trip or start tracking", async () => {
    place.checkLocationSwitch.mockResolvedValue("off");
    await openScreen();
    startTrip();
    expect(await screen.findByText(LOCATION_OFF_MESSAGE)).toBeTruthy();
    expect(api.startTrip).not.toHaveBeenCalled();
    expect(place.startLocationTracking).not.toHaveBeenCalled();
    expect(screen.queryByText(/Trip in progress/)).toBeNull();
  });

  it("off, then switched on: the next Start trip goes ahead", async () => {
    place.checkLocationSwitch.mockResolvedValueOnce("off").mockResolvedValue("on");
    await openScreen();
    startTrip();
    await screen.findByText(LOCATION_OFF_MESSAGE);
    startTrip();
    await waitFor(() => expect(api.startTrip).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Trip in progress/)).toBeTruthy();
    expect(screen.queryByText(LOCATION_OFF_MESSAGE)).toBeNull();
  });

  it("on: creates the trip and starts tracking", async () => {
    place.checkLocationSwitch.mockResolvedValue("on");
    await openScreen();
    startTrip();
    await waitFor(() => expect(place.startLocationTracking).toHaveBeenCalledTimes(1));
    expect(api.startTrip).toHaveBeenCalledWith(expect.objectContaining({ vehicleId: "bus-1", routeId: "route-1", direction: "to_school" }));
  });

  it("not known (no fix yet indoors): the trip still starts", async () => {
    place.checkLocationSwitch.mockResolvedValue("unknown");
    await openScreen();
    startTrip();
    await waitFor(() => expect(api.startTrip).toHaveBeenCalledTimes(1));
  });

  it("does not check the switch when the permissions were refused", async () => {
    place.ensureLocationPermissions.mockResolvedValue({ ok: false, message: "Location permission was denied. Allow location access to track this trip." });
    await openScreen();
    startTrip();
    expect(await screen.findByText(/Location permission was denied/)).toBeTruthy();
    expect(place.checkLocationSwitch).not.toHaveBeenCalled();
    expect(api.startTrip).not.toHaveBeenCalled();
  });
});

describe("a live trip that never gets a fix", () => {
  const waiting = "Waiting for the first location fix…";

  it(`says what to check after ${NO_FIX_AFTER_MS / 1000} seconds, not before`, async () => {
    place.checkLocationSwitch.mockResolvedValue("on");
    await openScreen();
    startTrip();
    expect(await screen.findByText(waiting)).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(NO_FIX_AFTER_MS - 1_000); });
    expect(screen.getByText(waiting)).toBeTruthy();
    expect(screen.queryByText(NO_FIX_MESSAGE)).toBeNull();
    await act(async () => { jest.advanceTimersByTime(1_500); });
    expect(screen.getByText(NO_FIX_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(waiting)).toBeNull();
  });

  it("says nothing of the kind once a fix has arrived", async () => {
    place.checkLocationSwitch.mockResolvedValue("on");
    await openScreen();
    startTrip();
    await waitFor(() => expect(place.startLocationTracking).toHaveBeenCalledTimes(1));
    const onTick = place.startLocationTracking.mock.calls[0]![0] as (tick: { lat: number; lng: number; recordedAt: string }) => void;
    await act(async () => { onTick({ lat: -1.2921, lng: 36.8219, recordedAt: "2026-11-02T06:31:00Z" }); });
    await act(async () => { jest.advanceTimersByTime(NO_FIX_AFTER_MS + 5_000); });
    expect(screen.queryByText(NO_FIX_MESSAGE)).toBeNull();
    expect(await screen.findByText(/Last sent:/)).toBeTruthy();
  });
});
