import { Text as MockText } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { AlertRow, BusOnRoute, FleetNow, TripRow, Vehicle } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { Buses } from "./Buses";

// The buses on the move: which are on the road, the map, the alerts to acknowledge, and the latest trips.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
// The map is a native view with its own screens' tests; here it is only told apart by the bus it was given.
jest.mock("../../components/BusMap", () => ({ BusMap: ({ bus }: { bus: { vehicle: { plate_number: string } } }) => <MockText>{`Map of ${bus.vehicle.plate_number}`}</MockText> }));
jest.mock("../../lib/useRouteTrace", () => ({ useRouteTrace: () => null }));
// The feeds: the test says when a bus reports or an alert is raised.
let mockOnPosition: ((v: unknown) => void) | null = null;
let mockOnAlert: (() => void) | null = null;
const mockOffPositions = jest.fn();
const mockOffAlerts = jest.fn();
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchFleetNow: jest.fn(), acknowledgeAlert: jest.fn(),
  subscribeVehiclePositions: (_tenant: string, cb: (v: unknown) => void) => { mockOnPosition = cb; return mockOffPositions; },
  subscribeVehicleAlerts: (_tenant: string, cb: () => void) => { mockOnAlert = cb; return mockOffAlerts; },
}));

const fetchFleetNow = shared.fetchFleetNow as unknown as jest.Mock;
const acknowledgeAlert = shared.acknowledgeAlert as unknown as jest.Mock;

const session: StaffSession = {
  role: "staff", accent: "#7A1F2B", profileId: "transport-1", tenantId: "school-1", fullName: "Peter Otieno", country: "KE",
  adminAreas: ["transport"], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Transport officer",
};

const agoMs = (ms: number) => new Date(Date.now() - ms).toISOString();
const vehicle = (id: string, plate: string, ping: string | null, over: Partial<Vehicle> = {}): Vehicle => ({
  id, tenant_id: "school-1", plate_number: plate, make_model: null, capacity: 40, active: true, last_lat: -1.29, last_lng: 36.82, last_ping_at: ping, speed_limit_kmh: 80, created_at: "x", ...over,
});
const stop = (id: string, name: string, sequence: number) => ({ id, route_id: "r1", name, sequence, lat: -1.29 + sequence / 100, lng: 36.82, tenant_id: "school-1" }) as never;

const fleet = (over: Partial<FleetNow> = {}): FleetNow => ({
  buses: [
    // out of order on purpose: the list puts the bus on the road first
    { vehicle: vehicle("b3", "KDA 003C", null, { last_lat: null, last_lng: null }), driverName: null, driver: null, route: null, stops: [], direction: null },
    { vehicle: vehicle("b2", "KDA 002B", "2026-11-05T14:05:00", { make_model: "Isuzu FRR" }), driverName: "Dan Otieno", driver: null, route: { id: "r2", name: "Route B" }, stops: [stop("s3", "Gate", 1)], direction: null },
    { vehicle: vehicle("b1", "KDA 001A", agoMs(10_000)), driverName: "Joseph Kamau", driver: null, route: { id: "r1", name: "Route A" }, stops: [stop("s1", "School", 1), stop("s2", "Market", 2)], direction: "to_school" } as BusOnRoute,
  ],
  alerts: [{ id: "al1", tenant_id: "school-1", vehicle_id: "b1", trip_id: "t1", kind: "speed", detail: "92 km/h in an 80 zone", lat: 0, lng: 0, acknowledged_at: null, acknowledged_by: null, created_at: "2026-11-07T06:50:00", vehicle: { plate_number: "KDA 001A" } } as AlertRow],
  trips: [
    { id: "t1", tenant_id: "school-1", vehicle_id: "b1", route_id: "r1", driver_id: "d1", direction: "to_school", status: "active", started_at: new Date(2026, 10, 7, 6, 40).toISOString(), ended_at: null, vehicle: { plate_number: "KDA 001A" }, driver: { full_name: "Joseph Kamau" }, route: { name: "Route A" }, alertCount: 1 } as TripRow,
    { id: "t0", tenant_id: "school-1", vehicle_id: "b2", route_id: "r2", driver_id: "d2", direction: "from_school", status: "completed", started_at: new Date(2026, 10, 6, 15, 0).toISOString(), ended_at: new Date(2026, 10, 6, 15, 50).toISOString(), vehicle: { plate_number: "KDA 002B" }, driver: { full_name: "Dan Otieno" }, route: { name: "Route B" }, alertCount: 0 } as TripRow,
  ],
  ...over,
});

beforeEach(() => {
  mockOnPosition = null;
  mockOnAlert = null;
  mockOffPositions.mockReset();
  mockOffAlerts.mockReset();
  // a new answer each time, as a new read is: the same object would not be news to the screen
  fetchFleetNow.mockReset().mockImplementation(async () => fleet());
  acknowledgeAlert.mockReset().mockResolvedValue(undefined);
});

async function open() {
  render(<ThemeProvider><Buses session={session} /></ThemeProvider>);
  await screen.findByText(/on the road$/, {}, { timeout: 5000 });
}

describe("the buses", () => {
  it("counts how many are on the road, and lists those first, then the rest by number plate", async () => {
    await open();
    expect(fetchFleetNow).toHaveBeenCalledWith("school-1");
    expect(screen.getByText("Buses · 1 of 3 on the road")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Bus /).map((n) => n.props.accessibilityLabel)).toEqual(["Bus KDA 001A", "Bus KDA 002B", "Bus KDA 003C"]);
  });

  it("says where each stands, its route, who drives it and which way it is going", async () => {
    await open();
    expect(screen.getByText("On the road now · updated just now")).toBeTruthy();
    expect(screen.getByText("Route A · Joseph Kamau · To school")).toBeTruthy();
    expect(screen.getByText("KDA 002B · Isuzu FRR")).toBeTruthy();
    expect(screen.getByText(/^Last seen .*Nov/)).toBeTruthy();
    expect(screen.getByText("Route B · Dan Otieno")).toBeTruthy();
    expect(screen.getByText("Not reporting yet")).toBeTruthy();
    expect(screen.getByText("No route · No driver assigned")).toBeTruthy();
  });

  it("says there are no buses when the school has none", async () => {
    fetchFleetNow.mockResolvedValue(fleet({ buses: [], alerts: [], trips: [] }));
    render(<ThemeProvider><Buses session={session} /></ThemeProvider>);
    expect(await screen.findByText("No buses yet", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("No trips yet")).toBeTruthy();
    expect(screen.getByText("Buses · 0 of 0 on the road")).toBeTruthy();
  });
});

describe("the map", () => {
  it("opens a bus's route and position on the map, and closes it again", async () => {
    await open();
    expect(screen.queryByText("Map of KDA 001A")).toBeNull();
    fireEvent.press(screen.getAllByText("Show on the map")[0]!);
    expect(screen.getByText("Map of KDA 001A")).toBeTruthy();
    fireEvent.press(screen.getByText("Hide the map"));
    expect(screen.queryByText("Map of KDA 001A")).toBeNull();
  });

  it("keeps one map open at a time", async () => {
    await open();
    fireEvent.press(screen.getAllByText("Show on the map")[0]!);
    fireEvent.press(screen.getAllByText("Show on the map")[0]!);
    expect(screen.getByText("Map of KDA 002B")).toBeTruthy();
    expect(screen.queryByText("Map of KDA 001A")).toBeNull();
  });

  it("offers no map for a bus with neither a position nor a route", async () => {
    await open();
    // KDA 001A and KDA 002B have one; KDA 003C has neither
    expect(screen.getAllByText("Show on the map")).toHaveLength(2);
  });
});

describe("a bus reporting in", () => {
  it("moves it onto the road the moment it reports, without reading everything again", async () => {
    await open();
    expect(mockOnPosition).not.toBeNull();
    await act(async () => { mockOnPosition!({ id: "b2", last_lat: -1.3, last_lng: 36.9, last_ping_at: new Date().toISOString() }); });
    expect(screen.getByText("Buses · 2 of 3 on the road")).toBeTruthy();
    expect(fetchFleetNow).toHaveBeenCalledTimes(1);
  });

  it("takes what a fresh read says over what the feed said before it", async () => {
    await open();
    await act(async () => { mockOnPosition!({ id: "b2", last_lat: -1.3, last_lng: 36.9, last_ping_at: new Date().toISOString() }); });
    expect(screen.getByText("Buses · 2 of 3 on the road")).toBeTruthy();
    // the next read has bus 2 as the database has it: last seen two days ago
    await act(async () => { mockOnAlert!(); });
    expect(await screen.findByText("Buses · 1 of 3 on the road")).toBeTruthy();
  });

  it("reads everything again when the database raises an alert", async () => {
    await open();
    await act(async () => { mockOnAlert!(); });
    expect(fetchFleetNow).toHaveBeenCalledTimes(2);
  });

  it("stops listening when the screen goes", async () => {
    await open();
    screen.unmount();
    expect(mockOffPositions).toHaveBeenCalled();
    expect(mockOffAlerts).toHaveBeenCalled();
  });
});

describe("the alerts", () => {
  it("lists what the database flagged, which bus, what, when and the detail", async () => {
    await open();
    expect(screen.getByText("1 alert to look at")).toBeTruthy();
    expect(screen.getByText(/^KDA 001A · Speeding · 07 Nov, 06:50$/)).toBeTruthy();
    expect(screen.getByText("92 km/h in an 80 zone")).toBeTruthy();
  });

  it("acknowledges one as the person signed in, and reads the fleet again", async () => {
    await open();
    await act(async () => { fireEvent.press(screen.getByText("Acknowledge")); });
    expect(acknowledgeAlert).toHaveBeenCalledWith("al1", "transport-1");
    expect(fetchFleetNow).toHaveBeenCalledTimes(2);
  });

  it("says why when it could not be acknowledged, and leaves the alert there", async () => {
    acknowledgeAlert.mockRejectedValue(new Error("permission denied for table vehicle_alerts"));
    await open();
    await act(async () => { fireEvent.press(screen.getByText("Acknowledge")); });
    expect(await screen.findByText("Could not acknowledge: permission denied for table vehicle_alerts")).toBeTruthy();
    expect(screen.getByText("1 alert to look at")).toBeTruthy();
  });

  it("says nothing when there are none, and counts several", async () => {
    fetchFleetNow.mockResolvedValue(fleet({ alerts: [] }));
    await open();
    expect(screen.queryByText(/alerts? to look at/)).toBeNull();
  });
});

describe("the latest trips", () => {
  it("lists each with its bus, which way, route, driver, when, and how many alerts it raised", async () => {
    await open();
    expect(screen.getByText("To school · Route A · Joseph Kamau")).toBeTruthy();
    expect(screen.getByText("06:40 – on the road · 1 alert")).toBeTruthy();
    expect(screen.getByText("From school · Route B · Dan Otieno")).toBeTruthy();
    expect(screen.getByText("15:00 – 15:50")).toBeTruthy();
  });
});

describe("when it cannot be read", () => {
  it("says why, and asks again on request", async () => {
    fetchFleetNow.mockRejectedValueOnce(new Error("Network request failed"));
    render(<ThemeProvider><Buses session={session} /></ThemeProvider>);
    expect(await screen.findByText("Network request failed", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText(/on the road$/)).toBeTruthy();
  });
});
