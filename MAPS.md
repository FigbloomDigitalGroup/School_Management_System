# Fleet Maps — How It's Implemented

This covers the map/GPS-tracking feature: the school bus fleet tracker used by admins, parents, and drivers.

## TL;DR

- Maps only exist in the **web app** (`apps/web`). The mobile app collects GPS in the background but never renders a map.
- Provider: **Google Maps**, via `@vis.gl/react-google-maps` (Google's official React wrapper). No Leaflet/Mapbox anywhere.
- Two custom map components, one shared data/query layer (`packages/shared/src/fleet.ts`), Postgres/Supabase for storage + realtime + server-side alerting.

## Map components

**`apps/web/src/components/VehicleMap.tsx`** — the live map.
- Renders `<APIProvider>` → `<Map>` → `<Marker>` / `<InfoWindow>`.
- `FollowCamera` sub-component pans the camera to keep a moving vehicle centered.
- `DirectionsLayer` sub-component calls the Google **Directions API** (separate from the Maps JS API — needs to be enabled separately in Cloud Console) to draw a driving route + ETA.
- Markers are inline `data:image/svg+xml` URIs (`BUS_ICON_URL`, `YOU_ICON_URL`, `STOP_ICON_URL`), not bundled image assets.
- Used by:
  - `screens/admin/Fleet.tsx` — shows the whole fleet.
  - `screens/parent/Bus.tsx` — same component, just passed a single vehicle, to show one child's bus.
- When there's exactly one vehicle (the common parent case), it auto-activates Follow/Route-to-me without needing a marker click. The viewer's own location is only requested when they toggle "Route to me" — not proactively.
- If `VITE_GOOGLE_MAPS_API_KEY` isn't set, it renders a "not configured" placeholder instead of throwing.

**`apps/web/src/components/TripReplayMap.tsx`** — scrubbable historical trip viewer.
- Renders a `<Polyline>` for the recorded path plus start/end/scrub-position `<Marker>`s.
- `FitToPath` sub-component fits the camera bounds to the whole path.
- Opened from a trip row click in `screens/admin/TripHistory.tsx` (itself embedded in `Fleet.tsx`).
- Same "no key → placeholder" fallback as `VehicleMap`.

Driver-facing screens (web `screens/driver/Trip.tsx`, mobile `screens/driver/Trip.tsx`) don't render a map at all — they just show raw text and stream location.

## Config

```
VITE_GOOGLE_MAPS_API_KEY=
```
Set in `.env` (see `.env.example`). Optional — the feature degrades gracefully without it. Restrict the key to the Maps JavaScript API + your domain(s) in Google Cloud Console. The Directions API must be enabled separately.

## Data flow

**Schema** (`supabase/migrations/20260903000003_fleet.sql`):
- `vehicles` — cached "where is it now": `last_lat`, `last_lng`, `last_ping_at`, `speed_limit_kmh`.
- `routes` / `route_stops` — an ordered list of stop coordinates (`lat`, `lng`, `sequence`). No polyline is stored — routes are just discrete stops.
- `vehicle_assignments` — driver ↔ vehicle ↔ route.
- `trips` — one per drive (`direction`, `status`).
- `vehicle_locations` — full ping history (`lat`, `lng`, `speed_kmh`, `heading`, `recorded_at`).
- `student_transport` — links a student to a route/stop; enforced by RLS so a parent only ever reads their own child's data.

**Writing a ping** — `pingLocation()` in `packages/shared/src/fleet.ts`:
1. Inserts a row into `vehicle_locations` (history).
2. Updates `vehicles.last_lat/last_lng/last_ping_at` (cheap "now" read).

The web driver screen calls this from `navigator.geolocation.watchPosition`, throttled to one write per 10s, with an offline write queue (`packages/shared/src/queue.ts`) that drains on reconnect. The mobile driver flow (`apps/mobile/src/screens/driver/locationTask.ts`) collects ticks the same way via an Android foreground service, but check that file directly for its Supabase call site — it wasn't verified to reuse the exact same shared function.

**Reading / rendering**:
- `listVehicles()` — initial fetch for the admin fleet view.
- `subscribeVehiclePositions(tenantId, onUpdate)` — Supabase Realtime subscription on `UPDATE` events for the `vehicles` table (filtered by tenant). Deliberately **not** subscribed on `vehicle_locations` — that table is high-volume, so only the "current position" row is realtime-published.
- `VehicleMap` merges the initial fetch + live updates into a map keyed by vehicle id, then filters to vehicles with non-null coordinates before rendering markers.
- `myChildBus(studentId)` — joins `student_transport` → `routes/route_stops` → `vehicle_assignments` → `vehicles` for the parent view.
- `fetchTripPath(tripId)` — pulls ordered `vehicle_locations` history for `TripReplayMap`.

**Server-side alerting** (`supabase/migrations/20260903000007_fleet_alerts.sql`): a Postgres trigger fires on every `vehicle_locations` insert and flags:
- Speeding (`speed_kmh > vehicles.speed_limit_kmh`, default 80).
- Off-route (haversine distance to the nearest `route_stops` row > 1500m — an approximation, since only discrete stops are stored, not a full path).
- De-dupes repeat alerts of the same kind within a 5-minute window.

This logic lives entirely in SQL — the map UI only displays and lets admins acknowledge alerts the trigger already raised.

## Gotchas / things to know before touching this

- No background tracking beyond the foreground: web only tracks while the driver's tab is open; mobile uses an Android foreground service (required by Android for background location), not a paid background-tracking SDK.
- Routes are discrete stop points, not polylines — the admin stop editor (`Fleet.tsx` → `StopsEditor`) replaces the whole stop list on save (delete-all-then-insert) rather than diffing.
- RLS, not the map component, enforces that a parent only sees their own child's bus.
- Ambient `google.maps.*` types come from `@vis.gl/react-google-maps`'s `<APIProvider>`/`useMapsLibrary` — if you hit type errors, check whether `@types/google.maps` needs adding.

## Key files

| Path | What |
|---|---|
| `apps/web/src/components/VehicleMap.tsx` | Live fleet map |
| `apps/web/src/components/TripReplayMap.tsx` | Historical trip replay map |
| `apps/web/src/screens/admin/Fleet.tsx` | Admin fleet view (uses both maps) |
| `apps/web/src/screens/admin/TripHistory.tsx` | Trip history list → replay modal |
| `apps/web/src/screens/parent/Bus.tsx` | Parent "where's my child's bus" view |
| `apps/web/src/screens/driver/Trip.tsx` | Web driver GPS reporting (no map) |
| `apps/mobile/src/screens/driver/locationTask.ts` | Mobile background GPS collection |
| `packages/shared/src/fleet.ts` | All fleet queries/mutations (ping, list, subscribe, alerts) |
| `packages/shared/src/queue.ts` + `apps/web/src/lib/queue.ts` | Offline write queue for GPS pings |
| `supabase/migrations/20260903000003_fleet.sql` | Core fleet schema + RLS |
| `supabase/migrations/20260903000006_fleet_realtime.sql` | Realtime publication scoping |
| `supabase/migrations/20260903000007_fleet_alerts.sql` | Speeding/off-route alert trigger |
| `.env.example` | `VITE_GOOGLE_MAPS_API_KEY` docs |
