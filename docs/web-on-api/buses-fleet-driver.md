# Buses, fleet and the driver (admin/fleet, teacher/buses, driver, driver/profile)

Four pages run on the API build: **Fleet** (`admin/fleet`), **Buses** (`teacher/buses`) and the driver's two pages (`driver`,
`driver/profile`). They are the Supabase app's own screens. The API side is `packages/shared/src/api/fleetApi.ts` (the trips,
the maps, the driver's trip), `queueApi.ts` (the offline queue) and `pages/fleet.pages.tsx` (the registered pages); the driver's
shell is `apps/web/src/api/ApiDriver.tsx`. `fleetCapabilities()` in `capabilities.ts` says what is hidden. The checks for this
area were lighter than usual (see "Verified").

## What works

| Page | On the API build |
|---|---|
| `admin/fleet` | Vehicles (list, add), routes (list, add), the live map of every bus, the children on each bus on the road, the drivers' breakdown reports (read, acknowledge), trip history with a replay, and "Assign a driver" |
| `teacher/buses` | The same live map, read only. A plain teacher cannot open it (see "What a person can do") |
| `driver` | The driver's vehicle and route, start a trip (to or from school), their position sent every 10 s, the list of children on the route with their stops, mark a child on the bus, got off or not here, report a breakdown, end the trip |
| `driver/profile` | The account sections (password, two-step, how the school reaches them). No photo |

## What a person can do, by role (checked on a real API)

| | School admin | Plain teacher | Driver |
|---|---|---|---|
| Fleet | all of it above | no page content: the API answers 403 to vehicles, routes, trips and the staff list, and the page says so | no menu: a driver has only their own pages |
| Buses | all of it | **cannot see the buses**: "The new system does not let you see the school's buses with the access you have. Ask the school office to give you the Transport area." | n/a |
| Driver pages | n/a | n/a | their own assignment, trip, position, marks and breakdown. They **cannot read the fleet** (no vehicle list, no live feed), so the map follows the phone's own position |

A teacher who holds the Transport area lands in the admin console and gets the Fleet page.

## How the model is mapped

- A **trip** is the API's trip. Its driver is a user id, so the office's driver names come from the staff list (`GET /staff`, needs
  `resource.staff.read`). Without it the names show as "—".
- **Vehicles on the map**: every active vehicle, with its last position read one vehicle at a time
  (`GET /vehicles/{id}/locations?limit=1`). The driver, route and direction come from the **running trip** of that vehicle. A bus
  with no trip has no driver or route on the map ("Not on a trip"): the API does not say who is assigned to it.
- **Live positions**: polling (`poll.ts`), every 10 s, for the buses on a trip only. It pauses while the tab is hidden or unused
  and stops by itself when the reader gets a 403 (a driver, a parent). The list of children on the road and the buses' directions
  are polled the same way (15 s). The Supabase build keeps its realtime and its intervals.
- **Children on a trip**: the trip's manifest (`GET /trips/{id}`): everyone assigned to the route, with where they stand, and the
  times from the trip's events. Each child carries their stop's name; that is the only way to know a stop's name.
- **Marking a child**: a trip event (`learner_boarded`, `learner_alighted`, `learner_not_boarded`). The server keeps one of each per
  child per trip.
- **Ending a trip** uses `/trips/{id}/finish`. (`/complete` needs the office's permission; a driver has only `drive`.) An
  afternoon trip with children still marked on the bus is refused with a 409 until the driver says so: the screen asks "N children
  are still marked on the bus" and sends the acknowledgement when they choose "End trip anyway".
- **Breakdown** is an `incident` event on the trip. The office sees it as an alert on the Fleet page ("Bus broken down"), read from
  the incidents of the trips on the road and of the last day. **No family is told** from here.
- **Trip history** reads the newest trips (the API cannot filter by vehicle, so one vehicle's history is read 5 pages deep and
  filtered here). The **replay** path is the vehicle's recorded positions back to the start of the trip, kept if they carry the
  trip's id.

## Hidden on the API build, and why

| Hidden | Missing in the API |
|---|---|
| A route's stops on the maps, the stop editor, "Next stop" and its time on the driver's screen | no read of a route's stops (fleet-2) |
| Who rides a route, "Rebuild stops from riders' homes" | no list of a route's riders, and a learner has no home pin (fleet-2) |
| The "Driver & route" column, the "Assigned" count, "Currently ..." in Assign a driver | no read of assignments (fleet-3) |
| Speeding and off-route alerts, the alert count in trip history | the API raises none. Breakdown reports are shown instead |
| Edit or remove a vehicle or a route, make a vehicle inactive | no change or delete for either (B11) |
| "Undo" on a child's mark | a trip event cannot be taken back (fleet-6) |
| "Families are told" after a breakdown | an incident tells nobody (fleet-8) |
| The driver's photo | needs file storage (A5); the API holds no photo |
| Adding a learner to a route from People, "Home and bus" | the People slice hides it; `routePlanning.ts` throws `NotOnApiError` for it |

## The offline queue, and what is safe to hold

On Supabase a driver's position or a mark made with no signal waits in the phone's queue and is upserted later. On the API each held
write is **`{ op, params, body, idempotencyKey }`** (`QueuedApiCall` in `queue.ts`), sent by `api/queueApi.ts` with the key as the
`Idempotency-Key` header. **No transport POST reads that header** (fleet-1), so the key does nothing yet and what makes a retry
safe is the server's own checks. Read from `apps/api/src/modules/transport/operations.ts` and migration 086:

| Write | Held offline? | Why |
|---|---|---|
| A child boarded, got off, not here | yes | a unique index keeps one of each per child per trip; a second answers 200 `replayed` |
| A position | yes | an exact resend is a no-op (200 `replayed`); an older fix is refused (409); a fix older than 10 minutes is refused (400), so a long dead zone leaves a gap |
| A breakdown (`incident`), a delay | **no** | not deduplicated: a retry makes a second incident, and a delay tells the families twice. It needs signal, and if there is no answer the screen says it may have gone through |
| Ending a trip | **no** | a second finish is a 409; an ending that the driver cannot see the answer of is not one to hold |

A write the server refuses for good (a 409 or 400) is set aside as "could not be sent" and never retried; no signal, a 429, a 401
and a 5xx are retried. A register held by a teacher on the old queue shape (a Supabase write) cannot be sent on the API build: it is
set aside the same way, instead of being retried for ever and stopping the queue.

## Things found in the API while doing this

(Numbered `fleet-1` and so on, so that no other area shares a number: see "One file for each area".)

- **fleet-1. No transport POST honours `Idempotency-Key`.** `vehicles`, `transport-routes` (and stops), `vehicles/{id}/assignments`,
  `learner-transport`, `trips`, `driver/trips`, `trips/{id}/events`, `driver-location`, `finish`, `cancel`, `complete` and the
  incident calls never read it (the header is only allowed by CORS). Retries are safe only where the database says so (the table
  above). `delayed` and `incident` events are **not** deduplicated, so a lost answer and a second tap makes two incidents, and two
  "delayed" notices to every family on the route. Ask: honour the header on the transport POSTs (at least events and trips), or
  give an event a client id.
- **fleet-2. A route's stops cannot be read.** There is no `GET` for stops and `GET /transport-routes` carries none. They can be
  added (`POST .../stops`, with a sequence) but never listed, changed or removed. So there are no stops on any map, no editor, no
  next stop for the driver, and no list of a route's riders (`learner_transport` has no read). Ask: `stops` in the route, or
  `GET /transport-routes/{id}/stops`, plus a read of a route's riders.
- **fleet-3. Who drives which vehicle cannot be read.** The only read of an assignment is a driver's own (`GET /driver/assignments`).
  The office cannot list assignments, so "Assigned", the Driver & route column and "Currently ..." are hidden, and a bus with no
  trip has no driver on the map. Ask: an assignment on each vehicle, or `GET /vehicle-assignments`.
- **fleet-4. The vehicle list has no position and no inactive vehicles.** A position is one read per vehicle, so a page load costs
  one request per vehicle and a poll one per bus on a trip. `GET /vehicles` lists active vehicles only, and there is no change or
  delete for a vehicle or a route (B11). Ask: the last position on each vehicle (or one read of all of them), and a `PATCH`.
- **fleet-5. Only the school admin and the Transport area can read transport.** `resource.transport.read` is held by the school
  admin role (migration 057); migration 086 took it from the driver. A plain teacher, as on Supabase, cannot see the buses, and a
  driver cannot see their own bus on the live feed. Ask: a read-only view for teachers (scoped, or the buses and their positions
  only), and the driver's own vehicle position.
- **fleet-6. A trip event cannot be taken back and has no time of its own.** A child marked boarded cannot be un-boarded; "not here"
  then "boarded" is refused by a trigger. The event's time is the server's `now()`, so a mark held offline and sent later is
  stamped late (and is refused if the trip has ended). Ask: `occurred_at` from the client (within limits) and a correction.
- **fleet-7. A held position older than 10 minutes is refused**, and one older than the newest is a 409, so a stretch without signal
  loses its path. The fix's time is the phone's own clock: a phone more than 10 minutes behind has every position refused.
- **fleet-8. A breakdown tells nobody, and incidents have no school-wide read.** `incident` is not one of the events that notify
  families; the office reads incidents one trip at a time (`GET /trips/{id}/incidents`), so the Fleet page reads the incidents of
  the trips on the road and of the last day (up to 20 trips, 4 at a time). Supabase told the office and the families. Ask:
  `GET /transport-incidents?status=open`, and a choice to notify.
- **fleet-9. Many answers are untyped.** `GET /trips`, `GET /trips/{id}`, `GET /driver/assignments`, `POST /driver/trips`, the events
  and the items of `GET .../locations` are `additionalProperties: true` in the OpenAPI file, so the web reads them by hand. The
  answer of `POST /driver/trips` has no vehicle, direction or start time (the web reads the trip back).
- **fleet-10. A driver is three things.** An invitation with the role `driver` makes the sign-in, a staff record with
  `classification: driver` and `userId` makes them visible to the office's driver list (the staff list needs `resource.staff.read`,
  so a person with only the Transport area sees no driver to pick), and `POST .../assignments` puts them on a vehicle. Nothing
  links the first two. `POST /trips/{id}/complete` (office) duplicates `/finish` without its acknowledgement.

## Verified, and not

Verified on a real throwaway API (a school admin, a plain teacher, a driver; 22 checks in Edge): Fleet opens with vehicles and
routes, adds a vehicle and a route, assigns a driver, the route card says why it has no stops, a plain teacher is told why they
cannot see the buses, the driver lands on their pages, starts a trip, a position is sent, the children and their stops are listed,
a child is marked on, a mark made offline is held (as `{op, params, body, idempotencyKey}`) and sent when the signal returns, a
breakdown is reported, the office sees it, the children on the bus and acknowledges it, the afternoon trip asks before ending with
a child on the bus, the trip ends, trip history and its replay open, the driver's profile opens; no page errors. 42 unit tests
(`fleetApi.test.ts`) on the fake API.

Not verified: a real phone's GPS (the browser's position was set by hand), the map itself (no Google Maps key on this machine, so
the map shows its notice and the sheets are what was checked), more than a few vehicles, a driver with two vehicles, a trip over
midnight, a held position past 10 minutes, a long dead zone, the Supabase build's fleet pages against the demo (not re-run), the
phone app (it still queues Supabase rows).
