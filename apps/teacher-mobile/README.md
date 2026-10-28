# Figbloom Teacher (Android — iOS deferred)

The **teacher** app. A companion to `apps/mobile` (parent/student/driver), kept
as a separate binary/project since teachers' workflow (attendance, gradebook,
messaging) is a different shape from a parent's or student's. Bare React
Native, same toolchain as `apps/mobile` — not Expo — so there is one native
setup to maintain across both mobile apps (FIG-317).

## Status

Sign-in, Attendance, Gradebook, Messages, Notices, Timetable, Classes, Leave,
Buses and Account are all real screens now (FIG-319/320/321 and later work
landed these; this file had fallen behind).

## Why no `ios/` project yet

Every other iOS task on this codebase (push, background GPS) is blocked on
enrolling in the Apple Developer Program (FIG-463). Hand-generating an Xcode
project without being able to open it in Xcode to verify risks a scaffold
that looks right and doesn't actually build — so the iOS project is deferred
alongside the rest of iOS mobile work, not skipped. Bootstrapping it should
follow the same shape as `apps/mobile/ios` once that's unblocked.

## Running it

```bash
npm install
npm run android --workspace @figbloom/teacher-mobile   # device or emulator, API 26+
```

## Push notifications (FIG-1290)

The app registers for push after sign-in (`src/pushNotifications.ts`) and opens
the right screen when a notification is tapped (`src/pushTaps.ts`): a new chat
opens that conversation, a visitor opens Your visitors. The server already sends
these (`chat-push`, `visit-notify`) through one FCM service account, so the
teacher app is a **second Android app in the same Firebase project as
`apps/mobile`** (`figbloom-school-systems`), not a project of its own: no server
change, no second secret.

**One step only a person with the Firebase console can do:**

1. Firebase console, project `figbloom-school-systems`, Project settings, Add app,
   Android, package name `com.figbloom.teacher`.
2. Download the `google-services.json` it gives you and put it at
   `apps/teacher-mobile/android/app/google-services.json` (commit it, as
   `apps/mobile` commits its own: it is app configuration, not a secret). The
   downloaded file lists every Android app in the project, so it may also replace
   `apps/mobile`'s copy.
3. Rebuild the app. Until the file is there the app builds and runs normally and
   push simply doesn't register (the Gradle plugin is applied only when the file
   exists).

A release build from CI needs nothing extra once the file is committed:
`mobile-release-build.yml` builds from the repo and never touches
`google-services.json`, which is how `apps/mobile`'s committed copy is picked up
today.

## Structure

```
src/
  theme.ts            same tokens as apps/mobile, from @figbloom/shared
  navigation.tsx       bottom tabs (Attendance · Gradebook · Messages · Notices · More)
                        plus a "More" stack (Timetable · Classes · Leave · Buses · Account) —
                        8 screens don't fit a phone-width tab bar, so the 4 daily-use ones
                        get their own tab and the rest live under More
  screens/SignIn.tsx   same unified school+ID+password flow as apps/mobile — reused as-is
  screens/teacher/     Attendance · Gradebook · Messages · Notices · Timetable · Classes ·
                        Leave · Buses · More · Account
```

## What's shared vs. teacher-specific

Auth (`SignIn.tsx`, `resolveLoginId`/`searchSchools` from `@figbloom/shared`)
is identical to `apps/mobile` and copied as-is — sign-in doesn't vary by role.
`App.tsx`'s session logic is teacher-specific (single role, no branching)
since this binary only ever serves one role. The real screens read from
`@figbloom/shared` (fleet data for Buses, the same `listBusesOnRoutes` the web
admin and teacher consoles use; class/attendance/gradebook data similarly
lives there rather than duplicated per app) — any new teacher screen should
start by checking whether its data-fetching already exists there before
writing a new query against `apps/web/src/lib/teacherData.ts`'s tables.
