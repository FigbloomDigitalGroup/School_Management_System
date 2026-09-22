# Figbloom Teacher (Android — iOS deferred)

The **teacher** app. A companion to `apps/mobile` (parent/student/driver), kept
as a separate binary/project since teachers' workflow (attendance, gradebook,
messaging) is a different shape from a parent's or student's. Bare React
Native, same toolchain as `apps/mobile` — not Expo — so there is one native
setup to maintain across both mobile apps (FIG-317).

## Status

Scaffold + real sign-in only. `Attendance`, `Gradebook` and `Messages` are
placeholder screens — real ones land in FIG-319/320/321.

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

## Structure

```
src/
  theme.ts            same tokens as apps/mobile, from @figbloom/shared
  navigation.tsx       bottom tabs — Attendance · Gradebook · Messages · Account
  screens/SignIn.tsx   same unified school+ID+password flow as apps/mobile — reused as-is
  screens/teacher/     Attendance · Gradebook · Messages · Account
```

## What's shared vs. teacher-specific

Auth (`SignIn.tsx`, `resolveLoginId`/`searchSchools` from `@figbloom/shared`)
is identical to `apps/mobile` and copied as-is — sign-in doesn't vary by role.
`App.tsx`'s session logic is teacher-specific (single role, no branching)
since this binary only ever serves one role. The real screens (FIG-319/320/321)
will read from the same `teaching_assignments`/`classes`/`announcements`
tables the web teacher console already uses (`apps/web/src/lib/teacherData.ts`)
— that data-fetching logic isn't in `@figbloom/shared` yet, so building those
screens should start by deciding whether to move it there (consistent with how
student/parent data-fetching already lives in `packages/shared`) rather than
duplicating it into this app.
