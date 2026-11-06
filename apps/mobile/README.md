# Figbloom mobile (Android + iOS)

The one phone app: **parent**, **student**, **driver**, **teacher**, and the school's
**admin console** for school admins and for teachers and other staff who hold admin areas.
The signed-in role decides which screens open (`App.tsx` reads it from the profile).
Org admins and the platform console use the web console. Teachers used to have a
separate app (`apps/teacher-mobile`); it was merged in here so there is one sign-in,
one store listing and one release.

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
  navigation.tsx      bottom tabs for the parent and the student; the driver is one page
  teacherNavigation.tsx  the teacher's five tabs, with everything else under More
  adminNavigation.tsx the school's admin console: Home and Account for now, more a part at a time
  navShared.tsx       the navigation colours and tab icon both navigators use
  screens/parent/     Home · Fees · Pay · Results · Inbox · Account
  screens/student/    Today · Timetable · Work · Results · Notices
  screens/driver/     Trip — start/end a trip, background GPS while it runs
  screens/teacher/    Attendance · Gradebook · Messages · Notices · More (Timetable ·
                      Classes · Leave · Homework · Materials · Items · Buses · Visitors ·
                      Performance · Report cards · Bloom · Live class · Account)
  screens/admin/      Home (who you are, what your areas allow, the way to the web console)
```

## The admin console on the phone

Who gets it, from `phoneConsolesFor` in `@figbloom/shared` (the same areas the web
console uses, `adminAreas.ts`; the database checks every one again with `has_perm`):

| Role | Opens |
|---|---|
| `school_admin` | the admin console, all of it |
| `teacher` | their own screens; and the admin console, with just their areas, when they hold any besides visitors (More > Admin screens, and Home > Back to teacher screens) |
| `staff` | the admin console, with their areas; with none, or with only visitors (the phone has no visitor log), they stay on the web |
| `org_admin`, `super_admin` | nothing here: the web console |

**Signing in.** A school admin has a real email and no school ID (`invite-admin`), so
the sign-in screen has a link under the form, "School admin? Sign in with your email",
which swaps school + ID for email + password; "Forgot password?" there emails the usual
reset link, which opens the web's reset page. Teachers and other staff sign in with
their school ID as before. An account the app has no screens for (an org admin, a
platform admin, staff with no admin area or only visitors) is signed out again with a "Not on the phone
yet" note, rather than silently bouncing back to the sign-in form.

**The admin screens always ask for the fingerprint** (`FingerprintLock` with
`required`), whatever the person chose for the rest of the app, and again each time a
teacher switches to them. A phone with no fingerprint saved is sent to its security
settings; a phone with no usable sensor cannot open the admin screens at all (the web
console is the way). The lock's Account switch is replaced by a note saying so.

Staff identities are live data and are never saved (`lib/staffSession.ts`): with no
signal they see the "No connection" page. Admin screens are added to `adminNavigation.tsx`
a part at a time, each shown only to the people whose areas open it
(`mayOpenAdminPage`).

**What is on the admin screens so far**

| Screen | Who | What it does |
|---|---|---|
| Home, overview | school admins | The web Dashboard's figures: attendance, fees collected, learners, staff, "Needs you", every class's register for the day, fee collection by status. A class that has not taken its register has "Remind teacher" (an in-app note to the class teacher, as on the web). Pull down to refresh. |
| Home, registers | staff and teachers holding the `attendance` area | Every class's latest register, read only. |
| A class's register | both of the above | Who was late, absent or excused on that day. Read only (correcting a register stays on the web). |

The data these read (`fetchSchoolOverview`, `fetchClassRegister`, `fetchLatestRegisters`,
`remindClassTeacher`) is in `packages/shared/src/adminOverview.ts`, and the web's Dashboard
uses the same functions, so the two say the same thing. Each screen loads with
`lib/useLoad.ts` (skeleton on first load, the reason and "Try again" on failure, pull to refresh).

A teacher's screens are all live data (rosters, registers, marks), so with no
signal a teacher sees the "No connection" page, as a driver does, and nothing is
saved for them beyond the write queue (`lib/useQueueSync.ts` sends held
registers and marks as soon as the app opens).

## Things that differ from web on purpose

- **Push instead of polling.** Absence and fee notifications arrive as FCM
  pushes; the in-app inbox is the same list either way.
- **The queue survives a force-quit.** AsyncStorage, not memory — a parent on a
  matatu loses the app, not the payment state.
- **Offline reads.** The last fetched balance and results stay readable with no
  network, with the fetch time shown so nobody acts on a stale figure.
- **Fingerprint unlock.** Opt-in on the Account screen (the driver's Trip screen
  for drivers), per person, and dropped on sign-out. It locks the screens, not
  the session: on a cold start, and after 30 seconds in the background, a
  full-screen `Modal` asks for the fingerprint, with the app still mounted
  underneath. Built on `react-native-biometrics` (strong biometrics only, no
  phone-PIN fallback; "Sign out" on the lock screen is the way out). The app
  cannot enrol a fingerprint, so with none on the phone it opens the phone's
  security settings.

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
