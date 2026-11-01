import { useMemo } from "react";
import { Text, View } from "react-native";
import { fmtDistance, fmtEta, roughEta, routeProgress, stopsInTravelOrder, type RouteStop, type TripDirection } from "@figbloom/shared";
import { BusMap } from "../../components/BusMap";
import { useRouteTrace } from "../../lib/useRouteTrace";
import { useTheme } from "../../ui/ThemeContext";

/**
 * The driver's route on a map with their own bus following their GPS, and under it the next
 * stop and the time to get there: what the web driver screen shows (apps/web/src/screens/driver/Trip.tsx).
 * The time is a guess from the straight-line distance, marked "~" — the phone has no
 * Directions service to ask, and the web falls back to the same guess without a maps key.
 * `pos` is the latest GPS fix, whether or not it has reached the server yet.
 */
export function TripMap({ direction, stops, plate, pos, tint }: {
  direction: TripDirection;
  stops: RouteStop[];
  plate: string;
  pos: { lat: number; lng: number } | null;
  tint: string;
}) {
  const { t, s, accentInk } = useTheme();
  const ordered = useMemo(() => stopsInTravelOrder(stops, direction), [stops, direction]);
  const path = useRouteTrace(stops);
  if (!ordered.length && !pos) return null;

  const progress = pos ? routeProgress(ordered, pos) : null;
  const nextIndex = progress?.nextIndex ?? null;
  const next = pos && nextIndex != null ? ordered[nextIndex] ?? null : null;
  const eta = pos && next ? roughEta(pos, next) : null;
  const offRouteM = progress?.offRouteM ?? null;

  return (
    <View style={{ marginTop: 16 }} accessibilityLabel="Route map">
      <BusMap
        bus={{ stops, direction, vehicle: { plate_number: plate, last_lat: pos?.lat ?? null, last_lng: pos?.lng ?? null } }}
        tint={tint}
        height={240}
        follow
        path={path}
      />
      {next ? (
        <View style={[s.card, { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>
              {offRouteM != null ? `HEAD TO THE ROUTE · ${fmtDistance(offRouteM)} AWAY` : `NEXT STOP · ${(nextIndex ?? 0) + 1} OF ${ordered.length}`}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "600", color: t.appSurface.ink, marginTop: 2 }}>{next.name}</Text>
          </View>
          <Text accessibilityLabel={eta ? `About ${eta.minutes} minutes to the next stop` : undefined} style={{ fontSize: 22, fontWeight: "700", color: accentInk(tint) }}>
            {fmtEta(eta)}
          </Text>
        </View>
      ) : (
        !!ordered.length && (
          <Text style={[s.small, { marginTop: 8 }]}>
            {pos ? "Last stop reached. End the trip when everyone is off." : "Waiting for the first location fix…"}
          </Text>
        )
      )}
    </View>
  );
}
