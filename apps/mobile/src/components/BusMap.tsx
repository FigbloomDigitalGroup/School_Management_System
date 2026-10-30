import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";
import { stopsInTravelOrder, type BusOnRoute, type Vehicle } from "@figbloom/shared";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";
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

/**
 * A lean native map for one bus (FIG-874): the bus, its route's stops in
 * order, and the line between them: the road buses drive when `path` has it
 * (see useRouteTrace), otherwise a straight line through the stops. Deliberately
 * simpler than web's LiveRouteMap (no satellite/traffic toggle) — see MAPS.md.
 * The bus glides between the positions it reports, natively, rather than jumping.
 *
 * `follow` is for the driver's own screen (FIG-1293): the camera keeps the bus
 * in view as it moves, until the driver drags the map, and a button brings it back.
 * A family watching the bus pans for themselves, so they leave it off.
 */
export function BusMap({ bus, tint, height = 180, follow = false, path = null }: { bus: BusMapBus; tint: string; height?: number; follow?: boolean; path?: LatLng[] | null }) {
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

  if (!initialRegion.current) return null;

  return (
    <View style={{ height, borderRadius: 12, overflow: "hidden" }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={initialRegion.current}
        customMapStyle={scheme === "dark" ? DARK_MAP_STYLE : undefined}
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
          <Marker ref={busMarker} coordinate={firstFix.current} title={bus.vehicle.plate_number} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tint, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: t.appSurface.ink, fontSize: 13 }}>🚌</Text>
            </View>
          </Marker>
        )}
      </MapView>
      {follow && !following && !!busPos && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Follow the bus"
          onPress={() => setFollowing(true)}
          style={{ position: "absolute", right: 8, bottom: 8, minHeight: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: t.appSurface.card, alignItems: "center", justifyContent: "center", elevation: 3 }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: accentInk(tint) }}>Follow the bus</Text>
        </Tap>
      )}
    </View>
  );
}
