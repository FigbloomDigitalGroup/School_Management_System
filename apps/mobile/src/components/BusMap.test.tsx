import type { ReactNode } from "react";
import { Modal, View as MockView } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_MAP_LOOK, type RouteStop } from "@figbloom/shared";
import { mapLook, MAP_LOOK_KEY } from "../lib/mapLook";
import { BusMap, type BusMapBus } from "./BusMap";

// The bus map: a card on the screen that opens full screen, where it can show satellite photos and live traffic.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("./BusIcon", () => ({ BusIcon: () => null }));
// A phone with a status bar above the app and a gesture bar below it (a test can change what the phone reports).
let mockInsets = { top: 24, right: 0, bottom: 16, left: 0 };
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => mockInsets }));
// The native map: a view that keeps the props it was given, and says when it is asked to glide the bus or move the camera.
// Google's map loads a moment after the view is made; here it has loaded by the time the view is on screen, unless a test
// says the map is slow, and then the test says when it has loaded.
const mockGlide = jest.fn();
const mockMoveCamera = jest.fn();
let mockMapLoadsAtOnce = true;
jest.mock("react-native-maps", () => {
  const { Component } = jest.requireActual<typeof import("react")>("react");
  class MapView extends Component<{ children?: ReactNode; onMapReady?: () => void }> {
    animateCamera = mockMoveCamera;
    componentDidMount() { if (mockMapLoadsAtOnce) this.props.onMapReady?.(); }
    render() { const { children, ...props } = this.props; return <MockView testID="map" {...props}>{children}</MockView>; }
  }
  class Marker extends Component<{ children?: ReactNode; title?: string }> {
    animateMarkerToCoordinate = mockGlide;
    render() { return <MockView testID="marker" accessibilityLabel={this.props.title}>{this.props.children}</MockView>; }
  }
  return { __esModule: true, default: MapView, Marker, Polyline: () => null };
});

const stop = (id: string, name: string, sequence: number): RouteStop => ({ id, tenant_id: "school-1", route_id: "r1", name, sequence, lat: -1.29 + sequence / 100, lng: 36.82 });
const bus = (lat: number | null = -1.3, lng: number | null = 36.8, plate = "KDA 001A"): BusMapBus => ({
  stops: [stop("s1", "School", 1), stop("s2", "Market", 2)], direction: "to_school", vehicle: { plate_number: plate, last_lat: lat, last_lng: lng },
});

/** Every map on the screen, in the order drawn: the cards first, then the full-screen one. */
const maps = () => screen.getAllByTestId("map");
/** What each of them is showing. */
const looks = () => maps().map((m) => `${m.props.mapType}${m.props.showsTraffic ? " with traffic" : ""}`);
const openFullScreen = (which = 0) => fireEvent.press(screen.getAllByLabelText("Open the map full screen")[which]!);

beforeEach(() => {
  mockInsets = { top: 24, right: 0, bottom: 16, left: 0 };
  mockMapLoadsAtOnce = true;
  mapLook.set(DEFAULT_MAP_LOOK);
  jest.clearAllMocks();
});

describe("the bus map", () => {
  it("is a road map with no traffic on it, with a way to open it full screen", () => {
    render(<BusMap bus={bus()} tint="#17402A" />);
    expect(looks()).toEqual(["standard"]);
    expect(screen.getByLabelText("Open the map full screen")).toBeTruthy();
    expect(screen.queryByLabelText("Close the map")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Satellite" })).toBeNull(); // the choices are on the full-screen map
  });

  it("draws nothing, and offers nothing to open, while there is neither a stop nor a position", () => {
    render(<BusMap bus={{ stops: [], direction: null, vehicle: { plate_number: "KDA 001A", last_lat: null, last_lng: null } }} tint="#17402A" />);
    expect(screen.toJSON()).toBeNull();
  });

  it("draws the route's stops before the bus has reported where it is", () => {
    render(<BusMap bus={bus(null, null)} tint="#17402A" />);
    expect(maps()).toHaveLength(1);
    // in the order the bus reaches them on the way to school, and no bus among them
    expect(screen.getAllByTestId("marker").map((m) => m.props.accessibilityLabel)).toEqual(["Market", "School"]);
    expect(screen.getByLabelText("Open the map full screen")).toBeTruthy();
  });

  it("opens over the screen, and closes with its own button or the phone's back button", () => {
    render(<BusMap bus={bus()} tint="#17402A" />);
    openFullScreen();
    expect(maps()).toHaveLength(2);
    expect(screen.getAllByLabelText("KDA 001A")).toHaveLength(2); // the bus is on the big map too

    fireEvent.press(screen.getByLabelText("Close the map"));
    expect(maps()).toHaveLength(1);

    openFullScreen();
    expect(maps()).toHaveLength(2);
    fireEvent(screen.UNSAFE_getByType(Modal), "requestClose");
    expect(maps()).toHaveLength(1);
  });

  it("keeps the map's compass and logo, and what it centres on, clear of the controls and the phone's edges", () => {
    render(<BusMap bus={bus()} tint="#17402A" />);
    openFullScreen();
    const [card, full] = maps();
    expect(card!.props.mapPadding).toBeUndefined();
    // 24 of status bar, then the row of controls: 12 above it, 44 of buttons, 8 below
    expect(full!.props.mapPadding).toEqual({ top: 88, right: 0, bottom: 16, left: 0 });
  });

  it("switches every map to satellite photos and back, says which is chosen, and remembers it", () => {
    // a parent with two children: two cards on the one screen
    render(<><BusMap bus={bus()} tint="#17402A" /><BusMap bus={bus(-1.31, 36.81, "KDA 002B")} tint="#17402A" /></>);
    openFullScreen(1);
    expect(looks()).toEqual(["standard", "standard", "standard"]);
    expect(screen.getByRole("radio", { name: "Map" }).props.accessibilityState).toEqual({ checked: true });
    expect(screen.getByRole("radio", { name: "Satellite" }).props.accessibilityState).toEqual({ checked: false });

    fireEvent.press(screen.getByRole("radio", { name: "Satellite" }));
    expect(looks()).toEqual(["hybrid", "hybrid", "hybrid"]);
    expect(screen.getByRole("radio", { name: "Map" }).props.accessibilityState).toEqual({ checked: false });
    expect(screen.getByRole("radio", { name: "Satellite" }).props.accessibilityState).toEqual({ checked: true });
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(MAP_LOOK_KEY, JSON.stringify({ base: "satellite", traffic: false }));

    // closing the big map leaves the cards as chosen
    fireEvent.press(screen.getByLabelText("Close the map"));
    expect(looks()).toEqual(["hybrid", "hybrid"]);

    openFullScreen(0);
    fireEvent.press(screen.getByRole("radio", { name: "Map" }));
    expect(looks()).toEqual(["standard", "standard", "standard"]);
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(MAP_LOOK_KEY, JSON.stringify({ base: "map", traffic: false }));
  });

  it("puts live traffic on and takes it off, whichever map is showing under it", () => {
    render(<BusMap bus={bus()} tint="#17402A" />);
    openFullScreen();
    const traffic = () => screen.getByRole("switch", { name: "Traffic" });
    expect(traffic().props.accessibilityState).toEqual({ checked: false });

    fireEvent.press(traffic());
    expect(looks()).toEqual(["standard with traffic", "standard with traffic"]);
    expect(traffic().props.accessibilityState).toEqual({ checked: true });
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(MAP_LOOK_KEY, JSON.stringify({ base: "map", traffic: true }));

    fireEvent.press(screen.getByRole("radio", { name: "Satellite" }));
    expect(looks()).toEqual(["hybrid with traffic", "hybrid with traffic"]);

    fireEvent.press(traffic());
    expect(looks()).toEqual(["hybrid", "hybrid"]);
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(MAP_LOOK_KEY, JSON.stringify({ base: "satellite", traffic: false }));
  });

  it("hands a map that was still loading the look chosen meanwhile, once it has loaded", () => {
    // The native map drops a map type sent between its making and Google's map loading. That is the moment the
    // look saved on the phone arrives on a launch: just after the first map was made with the plain one.
    mockMapLoadsAtOnce = false;
    render(<BusMap bus={bus()} tint="#17402A" />);
    expect(looks()).toEqual(["standard"]);

    act(() => mapLook.set({ base: "satellite", traffic: true }));
    expect(looks()).toEqual(["standard with traffic"]); // traffic is kept by the native map; the type would be lost

    fireEvent(maps()[0]!, "mapReady");
    expect(looks()).toEqual(["hybrid with traffic"]);
  });

  it("makes a map with the look already chosen, loaded or not", () => {
    mockMapLoadsAtOnce = false;
    mapLook.set({ base: "satellite", traffic: false });
    render(<BusMap bus={bus()} tint="#17402A" />);
    openFullScreen();
    expect(looks()).toEqual(["hybrid", "hybrid"]);
    expect(maps()[1]!.props.mapPadding).toEqual({ top: 88, right: 0, bottom: 16, left: 0 }); // and its padding with it
  });

  it("holds back new padding from a map that is still loading, and gives it once it has loaded", () => {
    // The native map applies padding to a Google map that exists, so sent to one still loading it can crash the app
    // (react-native-maps 1.26, MapView.applyBaseMapPadding). The phone's edges can change in that moment (the gesture bar
    // switches to buttons, say).
    mockMapLoadsAtOnce = false;
    const view = render(<BusMap bus={bus()} tint="#17402A" />);
    openFullScreen();
    expect(maps()[1]!.props.mapPadding).toEqual({ top: 88, right: 0, bottom: 16, left: 0 });

    mockInsets = { top: 30, right: 0, bottom: 0, left: 0 };
    view.rerender(<BusMap bus={bus()} tint="#17402A" />);
    expect(maps()[1]!.props.mapPadding).toEqual({ top: 88, right: 0, bottom: 16, left: 0 }); // what it was made with

    fireEvent(maps()[1]!, "mapReady");
    expect(maps()[1]!.props.mapPadding).toEqual({ top: 94, right: 0, bottom: 0, left: 0 });
  });

  it("glides the bus to each new position on the card and on the big map alike", () => {
    const view = render(<BusMap bus={bus(-1.3, 36.8)} tint="#17402A" />);
    openFullScreen();
    expect(mockGlide).not.toHaveBeenCalled(); // where it was first seen is where it is drawn

    view.rerender(<BusMap bus={bus(-1.301, 36.802)} tint="#17402A" />);
    expect(mockGlide).toHaveBeenCalledTimes(2);
    expect(mockGlide).toHaveBeenCalledWith({ latitude: -1.301, longitude: 36.802 }, expect.any(Number));
    expect(mockMoveCamera).not.toHaveBeenCalled(); // a family's map is theirs to pan: it does not follow
  });

  it("follows the bus on the driver's map until the driver drags it, each map on its own, with a way back", () => {
    const view = render(<BusMap bus={bus(-1.3, 36.8)} tint="#17402A" follow />);
    openFullScreen();
    mockMoveCamera.mockClear();

    view.rerender(<BusMap bus={bus(-1.301, 36.802)} tint="#17402A" follow />);
    expect(mockMoveCamera).toHaveBeenCalledTimes(2); // the card and the big map
    expect(screen.queryByLabelText("Follow the bus")).toBeNull();

    fireEvent(maps()[1]!, "panDrag"); // the driver looks ahead on the big map
    expect(screen.getAllByLabelText("Follow the bus")).toHaveLength(1);
    mockMoveCamera.mockClear();
    view.rerender(<BusMap bus={bus(-1.302, 36.804)} tint="#17402A" follow />);
    expect(mockMoveCamera).toHaveBeenCalledTimes(1); // only the card still follows

    fireEvent.press(screen.getByLabelText("Follow the bus"));
    expect(screen.queryByLabelText("Follow the bus")).toBeNull();
    expect(mockMoveCamera).toHaveBeenLastCalledWith({ center: { latitude: -1.302, longitude: 36.804 } }, { duration: 600 });
  });
});
