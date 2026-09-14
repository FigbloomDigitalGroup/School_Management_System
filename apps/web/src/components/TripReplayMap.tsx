import { useEffect, useMemo, useState } from "react";
import { APIProvider, Map as GoogleMap, Marker, Polyline, useMap } from "@vis.gl/react-google-maps";
import type { TripPoint } from "@figbloom/shared";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

/** Recenters once, on the path itself, rather than fighting the scrub marker for the camera. */
function FitToPath({ path }: { path: TripPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || path.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of path) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, path.length]);
  return null;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A trip's recorded path, scrubbable — drag the slider to move the marker point by point. */
export function TripReplayMap({ path }: { path: TripPoint[] }) {
  const [i, setI] = useState(0);

  useEffect(() => { setI(0); }, [path]);

  const linePath = useMemo(() => path.map((p) => ({ lat: p.lat, lng: p.lng })), [path]);
  const at = path[i];

  if (!GOOGLE_MAPS_API_KEY) {
    return (
      <div className="grid h-[280px] place-items-center rounded-lg border border-line bg-sunken px-6 text-center">
        <p className="max-w-[320px] text-[12.5px] leading-relaxed text-ink-muted">
          The replay map needs a Google Maps API key. Set <code className="font-mono">VITE_GOOGLE_MAPS_API_KEY</code>.
        </p>
      </div>
    );
  }

  if (path.length === 0) {
    return (
      <div className="grid h-[280px] place-items-center rounded-lg border border-line bg-sunken px-6 text-center">
        <p className="max-w-[300px] text-[12.5px] leading-relaxed text-ink-muted">
          No location pings were recorded for this trip.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-2.5">
      <div className="relative overflow-hidden rounded-lg border border-line" style={{ height: 320 }}>
        <APIProvider apiKey={GOOGLE_MAPS_API_KEY}>
          <GoogleMap
            defaultCenter={{ lat: path[0]!.lat, lng: path[0]!.lng }}
            defaultZoom={13}
            gestureHandling="cooperative"
            style={{ width: "100%", height: "100%" }}
          >
            <FitToPath path={path} />
            <Polyline path={linePath} strokeColor="#17402A" strokeOpacity={0.85} strokeWeight={4} />
            <Marker position={linePath[0]!} label={{ text: "S", color: "#fff" }} title="Trip start" />
            <Marker position={linePath.at(-1)!} label={{ text: "E", color: "#fff" }} title="Trip end" />
            {at && (
              <Marker
                position={{ lat: at.lat, lng: at.lng }}
                icon={{ url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
                  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="9" fill="#B5541A" stroke="#fff" stroke-width="3"/></svg>`,
                ) }}
              />
            )}
          </GoogleMap>
        </APIProvider>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range" min={0} max={Math.max(path.length - 1, 0)} value={i}
          onChange={(e) => setI(Number(e.target.value))}
          aria-label="Scrub through the trip"
          className="flex-1"
        />
        <span className="w-16 shrink-0 text-right font-mono text-[12px] text-ink-muted">{i + 1}/{path.length}</span>
      </div>

      {at && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-page px-3.5 py-2.5 text-[12.5px]">
          <span><span className="text-ink-faint">Time</span> <span className="font-mono">{fmtTime(at.recorded_at)}</span></span>
          <span><span className="text-ink-faint">Speed</span> <span className="font-mono">{at.speed_kmh != null ? `${Math.round(at.speed_kmh)} km/h` : "—"}</span></span>
          <span><span className="text-ink-faint">Position</span> <span className="font-mono">{at.lat.toFixed(4)}, {at.lng.toFixed(4)}</span></span>
        </div>
      )}
    </div>
  );
}
