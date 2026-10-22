import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { APIProvider, Map as GoogleMap, Marker, Polyline, useApiIsLoaded, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { activeDirections, distanceM, isLive, stopsInTravelOrder, subscribeVehiclePositions, type BusOnRoute, type RouteStop } from "@figbloom/shared";

/**
 * The Uber-style live map every role shares (driver, parent, admin, teacher):
 * routes drawn along real roads through their numbered stops, buses gliding
 * between position pings, and a slot (`children`) for each role's own bottom
 * sheet. Only discrete stops are stored, so the road path comes from the
 * Directions API — fetched once per route per browser and cached, not per ping.
 */

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

export type LatLng = { lat: number; lng: number };

/** False when there's no API key: the map area shows a notice, ETAs fall back to estimates. */
const MapsAvailable = createContext(false);

/** Muted base map so the route and buses carry the colour. */
const MAP_STYLES: google.maps.MapTypeStyle[] = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.school", stylers: [{ visibility: "on" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "geometry", stylers: [{ saturation: -45 }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

/** Other routes on a fleet map, so two routes never read as one line. */
export const ROUTE_COLORS = ["#2563AE", "#BC4A26", "#6443B5", "#9A5A08", "#0F766E", "#B4306A"];

const svg = (w: number, h: number, body: string) =>
  "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);

function busIcon(color: string, live: boolean): google.maps.Icon {
  const ring = live ? `<circle cx="22" cy="22" r="20" fill="${color}" fill-opacity="0.18"/>` : "";
  return {
    url: svg(44, 44, `${ring}<circle cx="22" cy="22" r="14" fill="${live ? color : "#8A938C"}" stroke="#fff" stroke-width="3"/>
      <rect x="15.5" y="15" width="13" height="11" rx="2.5" fill="#fff"/><rect x="17.5" y="17" width="9" height="4" rx="1" fill="${live ? color : "#8A938C"}"/>
      <circle cx="18.5" cy="27.5" r="1.6" fill="#fff"/><circle cx="25.5" cy="27.5" r="1.6" fill="#fff"/>`),
    anchor: new google.maps.Point(22, 22),
  };
}

function stopIcon(n: number, color: string, highlight: boolean): google.maps.Icon {
  if (highlight) {
    return {
      url: svg(34, 42, `<path d="M17 41 C17 41 3 26 3 16 A14 14 0 0 1 31 16 C31 26 17 41 17 41Z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
        <path d="M11 17.5 L17 12 L23 17.5 V23 H11Z" fill="#fff"/>`),
      anchor: new google.maps.Point(17, 41),
    };
  }
  return {
    url: svg(26, 26, `<circle cx="13" cy="13" r="10.5" fill="#fff" stroke="${color}" stroke-width="2.5"/>
      <text x="13" y="17.2" font-family="Figtree, Arial, sans-serif" font-size="11" font-weight="700" text-anchor="middle" fill="${color}">${n}</text>`),
    anchor: new google.maps.Point(13, 13),
  };
}

const SELF_ICON = () => ({
  url: svg(24, 24, `<circle cx="12" cy="12" r="10" fill="#2563EB" fill-opacity="0.2"/><circle cx="12" cy="12" r="6" fill="#2563EB" stroke="#fff" stroke-width="2.5"/>`),
  anchor: new google.maps.Point(12, 12),
});

// ---------------------------------------------------------------- live data

/** How often the maps re-check which way each bus is running. */
const DIRECTION_POLL_MS = 15_000;

/**
 * Buses, kept current: positions by Realtime as they're sent, and each
 * running trip's direction by polling, so a bus that turns round (a new trip
 * the other way) renumbers its stops and redraws its route within seconds.
 */
export function useLiveBuses(tenantId: string, initial: BusOnRoute[]): BusOnRoute[] {
  const [buses, setBuses] = useState(initial);
  useEffect(() => setBuses(initial), [initial]);
  useEffect(
    () => subscribeVehiclePositions(tenantId, (v) => setBuses((prev) => prev.map((b) => (b.vehicle.id === v.id ? { ...b, vehicle: { ...b.vehicle, ...v } } : b)))),
    [tenantId],
  );
  useEffect(() => {
    let alive = true;
    const check = () => void activeDirections().then((dirs) => {
      if (!alive) return;
      setBuses((prev) => (prev.some((b) => (dirs.get(b.vehicle.id) ?? null) !== b.direction)
        ? prev.map((b) => ({ ...b, direction: dirs.get(b.vehicle.id) ?? null }))
        : prev));
    }).catch(() => { /* keep the last known direction */ });
    const id = window.setInterval(check, DIRECTION_POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [tenantId]);
  return buses;
}

/** Re-renders every `ms`, so "live" and "updated 2 min ago" stay true without new data. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function busPosition(bus: BusOnRoute): LatLng | null {
  return bus.vehicle.last_lat != null && bus.vehicle.last_lng != null ? { lat: bus.vehicle.last_lat, lng: bus.vehicle.last_lng } : null;
}

export function fmtAgo(iso: string | null, now: number): string {
  if (!iso) return "No position yet";
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  return `Last seen ${new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

// ---------------------------------------------------------------- the map

export function LiveRouteMap({
  buses, selectedId, onSelect, highlightStopIds, colorFor, showAllStops, selfPos, accent = "#17402A", className = "", children,
}: {
  buses: BusOnRoute[];
  /** The bus whose route is drawn in colour with its stops; null shows every route equally. */
  selectedId: string | null;
  onSelect?: (vehicleId: string) => void;
  /** e.g. a parent's children's stops — drawn as pins instead of numbers. */
  highlightStopIds?: string[];
  /** Give each bus (its marker, route and stops) its own colour, e.g. one per child's bus. */
  colorFor?: (vehicleId: string) => string;
  /** Number every route's stops, not just the selected bus's — for a handful of buses, not a fleet. */
  showAllStops?: boolean;
  /** The driver's own GPS fix, drawn over their bus so it moves with every fix, not every ping. */
  selfPos?: LatLng | null;
  accent?: string;
  className?: string;
  /** Overlays (bottom sheet, buttons), rendered inside the maps context so they can use <Eta>. */
  children?: ReactNode;
}) {
  const [view, setView] = useMapView();
  if (!GOOGLE_MAPS_API_KEY) {
    return (
      <MapsAvailable.Provider value={false}>
        <div className={`relative overflow-hidden bg-sunken ${className}`}>
          <div className="grid h-full place-items-center px-6 pb-40 text-center">
            <p className="max-w-[320px] text-[12.5px] leading-relaxed text-ink-muted">
              The live map needs a Google Maps API key. Set <code className="font-mono">VITE_GOOGLE_MAPS_API_KEY</code> in .env, then reload.
            </p>
          </div>
          {children}
        </div>
      </MapsAvailable.Provider>
    );
  }

  return (
    <MapsAvailable.Provider value={true}>
      <APIProvider apiKey={GOOGLE_MAPS_API_KEY}>
        <div className={`relative overflow-hidden ${className}`}>
          <MapLayers {...{ buses, selectedId, onSelect, highlightStopIds, colorFor, showAllStops, selfPos, accent, view }} />
          <MapViewControls view={view} onChange={setView} />
          {children}
        </div>
      </APIProvider>
    </MapsAvailable.Provider>
  );
}

type LayerProps = {
  buses: BusOnRoute[]; selectedId: string | null; onSelect?: (id: string) => void;
  highlightStopIds?: string[]; colorFor?: (vehicleId: string) => string; showAllStops?: boolean;
  selfPos?: LatLng | null; accent: string;
};

function MapLayers({ view, ...rest }: LayerProps & { view: MapView }) {
  // The marker icons need google.maps.Point, which only exists once the script has loaded.
  if (!useApiIsLoaded()) return null;
  return (
    <LoadedMapLayers {...rest}>
      <ApplyView view={view} />
    </LoadedMapLayers>
  );
}

// ---------------------------------------------------------------- map views

export interface MapView { base: "map" | "satellite"; traffic: boolean }

/** Remembered per browser, so a parent who likes traffic on keeps it on. */
function useMapView(): [MapView, (v: MapView) => void] {
  const [view, setView] = useState<MapView>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fb-map-view") ?? "null") as MapView | null;
      if (saved && (saved.base === "map" || saved.base === "satellite")) return { base: saved.base, traffic: !!saved.traffic };
    } catch {
      // unreadable or blocked storage: defaults
    }
    return { base: "map", traffic: false };
  });
  const save = (v: MapView) => {
    setView(v);
    try { localStorage.setItem("fb-map-view", JSON.stringify(v)); } catch { /* not remembered, still applied */ }
  };
  return [view, save];
}

/** Satellite (with labels) or the muted road map, plus Google's live traffic overlay. */
function ApplyView({ view }: { view: MapView }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    map.setMapTypeId(view.base === "satellite" ? "hybrid" : "roadmap");
    map.setOptions({ styles: view.base === "satellite" ? null : MAP_STYLES });
  }, [map, view.base]);
  useEffect(() => {
    if (!map || !view.traffic) return;
    const layer = new google.maps.TrafficLayer();
    layer.setMap(map);
    return () => layer.setMap(null);
  }, [map, view.traffic]);
  return null;
}

function MapViewControls({ view, onChange }: { view: MapView; onChange: (v: MapView) => void }) {
  const pill = (on: boolean) =>
    `px-3 py-1.5 text-[12px] font-semibold transition-colors ${on ? "bg-ink text-white" : "text-ink hover:bg-page"}`;
  return (
    <div className="absolute right-3 top-3 z-10 flex gap-2">
      <div className="flex overflow-hidden rounded-full bg-white shadow-md ring-1 ring-black/5">
        <button type="button" aria-pressed={view.base === "map"} className={pill(view.base === "map")} onClick={() => onChange({ ...view, base: "map" })}>
          Map
        </button>
        <button type="button" aria-pressed={view.base === "satellite"} className={pill(view.base === "satellite")} onClick={() => onChange({ ...view, base: "satellite" })}>
          Satellite
        </button>
      </div>
      <button
        type="button"
        aria-pressed={view.traffic}
        onClick={() => onChange({ ...view, traffic: !view.traffic })}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold shadow-md ring-1 ring-black/5 transition-colors ${view.traffic ? "bg-ink text-white" : "bg-white text-ink hover:bg-page"}`}
      >
        <span className="flex gap-0.5" aria-hidden>
          <span className="h-1.5 w-1.5 rounded-full bg-[#2EA45A]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[#F2A516]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[#D93A2B]" />
        </span>
        Traffic
      </button>
    </div>
  );
}

function LoadedMapLayers({ buses, selectedId, onSelect, highlightStopIds = [], colorFor, showAllStops, selfPos, accent, children }: LayerProps & { children?: ReactNode }) {
  const now = useNow();
  const colorOf = (b: BusOnRoute) => colorFor?.(b.vehicle.id) ?? accent;
  const selected = buses.find((b) => b.vehicle.id === selectedId) ?? null;
  // Each route drawn once, even if two buses share it.
  const routes = useMemo(() => {
    const m = new Map<string, BusOnRoute>();
    for (const b of buses) if (b.route && b.stops.length > 1 && !m.has(b.route.id)) m.set(b.route.id, b);
    return [...m.values()];
  }, [buses]);
  const center = (selected && busPosition(selected)) ?? selected?.stops[0] ?? buses.map(busPosition).find(Boolean) ?? buses.find((b) => b.stops[0])?.stops[0] ?? { lat: -1.2864, lng: 36.8172 };

  return (
    <GoogleMap
      defaultCenter={{ lat: center.lat, lng: center.lng }}
      defaultZoom={13}
      gestureHandling="greedy"
      disableDefaultUI
      zoomControl
      clickableIcons={false}
      style={{ width: "100%", height: "100%" }}
    >
      {children}
      <FitOnce buses={selected ? [selected] : buses} selfPos={selfPos ?? null} />
      {routes.map((b, i) => {
        const dim = !!selected && selected.route?.id !== b.route!.id;
        return (
          // drawn the way the bus is going: the return trip often takes other roads (one-ways, U-turns)
          <RoutePath key={`${b.route!.id}-${b.direction ?? "seq"}`} routeId={b.route!.id} stops={stopsInTravelOrder(b.stops, b.direction)}
            color={colorFor ? colorOf(b) : dim ? ROUTE_COLORS[i % ROUTE_COLORS.length]! : accent} dim={dim} />
        );
      })}
      {(showAllStops ? buses : selected ? [selected] : buses.length === 1 ? buses : []).map((b) =>
        stopsInTravelOrder(b.stops, b.direction).map((s, i) => {
          const pin = highlightStopIds.includes(s.id);
          return (
            <Marker key={`${b.vehicle.id}-${s.id}`} position={{ lat: s.lat, lng: s.lng }} title={s.name} zIndex={pin ? 30 : 10}
              icon={stopIcon(i + 1, colorOf(b), pin)} />
          );
        }),
      )}
      {buses.map((b) => {
        const pos = selfPos && b.vehicle.id === selectedId ? selfPos : busPosition(b);
        return pos ? (
          <BusMarker key={b.vehicle.id} target={pos} live={!!selfPos && b.vehicle.id === selectedId ? true : isLive(b.vehicle.last_ping_at, now)}
            color={colorOf(b)} title={b.vehicle.plate_number} onClick={onSelect ? () => onSelect(b.vehicle.id) : undefined} />
        ) : null;
      })}
      {selfPos && !selectedId && <Marker position={selfPos} icon={SELF_ICON()} title="You" zIndex={40} />}
    </GoogleMap>
  );
}

/** Frames the buses and their stops once, on first render — after that the camera is the viewer's. */
function FitOnce({ buses, selfPos }: { buses: BusOnRoute[]; selfPos: LatLng | null }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (!map || done.current) return;
    const pts: LatLng[] = [...buses.flatMap((b) => [busPosition(b), ...b.stops].filter((p): p is LatLng => !!p)), ...(selfPos ? [selfPos] : [])];
    if (!pts.length) return;
    done.current = true;
    if (pts.length === 1) { map.setCenter(pts[0]!); map.setZoom(15); return; }
    const bounds = new google.maps.LatLngBounds();
    for (const p of pts) bounds.extend(p);
    // leave room at the bottom for the sheet
    map.fitBounds(bounds, { top: 60, left: 40, right: 40, bottom: 240 });
  }, [map, buses, selfPos]);
  return null;
}

/**
 * A bus marker that glides to each new position instead of jumping. The glide
 * lasts about as long as the gap between updates (4s from the simulator, ~10s
 * from a phone), so the bus is always moving rather than hopping then waiting.
 */
function BusMarker({ target, live, color, title, onClick }: { target: LatLng; live: boolean; color: string; title: string; onClick?: () => void }) {
  const [pos, setPos] = useState(target);
  const from = useRef(target);
  const lastUpdate = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const gap = lastUpdate.current == null ? 0 : start - lastUpdate.current;
    lastUpdate.current = start;
    // first fix, or a jump of more than a couple of km (a new trip): place it, don't slide across town
    const duration = gap === 0 || distanceM(from.current, target) > 2000 ? 0 : Math.min(Math.max(gap, 800), 12_000);
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = duration === 0 ? 1 : Math.min(1, (t - start) / duration);
      // linear: constant speed between fixes, like a vehicle, not ease-in-out hops
      const e = k;
      const p = { lat: a.lat + (target.lat - a.lat) * e, lng: a.lng + (target.lng - a.lng) * e };
      from.current = p;
      setPos(p);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target.lat, target.lng]); // eslint-disable-line react-hooks/exhaustive-deps -- re-run per new position, not per object
  return <Marker position={pos} icon={busIcon(color, live)} title={title} zIndex={50} onClick={onClick} />;
}

// ---------------------------------------------------------------- road path, cached

const pathCache = new Map<string, LatLng[]>();

function pathKey(routeId: string, stops: RouteStop[]) {
  return `fb-route:${routeId}:${stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join("|")}`;
}

function readCached(key: string): LatLng[] | null {
  const mem = pathCache.get(key);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const path = (JSON.parse(raw) as [number, number][]).map(([lat, lng]) => ({ lat, lng }));
    pathCache.set(key, path);
    return path;
  } catch {
    return null;
  }
}

function writeCached(key: string, path: LatLng[]) {
  pathCache.set(key, path);
  try {
    localStorage.setItem(key, JSON.stringify(path.map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5)])));
  } catch {
    // storage full or blocked: the in-memory copy still saves repeat calls this session
  }
}

/** A route through its stops along real roads (Directions API), or straight lines if that's unavailable. */
function RoutePath({ routeId, stops, color, dim }: { routeId: string; stops: RouteStop[]; color: string; dim: boolean }) {
  const routesLib = useMapsLibrary("routes");
  const key = pathKey(routeId, stops);
  const straight = useMemo(() => stops.map((s) => ({ lat: s.lat, lng: s.lng })), [stops]);
  const [path, setPath] = useState<LatLng[] | null>(() => readCached(key));

  useEffect(() => {
    const cached = readCached(key);
    if (cached) { setPath(cached); return; }
    setPath(null);
    // Directions allows 25 waypoints; a longer route just draws straight between stops.
    if (!routesLib || stops.length < 2 || stops.length > 27) return;
    let alive = true;
    new routesLib.DirectionsService()
      .route({
        origin: straight[0]!,
        destination: straight.at(-1)!,
        waypoints: straight.slice(1, -1).map((location) => ({ location, stopover: true })),
        travelMode: google.maps.TravelMode.DRIVING,
      })
      .then((res) => {
        const p = res.routes[0]?.overview_path.map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
        if (alive && p?.length) { writeCached(key, p); setPath(p); }
      })
      .catch(() => { /* Directions not enabled or over quota: straight lines below */ });
    return () => { alive = false; };
  }, [routesLib, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const line = path ?? straight;
  return (
    <>
      {/* a white casing under the line, like a road highlight */}
      <Polyline path={line} strokeColor="#ffffff" strokeOpacity={dim ? 0.5 : 0.95} strokeWeight={dim ? 6 : 9} zIndex={1} />
      <Polyline path={line} strokeColor={color} strokeOpacity={dim ? 0.55 : 0.95} strokeWeight={dim ? 4 : 5} zIndex={dim ? 1 : 2} />
    </>
  );
}

// ---------------------------------------------------------------- ETA

export type EtaResult = { minutes: number; km: number; estimated: boolean };

/** A rough ETA when Directions isn't available: road distance ~1.3x straight-line, at 25 km/h in town. */
function roughEta(from: LatLng, to: LatLng): EtaResult {
  const km = (distanceM(from, to) * 1.3) / 1000;
  return { minutes: Math.max(1, Math.round((km / 25) * 60)), km, estimated: true };
}

type EtaProps = { from: LatLng | null; to: LatLng | null; children: (eta: EtaResult | null) => ReactNode };

/**
 * Drive time from `from` to `to`, handed to `children`. Real road time from
 * Directions when the map is loaded, a rough estimate otherwise. Must sit
 * inside <LiveRouteMap> (pass it as one of its children).
 */
export function Eta(props: EtaProps) {
  return useContext(MapsAvailable) ? <GoogleEta {...props} /> : <>{props.children(props.from && props.to ? roughEta(props.from, props.to) : null)}</>;
}

function GoogleEta({ from, to, children }: EtaProps) {
  return <>{children(useGoogleEta(from, to))}</>;
}

/**
 * Asks Directions at most once a minute, or sooner if the bus has moved 300m
 * or the destination changed, so a bus pinging every 10s doesn't cost a
 * Directions call each time.
 */
function useGoogleEta(from: LatLng | null, to: LatLng | null): EtaResult | null {
  const routesLib = useMapsLibrary("routes");
  const [eta, setEta] = useState<EtaResult | null>(null);
  const last = useRef<{ at: number; from: LatLng; to: LatLng } | null>(null);

  useEffect(() => {
    if (!from || !to) { setEta(null); last.current = null; return; }
    const prev = last.current;
    const fresh = prev && Date.now() - prev.at < 60_000 && distanceM(prev.from, from) < 300 && distanceM(prev.to, to) < 10;
    if (fresh) return;
    if (!routesLib) { setEta(roughEta(from, to)); return; }
    last.current = { at: Date.now(), from, to };
    let alive = true;
    new routesLib.DirectionsService()
      .route({ origin: from, destination: to, travelMode: google.maps.TravelMode.DRIVING })
      .then((res) => {
        const leg = res.routes[0]?.legs[0];
        if (alive && leg?.duration && leg.distance) {
          setEta({ minutes: Math.max(1, Math.round(leg.duration.value / 60)), km: leg.distance.value / 1000, estimated: false });
        }
      })
      .catch(() => { if (alive) setEta(roughEta(from, to)); });
    return () => { alive = false; };
  }, [routesLib, from?.lat, from?.lng, to?.lat, to?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return eta;
}

export function fmtEta(eta: EtaResult | null): string {
  if (!eta) return "—";
  return `${eta.estimated ? "~" : ""}${eta.minutes} min`;
}

// ---------------------------------------------------------------- sheet

/** The bottom sheet over the map — full width on a phone, a floating card on a wide screen. */
export function MapSheet({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`pointer-events-auto absolute inset-x-3 bottom-3 z-10 max-h-[70%] overflow-y-auto rounded-2xl bg-white p-4 shadow-[0_8px_30px_rgba(0,0,0,0.16)] ring-1 ring-black/5 md:inset-x-auto md:left-4 md:w-[380px] ${className}`}>
      {children}
    </div>
  );
}

export function LiveDot({ live }: { live: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: live ? "#1F7A3E" : "#6B746D" }}>
      <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse" : ""}`} style={{ background: live ? "#2EA45A" : "#A3ABA5" }} />
      {live ? "Live" : "Not on the road"}
    </span>
  );
}
