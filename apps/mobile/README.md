# Figbloom mobile (Android + iOS)

The **parent**, **student** and **driver** apps. Teachers and admins use the
web console; these roles are phone-first, so they are native.

## Why React Native, and what is actually shared

`@figbloom/shared` holds the domain: types, the grading scale, fee maths, the
attendance register, M-Pesa number normalisation, the offline write queue, and
the copy for payment failures. Both platforms import it, so a grade boundary or
a fee rule is changed in one place.

**UI is written twice on purpose.** A phone register and a desktop gradebook are
different interfaces, not one interface at two widths — sharing components
across them produces something that suits neither. The screens here mirror
`apps/web/src/screens/parent` and `.../student` in behaviour, not in code.

## Running it

```bash
npm install
npm run android --workspace @figbloom/mobile   # device or emulator, API 26+
npm run ios --workspace @figbloom/mobile       # Mac + Xcode only — run `pod install` in ios/ first
```

### Against your local Supabase, on an emulator

1. `apps/mobile/.env` (gitignored): `SUPABASE_URL=http://10.0.2.2:58321` (the emulator's name for
   your machine) and `SUPABASE_ANON_KEY` from the root `.env`. A phone on your Wi-Fi needs your
   machine's LAN address instead.
2. `apps/mobile/android/local.properties` (gitignored): `MAPS_API_KEY=...`, a "Maps SDK for Android"
   key. Without it the Bus map has no tiles (see `MAPS.md`).
3. `docker start supabase_edge_runtime_figbloom` if it isn't running: school search and the ID lookup
   are edge functions.
4. Debug builds need `adb reverse tcp:8081 tcp:8081` so the app can reach Metro.

**Windows:** the native build fails with "Filename longer than 260 characters" when the repo sits
under a long path. Map it to a short drive first: `subst X: "C:\path\to\School Management System"`,
then run Gradle from `X:\apps\mobile\android` (`gradlew installDebug -PreactNativeArchitectures=x86_64`
builds for the emulator only, much faster). `subst X: /d` removes it. If install says
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the emulator has a build signed with another key: uninstall it.

Android 8.0 (API 26) is the floor — it covers the low-cost handsets most
parents actually use. iOS has no equivalent floor decision yet; whoever
builds it should pick a minimum iOS version at that point.

## Structure

```
src/
  theme.ts            tokens from @figbloom/shared, as RN StyleSheet values
  storage.ts          AsyncStorage adapter for the shared WriteQueue
  navigation.tsx      bottom tabs per role
  screens/parent/     Home · Fees · Pay · Results · Inbox · Account
  screens/student/    Today · Timetable · Work · Results · Notices
  screens/driver/     Trip — start/end a trip, background GPS while it runs
```

## Things that differ from web on purpose

- **Push instead of polling.** Absence and fee notifications arrive as FCM
  pushes; the in-app inbox is the same list either way.
- **The queue survives a force-quit.** AsyncStorage, not memory — a parent on a
  matatu loses the app, not the payment state.
- **Offline reads.** The last fetched balance and results stay readable with no
  network, with the fetch time shown so nobody acts on a stale figure.

## Calls and live classes (FIG-1291)

Voice and video calls from a chat, and live classes (teacher goes live, learners
and parents join), on LiveKit through the same `call-token` function as the web.
The code is in `src/calls/`: `CallProvider` (one room at a time, the incoming-call
card, looks for a ringing call when the app opens), `CallRoom` (the LiveKit room),
the "Live now" banner and the chat header's Call and Video buttons. The teacher
app has its own copy of the same files, plus a Live class screen under More.

Needs the server's `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`
(see `supabase/functions/call-token`); without them the call screens say calls
are not set up. Android has the microphone, camera and Bluetooth permissions
(LiveKit's own manifest adds most; `BLUETOOTH_CONNECT` is here). Calls work while
the app is open: there is no lock-screen ringing and a call does not keep running
with the app in the background yet.

**iOS is not set up** (nothing builds the iOS project yet, FIG-1214). When it is,
LiveKit needs, per its README: the two `source` lines in `ios/Podfile`
(`https://github.com/livekit/podspecs.git` first, then `https://cdn.cocoapods.org/`),
`#import "LivekitReactNative.h"` and `[LivekitReactNative setup];` at the top of
`didFinishLaunchingWithOptions` in `ios/Figbloom/AppDelegate.mm`, and `pod install`.
The microphone and camera reasons are already in `Info.plist`.
