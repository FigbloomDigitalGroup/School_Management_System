# Fleet Maps — How It's Implemented

This covers the school bus feature: the live map for drivers, parents, teachers and admins, the bus updates families get as a bus moves, and the GPS tracking behind both.

## TL;DR

- **Web** (`apps/web`) has one shared live map, `LiveRouteMap` (`components/fleet/`). The driver, parent, teacher and admin screens, and the trip replay, all draw on it. Provider: **Google Maps**, via `@vis.gl/react-google-maps`.
- **Mobile** (`apps/mobile`, the parent's Bus tab, FIG-874) has a deliberately leaner map: bus + numbered stops + a straight line through them, no road-snapping, no satellite/traffic toggle, no glide animation. Provider: **`react-native-maps`** (Apple Maps on iOS, Google Maps SDK on Android). No Leaflet or Mapbox anywhere.
- **Bus updates** ("on its way, arriving ~7:42", "1 km away", "at your stop", "running ~8 min late") are worked out server-side by the `bus-tick` edge function after each location ping, stored in `bus_updates`, shown live in the app, and pushed to guardians' phones.
- One shared data layer (`packages/shared/src/fleet.ts`) feeds web and mobile. Postgres/Supabase for storage, realtime and server-side alerting.

## Web map components

**`components/fleet/LiveRouteMap.tsx`** is the Uber-style map everyone shares.
- Routes are drawn along real roads through their numbered stops. Only discrete stops are stored, so the road path comes from the Maps JavaScript API's Directions service (`routes` library). It is fetched **once per route per browser** and cached, in memory and in `localStorage` (key `fb-route:<routeId>:<stop coordinates>`), so it re-fetches only if the stops change, not on every ping. Routes with more than 27 stops are drawn as straight lines between stops (Directions allows 25 waypoints).
- Buses glide between position pings. A bus counts as **live** if it pinged within the last 2 minutes (`isLive`, `LIVE_WITHIN_MS`).
- `children` is a slot for each role's own bottom sheet (`MapSheet`). `selfPos` puts a point of interest on top of a bus marker: a driver's own GPS fix, and the scrubber position in a trip replay.
- `Eta` gives the drive time between two points: Directions when the map is loaded (asked at most once a minute, or sooner if the bus has moved 300 m or the destination changed, so a bus pinging every 10 s doesn't cost a call per ping), a rough estimate otherwise.
- The map remembers where the user left the view (`localStorage` key `fb-map-view`).
- With no `VITE_GOOGLE_MAPS_API_KEY` the map area shows a "not configured" notice and ETAs fall back to estimates; nothing throws.
- Helpers it exports: `useLiveBuses(tenantId, initial)` merges the initial fetch with realtime position updates; `useNow`, `busPosition`, `fmtAgo`, `fmtEta`, `ROUTE_COLORS`.

**`components/fleet/FleetLiveMap.tsx`**: every bus in the school on one map; pick a bus in the sheet or on the map to colour its route and see who is driving and where it's heading. Used by the admin Fleet page and the teacher Buses page.

**Who uses what**
- `screens/admin/Fleet.tsx`, `screens/teacher/Buses.tsx`: `FleetLiveMap`.
- `screens/parent/Bus.tsx`: `LiveRouteMap` with the family's rides at a fixed height, and under it (via the `below` prop, so `<Eta>` still works) a card per child with their status, today's bus updates and the driver. Nothing covers the map.
- `screens/driver/Trip.tsx`: `LiveRouteMap` with the driver's own fix (`selfPos`).
- `components/TripReplayMap.tsx`: replays a trip's recorded path on the same `LiveRouteMap`. Opened from a trip row in `screens/admin/TripHistory.tsx`.

**`components/fleet/BusUpdates.tsx`**: `UpdateFeed` / `useTodaysBusUpdates` for the parent's feed, and `BusUpdatesListener`, mounted once in `ParentShell`, which pops a toast for every new update on whatever page the parent is on, and a system notification when the tab is in the background (if they've allowed it).

## Mobile map

**`apps/mobile/src/components/BusMap.tsx`** (FIG-874)
- Renders `<MapView>` → `<Marker>` (bus, numbered stops as plain View children) → `<Polyline>` straight through the stops in travel order.
- Used by `screens/parent/Bus.tsx`'s `RideCard`, one map per child's ride. The same screen shows today's bus updates (`listBusUpdates` / `subscribeBusUpdates`); push for them arrives from `bus-tick` whether or not the app is open.
- No student-facing Bus screen exists yet, only parents get live tracking.
- `initialRegion` is computed once on mount from the first fix and never recentred: the camera is the viewer's to pan after that.
- The mobile driver screen (`screens/driver/Trip.tsx`) doesn't render a map; it streams location.

## Config: three separate keys

| Key | Where it lives | Used for | Restrict it to |
|---|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | `.env` / the web host's env (public: it ships in the web bundle) | Maps JavaScript API + Directions on web, plus Geocoding for "Find on map" when placing a learner's home | HTTP referrers (our domains), Maps JavaScript API, Directions and Geocoding only |
| `GOOGLE_MAPS_SERVER_KEY` | Supabase edge-function secret: `supabase secrets set GOOGLE_MAPS_SERVER_KEY=...` | `bus-tick`'s Routes API calls | The Routes API only |
| `MAPS_API_KEY` | `apps/mobile/android/local.properties` (gitignored) and the `MAPS_API_KEY` GitHub secret | Maps SDK for Android in the parent app | The app's package name + signing SHA-1s |

**Do not reuse one key for all three.** A browser key can't carry a referrer restriction and also serve the server, and anything in the web bundle is public, so an unrestricted browser key can be copied and billed against by anyone. **As of 2026-10-23 the web key in use is still unrestricted (it answers Directions web-service calls with no referrer and with a made-up one); splitting and restricting the keys, then rotating the old one, is FIG-706.** `GOOGLE_MAPS_SERVER_KEY` isn't set on the local stack, so `bus-tick` falls back to distance-based estimates marked "about".

Both web features are optional: without the browser key the map shows a notice, without the server key times are estimated.

**Mobile Android** needs its own key: the Maps SDK for Android doesn't accept a browser-restricted JS key. Enable "Maps SDK for Android", issue an Android-app-restricted key, and add it to `apps/mobile/android/local.properties` (gitignored, the same file Android Studio writes `sdk.dir` to) as:
```
MAPS_API_KEY=your-android-key
```
`android/app/build.gradle` reads it into a manifest placeholder consumed by `AndroidManifest.xml`'s `com.google.android.geo.API_KEY` meta-data, mirroring the `key.properties`/release-signing pattern in the same file. A missing key doesn't fail the build; the map just renders without tiles. The release workflow (`.github/workflows/mobile-release-build.yml`) writes it from the `MAPS_API_KEY` GitHub secret for the parent app and **fails the build if the secret is missing**. If the key is restricted to the app, add the package name (`com.figbloom.schools`) and the SHA-1 of every key that signs a build: the debug keystore for development, the upload key for CI builds, and Play App Signing's key for builds installed from Google Play.

**Mobile iOS** needs no key: `react-native-maps` defaults to Apple Maps there.

`bus-tick`'s push uses a separate secret, `FCM_SERVICE_ACCOUNT_JSON_B64`; without it updates still reach the in-app feed.

**Learner homes and "Find on map"** (`components/learners/HomePinPicker.tsx`): the home pin is placed by clicking the map or dragging the pin, which needs nothing beyond the Maps JavaScript API. "Find on map" looks a typed address up with the Maps JavaScript `Geocoder`, which needs the **Geocoding API** enabled in the Google Cloud project and added to the browser key's API restrictions. Until it is, the search says "Address search isn't switched on for this school's map key" and clicking the map still works. No Places API (autocomplete) is used.

## Planning routes from homes

- `students.home_lat/home_lng/home_landmark/home_address` hold where a learner lives (`20261025020000_bus_riders_and_homes.sql`, `20261025050000_learner_address_health.sql`). Admins set them from People (Add a learner, Manage learner > Home and bus); guardians from the parent Home page, through `set_child_home()`. A CSV import can bring the address as text (or `home_lat`/`home_lng`); rows without a pin are flagged "No map pin".
- `packages/shared/src/routePlanning.ts` (pure, tested): `suggestRouteForHome` joins the nearest existing stop within 400 m, otherwise adds a stop to the route where it adds the least distance (cheapest insertion, never before stop 1, the school end). `rebuildStopsFromHomes` clusters a route's riders' homes within 300 m into stops, orders them from stop 1 by nearest neighbour plus 2-opt, and reuses existing stops within 150 m so their riders and names carry over. Distances are straight-line; the office always sees a preview.
- Writes go through two RPCs: `assign_learner_bus()` (student_transport, plus a new stop slotted in at a position) and `save_route_stops()`, which updates stops in place by id. The old save deleted and re-inserted every stop, which set every child's `stop_id` to null; `replaceRouteStops()` now calls `save_route_stops()`.
- Admin Fleet > a route: its riders, and "Rebuild stops from riders' homes" with a preview before saving.

## Data flow

**Schema**
- `supabase/migrations/20260903000003_fleet.sql`: `vehicles` (cached "where is it now": `last_lat`, `last_lng`, `last_ping_at`, `speed_limit_kmh`), `routes` / `route_stops` (an ordered list of stop coordinates; no polyline is stored), `vehicle_assignments` (driver ↔ vehicle ↔ route), `trips` (one per drive: `direction`, `status`), `vehicle_locations` (full ping history), `student_transport` (links a student to a route/stop; RLS means a parent only ever reads their own child's data).
- `supabase/migrations/20261007020000_bus_updates.sql`: `bus_updates`, one row per (trip, stop, milestone) with kinds `trip_started`, `distance`, `arrived`, `delay`. Siblings at one stop share a row (`student_ids`), and a unique `dedupe_key` means a milestone is announced once per trip however many ticks race to it. Nothing but the service role writes; families read it, live via Realtime.

**Writing a ping**: `pingLocation()` in `packages/shared/src/fleet.ts`:
1. Inserts a row into `vehicle_locations` (history).
2. Updates `vehicles.last_lat/last_lng/last_ping_at` (cheap "now" read).
3. Fires the `bus-tick` edge function for the trip, fire-and-forget: a missed tick only delays an update to the next ping, never the ping itself.

The web driver screen calls this from `navigator.geolocation.watchPosition`, throttled to one write per 10 s, with an offline write queue (`packages/shared/src/queue.ts`) that drains on reconnect. The mobile driver flow (`apps/mobile/src/screens/driver/locationTask.ts`) collects ticks the same way via an Android foreground service, but check that file directly for its Supabase call site: it wasn't verified to reuse the exact same shared function.

**`bus-tick`** (`supabase/functions/bus-tick`): works out where the bus is against every stop on its route that has riders, records any new milestone in `bus_updates`, and pushes it to those riders' guardians (FCM). Arrival times come from Google's **Routes API** (`computeRouteMatrix`, traffic-aware), one matrix call for all of a trip's stops, asked at most every 2 minutes per trip or sooner when an update is about to go out with a stale time. Without `GOOGLE_MAPS_SERVER_KEY`, or if Google fails, times are estimated from distance at 22 km/h and marked "about".

**Reading / rendering**
- `listBusesOnRoutes(tenantId)` → `BusOnRoute` (vehicle + route + stops + driver + trip direction), for the admin and teacher fleet views; `myChildBus(studentId)` does the same for one child. `activeDirections()` gives each active trip's direction so `stopsInTravelOrder` numbers the stops the right way round (to school / from school).
- `subscribeVehiclePositions(tenantId, onUpdate)`: Supabase Realtime on `UPDATE` events for the `vehicles` table, filtered by tenant. Deliberately **not** subscribed on `vehicle_locations`: that table is high-volume, so only the "current position" row is realtime-published.
- `listBusUpdates(studentIds, since)` and `subscribeBusUpdates(tenantId, onInsert)` feed the in-app update feed.
- `fetchTripPath(tripId)` pulls ordered `vehicle_locations` history for `TripReplayMap`.

**Server-side alerting** (`supabase/migrations/20260903000007_fleet_alerts.sql`): a Postgres trigger fires on every `vehicle_locations` insert and flags:
- Speeding (`speed_kmh > vehicles.speed_limit_kmh`, default 80).
- Off-route (haversine distance to the nearest `route_stops` row > 1500 m; an approximation, since only discrete stops are stored, not a full path).
- It de-dupes repeat alerts of the same kind within a 5-minute window.

This logic lives entirely in SQL: the map UI only displays alerts and lets admins acknowledge the ones the trigger already raised.

## Gotchas / things to know before touching this

- `react-native-maps` (needs play-services-location 21.3.0) and `react-native-geolocation-service` (defaults to 18.0.0) share one copy of Google's location library at runtime, the newer one. The driver's GPS library must be compiled against the same version, which `playServicesLocationVersion` in `apps/mobile/android/build.gradle` does. Without it the first location request crashes the app with `IncompatibleClassChangeError: Found interface ...FusedLocationProviderClient, but class was expected`.
- No background tracking beyond the foreground: web only tracks while the driver's tab is open; mobile uses an Android foreground service (required by Android for background location), not a paid background-tracking SDK.
- Routes are discrete stop points, not polylines. The admin stop editor (`Fleet.tsx` → `StopsEditor`) replaces the whole stop list on save (delete-all-then-insert) rather than diffing. Changing a stop changes the cache key, so the road path is fetched again.
- RLS, not the map component, enforces that a parent only sees their own child's bus.
- Ambient `google.maps.*` types come from `@vis.gl/react-google-maps`'s `<APIProvider>`/`useMapsLibrary`. If you hit type errors, check whether `@types/google.maps` needs adding.

## Key files

| Path | What |
|---|---|
| `apps/web/src/components/fleet/LiveRouteMap.tsx` | The shared live map: road paths, gliding buses, ETA, sheet slot |
| `apps/web/src/components/fleet/FleetLiveMap.tsx` | Every bus in the school on one map (admin, teacher) |
| `apps/web/src/components/fleet/BusUpdates.tsx` | Bus-update feed and the parent's pop-up listener |
| `apps/web/src/components/TripReplayMap.tsx` | Historical trip replay, on `LiveRouteMap` |
| `apps/web/src/screens/admin/Fleet.tsx` | Admin fleet view |
| `apps/web/src/screens/admin/TripHistory.tsx` | Trip history list → replay modal |
| `apps/web/src/screens/teacher/Buses.tsx` | Teacher's view of the school's buses |
| `apps/web/src/screens/parent/Bus.tsx` | Parent "where's my child's bus" view |
| `apps/web/src/screens/driver/Trip.tsx` | Web driver GPS reporting, with the map |
| `apps/mobile/src/screens/driver/locationTask.ts` | Mobile background GPS collection |
| `apps/mobile/src/components/BusMap.tsx` | Mobile's lean live map (bus + stops + line) |
| `apps/mobile/src/screens/parent/Bus.tsx` | Parent "where's my child's bus" view (mobile) |
| `packages/shared/src/fleet.ts` | All fleet queries/mutations (ping, list, subscribe, updates, alerts) |
| `packages/shared/src/queue.ts` + `apps/web/src/lib/queue.ts` | Offline write queue for GPS pings |
| `supabase/functions/bus-tick/` | Bus updates: milestones, Routes API ETAs, push |
| `supabase/migrations/20260903000003_fleet.sql` | Core fleet schema + RLS |
| `supabase/migrations/20260903000006_fleet_realtime.sql` | Realtime publication scoping |
| `supabase/migrations/20260903000007_fleet_alerts.sql` | Speeding/off-route alert trigger |
| `supabase/migrations/20261007020000_bus_updates.sql` | `bus_updates` for family updates |
| `.env.example` | `VITE_GOOGLE_MAPS_API_KEY` docs |
