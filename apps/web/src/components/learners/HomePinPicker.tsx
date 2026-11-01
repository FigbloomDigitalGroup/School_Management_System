import { useEffect, useRef, useState } from "react";
import { APIProvider, Map as GoogleMap, Marker, useApiIsLoaded, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import type { LatLngPoint } from "@figbloom/shared";

/**
 * A small map for placing a learner's home: search for a place, click the
 * map, or drag the pin.
 *
 * The search box suggests places as you type (Places API: shops, churches,
 * schools, estates, the landmarks people actually give). "Find on map" tries
 * the landmark and address as a place search first, then the Geocoder on the
 * full address, then the address alone. Both need their APIs enabled on the
 * browser key (Places API (New), Geocoding API; see MAPS.md). Without them
 * the search says so and clicking the map still works; without a key at all,
 * the pin can't be placed and the address is kept as text.
 */

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

/** Where the map opens with nothing to show: central Nairobi. */
const DEFAULT_CENTER = { lat: -1.2864, lng: 36.8172 };

export function mapsConfigured(): boolean {
  return !!GOOGLE_MAPS_API_KEY;
}

export function HomePinPicker({ pin, onPin, address, landmark = "", nearby = [], className = "h-[220px]" }: {
  pin: LatLngPoint | null;
  onPin: (p: LatLngPoint | null) => void;
  /** What "Find on map" looks up, with the landmark. */
  address: string;
  /** "Opposite Naivas, Kileleshwa": often easier to find than the address. */
  landmark?: string;
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
      <PickerBody pin={pin} onPin={onPin} address={address} landmark={landmark} nearby={nearby} className={className} />
    </APIProvider>
  );
}

function PickerBody({ pin, onPin, address, landmark, nearby, className }: {
  pin: LatLngPoint | null; onPin: (p: LatLngPoint | null) => void; address: string; landmark: string;
  nearby: (LatLngPoint & { name: string })[]; className: string;
}) {
  const geocoding = useMapsLibrary("geocoding");
  const places = useMapsLibrary("places");
  const [finding, setFinding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLngPoint | null>(null);
  // Searches lean towards the pin, else the school's stops, else Nairobi.
  const near = pin ?? nearby[0] ?? DEFAULT_CENTER;

  function place(p: LatLngPoint, how: string) {
    onPin(p);
    setFocus(p);
    setNote(`${how} Drag the pin onto the gate if it's a little off.`);
  }

  async function find() {
    const a = address.trim();
    const l = landmark.trim();
    if (!a && !l) { setNote("Type the address or a landmark first."); return; }
    if (!geocoding && !places) { setNote("Address search isn't available yet. Click the map to place the pin."); return; }
    setFinding(true);
    setNote(null);
    let denied = false;
    try {
      // A landmark is a place ("Naivas Kileleshwa"), which the Geocoder
      // rarely finds; a place search does.
      if (places) {
        try {
          const { places: found } = await places.Place.searchByText({
            textQuery: [l, a].filter(Boolean).join(", "),
            fields: ["location"],
            locationBias: { center: near, radius: 30_000 },
            region: "ke",
            maxResultCount: 1,
          });
          const loc = found[0]?.location;
          if (loc) { place({ lat: loc.lat(), lng: loc.lng() }, "Pin placed from the search."); return; }
        } catch (err) {
          denied ||= isDenied(err);
        }
      }
      if (geocoding) {
        const queries = [...new Set([[a, l].filter(Boolean).join(", "), a].filter(Boolean))];
        for (const q of queries) {
          try {
            const res = await new geocoding.Geocoder().geocode({ address: q, region: "ke" });
            const loc = res.results[0]?.geometry.location;
            if (loc) { place({ lat: loc.lat(), lng: loc.lng() }, "Pin placed from the address."); return; }
          } catch (err) {
            denied ||= isDenied(err);
          }
        }
      }
      setNote(denied
        ? "Address search isn't switched on for this school's map key. Click the map to place the pin."
        : "Couldn't find that. Try the search box above the map, or click the map to place the pin.");
    } finally {
      setFinding(false);
    }
  }

  return (
    <div>
      {places && <PlaceSearch places={places} near={near} onPick={(p, name) => place(p, `Pin placed at ${name}.`)} />}
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

const isDenied = (err: unknown) => /REQUEST_DENIED|not authorized|not activated|PERMISSION_DENIED|API_NOT_ACTIVATED|has not been used/i
  .test(err instanceof Error ? err.message : String(err));

/**
 * Type a place, pick a suggestion. Suggestions come from Places Autocomplete,
 * one session token per search so a search and its pick bill as one.
 */
function PlaceSearch({ places, near, onPick }: {
  places: google.maps.PlacesLibrary;
  near: LatLngPoint;
  onPick: (p: LatLngPoint, name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<google.maps.places.PlacePrediction[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const token = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const latest = useRef(0);
  const { lat, lng } = near;

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) { setHits([]); return; }
    const ask = ++latest.current;
    const timer = setTimeout(() => {
      token.current ??= new places.AutocompleteSessionToken();
      places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: text,
        includedRegionCodes: ["ke"],
        locationBias: { center: { lat, lng }, radius: 30_000 },
        sessionToken: token.current,
      }).then(({ suggestions }) => {
        if (ask !== latest.current) return;
        setProblem(null);
        setHits(suggestions.flatMap((s) => (s.placePrediction ? [s.placePrediction] : [])).slice(0, 5));
      }).catch((err: unknown) => {
        if (ask !== latest.current) return;
        setHits([]);
        setProblem(isDenied(err)
          ? "Place search isn't switched on for this school's map key. Use Find on map, or click the map."
          : "Place search didn't work just now. Click the map to place the pin.");
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [q, places, lat, lng]);

  async function pick(p: google.maps.places.PlacePrediction) {
    const name = p.mainText?.text ?? p.text.text;
    setQ(name);
    setHits([]);
    try {
      const found = p.toPlace();
      await found.fetchFields({ fields: ["location"] });
      token.current = null;
      if (found.location) onPick({ lat: found.location.lat(), lng: found.location.lng() }, name);
      else setProblem("That place has no map position. Click the map instead.");
    } catch {
      setProblem("Couldn't open that place. Click the map instead.");
    }
  }

  return (
    <div className="relative mb-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (hits[0]) void pick(hits[0]); } }}
        placeholder="Search a place or landmark, e.g. Naivas Kileleshwa"
        aria-label="Search for a place on the map"
        className="w-full rounded-md border border-line bg-white px-3 py-2 text-[13px] outline-none focus:border-forest"
      />
      {hits.length > 0 && (
        <ul role="listbox" aria-label="Places" className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-line bg-white shadow">
          {hits.map((h) => (
            <li key={h.placeId} role="option" aria-selected={false}>
              <button type="button" onClick={() => void pick(h)} className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-sunken">
                <span className="font-semibold">{h.mainText?.text ?? h.text.text}</span>
                {h.secondaryText && <span className="ml-1.5 text-ink-muted">{h.secondaryText.text}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="mt-1 text-[11.5px] text-ink-muted">{problem}</p>}
    </div>
  );
}
