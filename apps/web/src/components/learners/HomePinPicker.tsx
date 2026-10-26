import { useEffect, useState } from "react";
import { APIProvider, Map as GoogleMap, Marker, useApiIsLoaded, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import type { LatLngPoint } from "@figbloom/shared";

/**
 * A small map for placing a learner's home: click (or drag the pin) to set
 * it. "Find on map" looks the typed address up with the Maps JavaScript
 * Geocoder, which needs the Geocoding API enabled on the browser key (see
 * MAPS.md). Without it the search says so and clicking the map still works;
 * without a key at all, the pin can't be placed and the address is kept as text.
 */

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

/** Where the map opens with nothing to show: central Nairobi. */
const DEFAULT_CENTER = { lat: -1.2864, lng: 36.8172 };

export function mapsConfigured(): boolean {
  return !!GOOGLE_MAPS_API_KEY;
}

export function HomePinPicker({ pin, onPin, address, nearby = [], className = "h-[220px]" }: {
  pin: LatLngPoint | null;
  onPin: (p: LatLngPoint | null) => void;
  /** What "Find on map" looks up. */
  address: string;
  /** Bus stops to show for context (grey dots), e.g. every stop in the school. */
  nearby?: (LatLngPoint & { name: string })[];
  className?: string;
}) {
  if (!GOOGLE_MAPS_API_KEY) {
    return (
      <p className="rounded-md border border-line-soft bg-page px-3 py-2.5 text-[12px] leading-relaxed text-ink-muted">
        The map needs a Google Maps key (<code className="font-mono">VITE_GOOGLE_MAPS_API_KEY</code>), so the home can't be pinned here yet.
        The address is still saved, and the pin can be added later.
      </p>
    );
  }
  return (
    <APIProvider apiKey={GOOGLE_MAPS_API_KEY}>
      <PickerBody pin={pin} onPin={onPin} address={address} nearby={nearby} className={className} />
    </APIProvider>
  );
}

function PickerBody({ pin, onPin, address, nearby, className }: {
  pin: LatLngPoint | null; onPin: (p: LatLngPoint | null) => void; address: string;
  nearby: (LatLngPoint & { name: string })[]; className: string;
}) {
  const geocoding = useMapsLibrary("geocoding");
  const [finding, setFinding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLngPoint | null>(null);

  async function find() {
    const q = address.trim();
    if (!q) { setNote("Type the address first."); return; }
    if (!geocoding) { setNote("Address search isn't available yet. Click the map to place the pin."); return; }
    setFinding(true);
    setNote(null);
    try {
      const res = await new geocoding.Geocoder().geocode({ address: q, region: "ke" });
      const loc = res.results[0]?.geometry.location;
      if (!loc) { setNote("Couldn't find that address. Click the map to place the pin instead."); return; }
      const p = { lat: loc.lat(), lng: loc.lng() };
      onPin(p);
      setFocus(p);
      setNote("Pin placed from the address. Drag it onto the gate if it's a little off.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNote(/REQUEST_DENIED|not authorized|not activated/i.test(msg)
        ? "Address search isn't switched on for this school's map key. Click the map to place the pin."
        : /ZERO_RESULTS/i.test(msg)
          ? "Couldn't find that address. Click the map to place the pin instead."
          : "Address search didn't work just now. Click the map to place the pin.");
    } finally {
      setFinding(false);
    }
  }

  return (
    <div>
      <div className={`relative overflow-hidden rounded-lg border border-line ${className}`}>
        <GoogleMap
          defaultCenter={pin ?? nearby[0] ?? DEFAULT_CENTER}
          defaultZoom={pin ? 16 : 12}
          gestureHandling="greedy"
          disableDefaultUI
          zoomControl
          clickableIcons={false}
          style={{ width: "100%", height: "100%" }}
          onClick={(e) => { const ll = e.detail.latLng; if (ll) { onPin({ lat: ll.lat, lng: ll.lng }); setNote(null); } }}
        >
          <Layers pin={pin} onPin={onPin} nearby={nearby} focus={focus} />
        </GoogleMap>
        {!pin && (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <span className="rounded-full bg-white/95 px-3 py-1 text-[11.5px] font-semibold shadow">Click the map where they live</span>
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={() => void find()} disabled={finding}
          className="text-[12px] font-semibold text-leaf hover:underline disabled:opacity-60">
          {finding ? "Looking…" : "Find on map"}
        </button>
        {pin && (
          <>
            <span className="font-mono text-[11px] text-ink-faint">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</span>
            <button type="button" onClick={() => onPin(null)} className="text-[12px] font-semibold text-warn-ink hover:underline">Remove pin</button>
          </>
        )}
        {note && <span className="text-[11.5px] text-ink-muted">{note}</span>}
      </div>
    </div>
  );
}

function Layers({ pin, onPin, nearby, focus }: {
  pin: LatLngPoint | null; onPin: (p: LatLngPoint | null) => void; nearby: (LatLngPoint & { name: string })[]; focus: LatLngPoint | null;
}) {
  const map = useMap();
  const loaded = useApiIsLoaded();
  useEffect(() => {
    if (map && focus) { map.panTo(focus); map.setZoom(16); }
  }, [map, focus]);
  if (!loaded) return null;
  const dot: google.maps.Symbol = { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: "#8A938C", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 };
  return (
    <>
      {nearby.map((s, i) => <Marker key={`${s.lat},${s.lng},${i}`} position={s} title={s.name} icon={dot} clickable={false} />)}
      {pin && (
        <Marker
          position={pin}
          draggable
          title="Home"
          onDragEnd={(e) => { const ll = e.latLng; if (ll) onPin({ lat: ll.lat(), lng: ll.lng() }); }}
        />
      )}
    </>
  );
}
