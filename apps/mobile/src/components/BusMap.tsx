import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Maximize2, X } from "lucide-react-native";
import { stopsInTravelOrder, type BusOnRoute, type MapLook, type Vehicle } from "@figbloom/shared";
import { useMapLook } from "../lib/mapLook";
import { CONTROL_FONT_SCALE, fontSize, HIT } from "../theme";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";
import { BusIcon } from "./BusIcon";
import { DARK_MAP_STYLE } from "./mapStyle";

interface LatLng { latitude: number; longitude: number }

/** What the map draws: a BusOnRoute fits, and so does a driver's own bus built from their assignment. */
export type BusMapBus = Pick<BusOnRoute, "stops" | "direction"> & { vehicle: Pick<Vehicle, "plate_number" | "last_lat" | "last_lng"> };

/** A viewport covering every point with room on all sides, not a tight crop. */
function regionFor(points: LatLng[]) {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.8, 0.01),
    longitudeDelta: Math.max((maxLng - minLng) * 1.8, 0.01),
  };
}

/**
 * A glide lasts about as long as the bus took to report again, so it is still
 * moving when the next ping lands. Never a snap (a ping a moment after the last
 * one), and never a crawl (a bus that was out of signal for minutes jumps ahead
 * quickly rather than drifting across the map).
 */
const GLIDE_MIN_MS = 400;
const GLIDE_MAX_MS = 5_000;

/** The full-screen map's row of controls: this far below the top of the screen, and this much of the map kept clear for it. */
const BAR_TOP = 12;
const BAR_CLEARANCE = BAR_TOP + HIT.minHeight + 8;

/** The three dots on the Traffic control: the colours Google draws moving, slow and stopped traffic in. The same in light and dark. */
const TRAFFIC_DOTS = ["#2EA45A", "#F2A516", "#D93A2B"];

/** How much of the map's top and bottom is under something else (the controls, the phone's own edges), in dp. */
interface Edge { top: number; bottom: number }

interface MapProps { bus: BusMapBus; tint: string; follow: boolean; path: LatLng[] | null }

/**
 * A native map for one bus (FIG-874): the bus, its route's stops in order, and
 * the line between them: the road buses drive when `path` has it (see
 * useRouteTrace), otherwise a straight line through the stops. The bus glides
 * between the positions it reports, natively, rather than jumping.
 *
 * It is drawn as a card on the screen, and the button in its corner opens the
 * same map full screen, where a person can also switch to satellite photos and
 * put Google's live traffic on: the two choices the web map has. They are
 * remembered on the phone and apply to every map, the cards included (lib/mapLook).
 *
 * `follow` is for the driver's own screen (FIG-1293): the camera keeps the bus
 * in view as it moves, until the driver drags the map, and a button brings it back.
 * A family watching the bus pans for themselves, so they leave it off.
 */
export function BusMap({ bus, tint, height = 180, follow = false, path = null }: { bus: BusMapBus; tint: string; height?: number; follow?: boolean; path?: LatLng[] | null }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [look, setLook] = useMapLook();
  const [fullScreen, setFullScreen] = useState(false);

  // Nothing to put on a map yet (no stops, no position): no map, and no way to open one.
  if (!bus.stops.length && (bus.vehicle.last_lat == null || bus.vehicle.last_lng == null)) return null;

  return (
    <View style={{ height, borderRadius: 12, overflow: "hidden" }}>
      <Canvas bus={bus} tint={tint} follow={follow} path={path} look={look} />
      <Tap
        accessibilityLabel="Open the map full screen"
        onPress={() => setFullScreen(true)}
        style={[styles.round, styles.float, { position: "absolute", top: 8, right: 8, backgroundColor: t.appSurface.card }]}
      >
        <Maximize2 size={18} color={t.appSurface.ink} />
      </Tap>

      {fullScreen && (
        <Modal visible animationType="slide" onRequestClose={() => setFullScreen(false)}>
          <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: t.appSurface.page }}>
            <Canvas bus={bus} tint={tint} follow={follow} path={path} look={look} edge={{ top: insets.top + BAR_CLEARANCE, bottom: insets.bottom }} />
            <View pointerEvents="box-none" style={[styles.bar, { top: insets.top + BAR_TOP }]}>
              <Tap accessibilityLabel="Close the map" onPress={() => setFullScreen(false)} style={[styles.round, styles.float, { backgroundColor: t.appSurface.card }]}>
                <X size={20} color={t.appSurface.ink} />
              </Tap>
              <LookControls look={look} onChange={setLook} />
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

/** The map itself, filling whatever it is put in: the card, or the whole screen. Each one keeps its own camera. */
function Canvas({ bus, tint, follow, path, look, edge }: MapProps & { look: MapLook; edge?: Edge }) {
  const { t, accentInk, scheme } = useTheme();
  const stops = stopsInTravelOrder(bus.stops, bus.direction);
  const busPos: LatLng | null =
    bus.vehicle.last_lat != null && bus.vehicle.last_lng != null
      ? { latitude: bus.vehicle.last_lat, longitude: bus.vehicle.last_lng }
      : null;

  // Computed once, from the first points there are: the camera is the viewer's to pan after that,
  // not recentred under them every time a new ping moves the bus marker. A map that mounts with
  // nothing to show yet (no stops, no fix) takes its viewport from whichever arrives first.
  const initialRegion = useRef<Region | null>(null);
  if (!initialRegion.current) {
    const points: LatLng[] = [...stops.map((s) => ({ latitude: s.lat, longitude: s.lng })), ...(busPos ? [busPos] : [])];
    if (points.length) initialRegion.current = regionFor(points);
  }

  // The marker is drawn once, where the bus was first seen, and its `coordinate` is never changed
  // after that: every later position slides there from native code. Changing the prop instead would
  // re-place the marker with a jump, and the glide would have nothing to animate.
  const busMarker = useRef<Marker>(null);
  const firstFix = useRef<LatLng | null>(null);
  if (!firstFix.current && busPos) firstFix.current = busPos;
  const lastFix = useRef<{ latitude: number; longitude: number; at: number } | null>(null);
  useEffect(() => {
    if (!busPos) return;
    const now = Date.now();
    const prev = lastFix.current;
    lastFix.current = { ...busPos, at: now };
    if (!prev || (prev.latitude === busPos.latitude && prev.longitude === busPos.longitude)) return;
    busMarker.current?.animateMarkerToCoordinate(busPos, Math.min(Math.max(now - prev.at, GLIDE_MIN_MS), GLIDE_MAX_MS));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the position's two numbers are what moves the marker
  }, [busPos?.latitude, busPos?.longitude]);

  const mapRef = useRef<MapView>(null);
  const [following, setFollowing] = useState(follow);
  useEffect(() => {
    if (following && busPos) mapRef.current?.animateCamera({ center: busPos }, { duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the position's two numbers are what moves the camera
  }, [following, busPos?.latitude, busPos?.longitude]);

  // The same object from one render to the next, so the map is not handed its padding again with every ping.
  const edgeTop = edge?.top;
  const edgeBottom = edge?.bottom;
  const padding = useMemo(
    () => (edgeTop == null || edgeBottom == null ? undefined : { top: edgeTop, right: 0, bottom: edgeBottom, left: 0 }),
    [edgeTop, edgeBottom],
  );
  // Satellite photos keep their road and place names ("hybrid"), as on the web.
  const type: "hybrid" | "standard" = look.base === "satellite" ? "hybrid" : "standard";

  // The native map takes these two when it is made and, after that, only once Google's map has loaded: a map
  // type sent in between is dropped, and padding sent in between reaches code that expects the loaded map
  // (react-native-maps 1.26, MapView.java setMapType and applyBaseMapPadding). So what the map was made with
  // stands until it says it is ready, and it is handed the current values then. Without this, a look read from
  // the phone's storage a moment after the first map appeared would never reach that map.
  const [ready, setReady] = useState(false);
  const made = useRef({ type, padding }).current;

  if (!initialRegion.current) return null;

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={initialRegion.current}
        onMapReady={() => setReady(true)}
        mapType={ready ? type : made.type}
        showsTraffic={look.traffic}
        // Google draws a custom style on the road map only, so the night style can stay set under the photos.
        customMapStyle={scheme === "dark" ? DARK_MAP_STYLE : undefined}
        mapPadding={ready ? padding : made.padding}
        pitchEnabled={false}
        toolbarEnabled={false}
        onPanDrag={follow ? () => setFollowing(false) : undefined}
      >
        {(path && path.length > 1) || stops.length > 1 ? (
          <Polyline
            coordinates={path && path.length > 1 ? path : stops.map((s) => ({ latitude: s.lat, longitude: s.lng }))}
            strokeColor={accentInk(tint)}
            strokeWidth={4}
          />
        ) : null}
        {stops.map((s, i) => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title={s.name} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff", borderWidth: 2, borderColor: tint, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 10, fontWeight: "700", color: tint }}>{i + 1}</Text>
            </View>
          </Marker>
        ))}
        {firstFix.current && (
          // above the stop pins, so a bus waiting at a stop is not hidden under that stop's number
          <Marker ref={busMarker} coordinate={firstFix.current} title={bus.vehicle.plate_number} anchor={{ x: 0.5, y: 0.5 }} zIndex={10}>
            <BusIcon ring={tint} />
          </Marker>
        )}
      </MapView>
      {follow && !following && !!busPos && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Follow the bus"
          onPress={() => setFollowing(true)}
          style={[styles.float, { position: "absolute", right: 8, bottom: 8 + (edge?.bottom ?? 0), minHeight: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: t.appSurface.card, alignItems: "center", justifyContent: "center" }]}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: accentInk(tint) }}>Follow the bus</Text>
        </Tap>
      )}
    </View>
  );
}

/**
 * Map or Satellite, and Traffic: the web map's two controls, in the same words. The one that is on is filled
 * with the ink colour, so it is told apart by its weight on the map and not by a hue.
 */
function LookControls({ look, onChange }: { look: MapLook; onChange: (next: MapLook) => void }) {
  const { t } = useTheme();
  const fill = (on: boolean) => ({ backgroundColor: on ? t.appSurface.ink : t.appSurface.card });
  const label = (on: boolean) => ({ fontSize: fontSize.small, fontWeight: "600" as const, color: on ? t.appSurface.card : t.appSurface.ink });

  return (
    // box-none: the gap this row leaves beside the close button is still the map's to drag
    <View pointerEvents="box-none" style={styles.looks}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Map type" style={[styles.segment, styles.float, { backgroundColor: t.appSurface.card }]}>
        {(["map", "satellite"] as const).map((base) => {
          const on = look.base === base;
          return (
            <Tap key={base} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange({ ...look, base })} pressedScale={1} style={[styles.choice, fill(on)]}>
              <Text maxFontSizeMultiplier={CONTROL_FONT_SCALE} style={label(on)}>{base === "map" ? "Map" : "Satellite"}</Text>
            </Tap>
          );
        })}
      </View>
      <Tap
        accessibilityRole="switch"
        accessibilityState={{ checked: look.traffic }}
        accessibilityLabel="Traffic"
        onPress={() => onChange({ ...look, traffic: !look.traffic })}
        style={[styles.choice, styles.pill, styles.float, fill(look.traffic)]}
      >
        <View style={styles.dots}>
          {TRAFFIC_DOTS.map((color) => <View key={color} style={[styles.dot, { backgroundColor: color }]} />)}
        </View>
        <Text maxFontSizeMultiplier={CONTROL_FONT_SCALE} style={label(look.traffic)}>Traffic</Text>
      </Tap>
    </View>
  );
}

const styles = StyleSheet.create({
  /** Anything that sits on the map lifts off it, so it reads as a control over photos and roads alike. */
  float: { elevation: 3, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 3 },
  round: { width: HIT.minWidth, height: HIT.minHeight, borderRadius: HIT.minHeight / 2, alignItems: "center", justifyContent: "center" },
  bar: { position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  // Wraps under itself, to the right, on a narrow phone with large text rather than running off the screen.
  looks: { flex: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  segment: { flexDirection: "row", borderRadius: HIT.minHeight / 2, overflow: "hidden" },
  choice: { minHeight: HIT.minHeight, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  pill: { borderRadius: HIT.minHeight / 2 },
  dots: { flexDirection: "row", gap: 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
