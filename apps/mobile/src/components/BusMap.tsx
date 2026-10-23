import { useMemo } from "react";
import { Text, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import { stopsInTravelOrder, type BusOnRoute } from "@figbloom/shared";

interface LatLng { latitude: number; longitude: number }

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
 * A lean native map for one child's bus (FIG-874): the bus, its route's stops
 * in order, and a straight line through them. Deliberately simpler than
 * web's LiveRouteMap — no Directions-API road-snapping, no satellite/traffic
 * toggle, no glide animation between pings — see MAPS.md.
 */
export function BusMap({ bus, tint, height = 180 }: { bus: BusOnRoute; tint: string; height?: number }) {
  const stops = stopsInTravelOrder(bus.stops, bus.direction);
  const busPos: LatLng | null =
    bus.vehicle.last_lat != null && bus.vehicle.last_lng != null
      ? { latitude: bus.vehicle.last_lat, longitude: bus.vehicle.last_lng }
      : null;

  // Computed once from the first fix: the camera is the viewer's to pan after that,
  // not recentred under them every time a new ping moves the bus marker.
  const initialRegion = useMemo(() => {
    const points: LatLng[] = [...stops.map((s) => ({ latitude: s.lat, longitude: s.lng })), ...(busPos ? [busPos] : [])];
    return points.length ? regionFor(points) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only the mount-time fix
  }, []);

  if (!initialRegion) return null;

  return (
    <View style={{ height, borderRadius: 12, overflow: "hidden" }}>
      <MapView style={{ flex: 1 }} initialRegion={initialRegion} pitchEnabled={false} toolbarEnabled={false}>
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
    </View>
  );
}
