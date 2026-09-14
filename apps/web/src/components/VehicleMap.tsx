import { useEffect, useMemo, useState } from "react";
import { APIProvider, InfoWindow, Map as GoogleMap, Marker, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import type { Vehicle } from "@figbloom/shared";
import { subscribeVehiclePositions } from "@figbloom/shared";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

type LatLng = { lat: number; lng: number };

/** A colored-circle bus glyph, encoded as an inline SVG data URL — no image asset to bundle. */
const BUS_ICON_URL =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34">
      <circle cx="17" cy="17" r="15" fill="#17402A" stroke="#fff" stroke-width="2"/>
      <text x="17" y="23" font-size="16" text-anchor="middle">\u{1F68C}</text>
    </svg>`,
  );

/** The viewer's own position, when they've opted into "Route to me". */
const YOU_ICON_URL =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">
      <circle cx="11" cy="11" r="9" fill="#2563EB" stroke="#fff" stroke-width="3"/>
    </svg>`,
  );

/** A fixed stop, when routing to it instead of the viewer's own location. */
const STOP_ICON_URL =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">
      <circle cx="13" cy="13" r="11" fill="#B5541A" stroke="#fff" stroke-width="3"/>
      <text x="13" y="18" font-size="13" text-anchor="middle">\u{1F3E0}</text>
    </svg>`,
  );

function fmtSeen(iso: string | null): string {
  if (!iso) return "";
  return `Updated ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Keeps the camera on a moving vehicle so it never drifts off-screen — only active while `enabled`. */
function FollowCamera({ position, enabled }: { position: LatLng | null; enabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (map && enabled && position) map.panTo(position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, position?.lat, position?.lng]);
  return null;
}

/** A real driven route + ETA from the vehicle to the viewer, via the Directions API — a separate API from the map display, enabled per-project in Google Cloud Console. */
function DirectionsLayer({
  origin, destination, onResult,
}: {
  origin: LatLng | null; destination: LatLng | null; onResult: (r: { distance: string; duration: string } | { error: string } | null) => void;
}) {
  const map = useMap();
  const routesLibrary = useMapsLibrary("routes");
  const [service, setService] = useState<google.maps.DirectionsService | null>(null);
  const [renderer, setRenderer] = useState<google.maps.DirectionsRenderer | null>(null);

  useEffect(() => {
    if (!routesLibrary || !map) return;
    setService(new routesLibrary.DirectionsService());
    const r = new routesLibrary.DirectionsRenderer({ map, suppressMarkers: true, polylineOptions: { strokeColor: "#2563EB", strokeWeight: 4 } });
    setRenderer(r);
    return () => r.setMap(null);
  }, [routesLibrary, map]);

  useEffect(() => {
    if (!service || !renderer) return;
    if (!origin || !destination) { renderer.setMap(null); onResult(null); return; }
    renderer.setMap(map);
    service
      .route({ origin, destination, travelMode: google.maps.TravelMode.DRIVING })
      .then((res) => {
        renderer.setDirections(res);
        const leg = res.routes[0]?.legs[0];
        onResult(leg?.distance && leg.duration ? { distance: leg.distance.text, duration: leg.duration.text } : null);
      })
      .catch(() => onResult({ error: "Couldn't get directions — check the Directions API is enabled for this project." }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, renderer, origin?.lat, origin?.lng, destination?.lat, destination?.lng, map]);

  return null;
}

export function VehicleMap({
  tenantId, vehicles, homeStop,
}: {
  tenantId: string; vehicles: Vehicle[];
  /** A fixed point to offer routing to besides the viewer's live location — typically the child's own boarding stop, since a parent watching from work isn't standing where the route ends. */
  homeStop?: { name: string; lat: number; lng: number } | null;
}) {
  const [byId, setById] = useState<Map<string, Vehicle>>(() => new Map(vehicles.map((v) => [v.id, v])));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [routeTarget, setRouteTarget] = useState<"me" | "stop" | null>(null);
  const [viewerPos, setViewerPos] = useState<LatLng | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | { error: string } | null>(null);

  // A fresh fetch (e.g. after adding a vehicle) should replace the map's view of the world.
  useEffect(() => {
    setById(new Map(vehicles.map((v) => [v.id, v])));
  }, [vehicles]);

  // Live updates on top of that, via Realtime — see apps/web/src/lib/fleet.ts.
  useEffect(() => {
    return subscribeVehiclePositions(tenantId, (updated) => {
      setById((prev) => {
        const next = new Map(prev);
        next.set(updated.id, updated);
        return next;
      });
    });
  }, [tenantId]);

  // Share-my-location is opt-in — only asked for once "Route to me" is switched on.
  useEffect(() => {
    if (routeTarget !== "me") { setViewerPos(null); setViewerError(null); return; }
    if (!("geolocation" in navigator)) { setViewerError("This browser can't share your location."); return; }
    setViewerError(null);
    const watchId = navigator.geolocation.watchPosition(
      (pos) => setViewerPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setViewerError(err.message || "Location permission was denied."),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [routeTarget]);

  const located = useMemo(
    () => [...byId.values()].filter((v): v is Vehicle & { last_lat: number; last_lng: number } => v.last_lat != null && v.last_lng != null),
    [byId],
  );

  if (!GOOGLE_MAPS_API_KEY) {
    return (
      <div className="grid h-[280px] place-items-center rounded-lg border border-line bg-sunken px-6 text-center">
        <p className="max-w-[320px] text-[12.5px] leading-relaxed text-ink-muted">
          The live map needs a Google Maps API key. Set <code className="font-mono">VITE_GOOGLE_MAPS_API_KEY</code> in
          the project's .env file, then reload.
        </p>
      </div>
    );
  }

  const first = located[0];
  if (!first) {
    return (
      <div className="grid h-[280px] place-items-center rounded-lg border border-line bg-sunken px-6 text-center">
        <p className="max-w-[300px] text-[12.5px] leading-relaxed text-ink-muted">
          No vehicle is reporting a position yet. Once a driver starts a trip from their own page, it appears here live —
          no refresh needed.
        </p>
      </div>
    );
  }

  // With one vehicle (the common case: a parent watching their child's bus) it's
  // auto-selected — no click needed before Follow/Route-to-me work.
  const activeId = selectedId ?? (located.length === 1 ? first.id : null);
  const active = activeId ? (located.find((v) => v.id === activeId) ?? null) : null;
  const activePos = active ? { lat: active.last_lat, lng: active.last_lng } : null;
  const selected = located.find((v) => v.id === selectedId) ?? null;

  const destination: LatLng | null =
    routeTarget === "me" ? viewerPos : routeTarget === "stop" && homeStop ? { lat: homeStop.lat, lng: homeStop.lng } : null;

  return (
    <div className="relative overflow-hidden rounded-lg border border-line" style={{ height: 360 }}>
      <APIProvider apiKey={GOOGLE_MAPS_API_KEY}>
        <GoogleMap
          defaultCenter={{ lat: first.last_lat, lng: first.last_lng }}
          defaultZoom={13}
          gestureHandling="cooperative"
          disableDefaultUI={false}
          style={{ width: "100%", height: "100%" }}
        >
          {located.map((v) => (
            <Marker
              key={v.id}
              position={{ lat: v.last_lat, lng: v.last_lng }}
              icon={{ url: BUS_ICON_URL }}
              onClick={() => setSelectedId(v.id)}
            />
          ))}
          {viewerPos && <Marker position={viewerPos} icon={{ url: YOU_ICON_URL }} title="You" />}
          {routeTarget === "stop" && homeStop && (
            <Marker position={{ lat: homeStop.lat, lng: homeStop.lng }} icon={{ url: STOP_ICON_URL }} title={homeStop.name} />
          )}
          {selected && (
            <InfoWindow position={{ lat: selected.last_lat, lng: selected.last_lng }} onCloseClick={() => setSelectedId(null)}>
              <div className="text-[12.5px]">
                <div className="font-semibold">{selected.plate_number}</div>
                {selected.make_model && <div className="text-ink-muted">{selected.make_model}</div>}
                <div className="mt-1 text-ink-faint">{fmtSeen(selected.last_ping_at)}</div>
              </div>
            </InfoWindow>
          )}
          <FollowCamera position={activePos} enabled={following} />
          {routeTarget && <DirectionsLayer origin={activePos} destination={destination} onResult={setRouteInfo} />}
        </GoogleMap>
      </APIProvider>

      <div className="pointer-events-none absolute right-2 top-2 flex max-w-[280px] flex-col items-end gap-1.5">
        <div className="pointer-events-auto flex flex-wrap justify-end gap-1.5 rounded-lg bg-white/95 p-1.5 shadow-sm ring-1 ring-line">
          <button
            onClick={() => setFollowing((f) => !f)}
            disabled={!active}
            className="rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold disabled:opacity-40"
            style={{ background: following ? "var(--accent-deep)" : "#EEF1EE", color: following ? "#fff" : "#3A423C" }}
          >
            {following ? "Following" : "Follow"}
          </button>
          <button
            onClick={() => setRouteTarget((t) => (t === "me" ? null : "me"))}
            disabled={!active}
            className="rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold disabled:opacity-40"
            style={{ background: routeTarget === "me" ? "var(--accent-deep)" : "#EEF1EE", color: routeTarget === "me" ? "#fff" : "#3A423C" }}
          >
            Route to me
          </button>
          {homeStop && (
            <button
              onClick={() => setRouteTarget((t) => (t === "stop" ? null : "stop"))}
              disabled={!active}
              className="rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold disabled:opacity-40"
              style={{ background: routeTarget === "stop" ? "var(--accent-deep)" : "#EEF1EE", color: routeTarget === "stop" ? "#fff" : "#3A423C" }}
            >
              Route to stop
            </button>
          )}
        </div>
        {!active && located.length > 1 && (
          <div className="pointer-events-auto rounded-lg bg-white/95 px-2.5 py-1.5 text-right text-[11px] text-ink-muted shadow-sm ring-1 ring-line">
            Tap a bus to follow it
          </div>
        )}
        {routeTarget === "me" && viewerError && (
          <div className="pointer-events-auto rounded-lg bg-white/95 px-2.5 py-1.5 text-right text-[11px] text-warn-ink shadow-sm ring-1 ring-line">
            {viewerError}
          </div>
        )}
        {routeTarget === "me" && !viewerError && !viewerPos && (
          <div className="pointer-events-auto rounded-lg bg-white/95 px-2.5 py-1.5 text-right text-[11px] text-ink-muted shadow-sm ring-1 ring-line">
            Finding you…
          </div>
        )}
        {routeTarget && routeInfo && "error" in routeInfo && (
          <div className="pointer-events-auto rounded-lg bg-white/95 px-2.5 py-1.5 text-right text-[11px] text-warn-ink shadow-sm ring-1 ring-line">
            {routeInfo.error}
          </div>
        )}
        {routeTarget && routeInfo && "duration" in routeInfo && (
          <div className="pointer-events-auto rounded-lg bg-white/95 px-2.5 py-1.5 text-right shadow-sm ring-1 ring-line">
            <div className="text-[13px] font-semibold" style={{ color: "var(--accent-deep)" }}>{routeInfo.duration}</div>
            <div className="text-[11px] text-ink-faint">
              {routeInfo.distance} to {routeTarget === "me" ? "you" : (homeStop?.name ?? "the stop")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
