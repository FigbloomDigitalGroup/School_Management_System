# Figbloom mobile (Android)

The **parent** and **student** apps. Teachers and admins use the web console;
these two roles are phone-first, so they are native.

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
npm run android --workspace @figbloom/android   # device or emulator, API 26+
```

Android 8.0 (API 26) is the floor — it covers the low-cost handsets most
parents actually use.

## Structure

```
src/
  theme.ts            tokens from @figbloom/shared, as RN StyleSheet values
  storage.ts          AsyncStorage adapter for the shared WriteQueue
  navigation.tsx      bottom tabs per role
  screens/parent/     Home · Fees · Pay · Results · Inbox · Account
  screens/student/    Today · Timetable · Work · Results · Notices
```

## Things that differ from web on purpose

- **Push instead of polling.** Absence and fee notifications arrive as FCM
  pushes; the in-app inbox is the same list either way.
- **The queue survives a force-quit.** AsyncStorage, not memory — a parent on a
  matatu loses the app, not the payment state.
- **Offline reads.** The last fetched balance and results stay readable with no
  network, with the fetch time shown so nobody acts on a stale figure.
