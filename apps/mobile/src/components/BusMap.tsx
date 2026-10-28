import { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";
import { stopsInTravelOrder, type BusOnRoute, type Vehicle } from "@figbloom/shared";

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
 * A lean native map for one bus (FIG-874): the bus, its route's stops in
 * order, and a straight line through them. Deliberately simpler than
 * web's LiveRouteMap — no Directions-API road-snapping, no satellite/traffic
 * toggle, no glide animation between pings — see MAPS.md.
 *
 * `follow` is for the driver's own screen (FIG-1293): the camera keeps the bus
 * in view as it moves, until the driver drags the map, and a button brings it back.
 * A family watching the bus pans for themselves, so they leave it off.
 */
export function BusMap({ bus, tint, height = 180, follow = false }: { bus: BusMapBus; tint: string; height?: number; follow?: boolean }) {
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
        pitchEnabled={false}
        toolbarEnabled={false}
        onPanDrag={follow ? () => setFollowing(false) : undefined}
      >
        {stops.length > 1 && (
          <Polyline coordinates={stops.map((s) => ({ latitude: s.lat, longitude: s.lng }))} strokeColor={tint} strokeWidth={4} />
        )}
        {stops.map((s, i) => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title={s.name} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff", borderWidth: 2, borderColor: tint, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 10, fontWeight: "700", color: tint }}>{i + 1}</Text>
            </View>
          </Marker>
        ))}
        {busPos && (
          <Marker coordinate={busPos} title={bus.vehicle.plate_number} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tint, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 13 }}>🚌</Text>
            </View>
          </Marker>
        )}
      </MapView>
      {follow && !following && !!busPos && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Follow the bus"
          onPress={() => setFollowing(true)}
          style={{ position: "absolute", right: 8, bottom: 8, minHeight: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", elevation: 3 }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Follow the bus</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
