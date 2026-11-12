# Store assets (FIG-780)

Draft collateral for the Play Store / App Store listings. None of this has
had a design or legal pass — treat it as a first draft to react to, not
final copy.

- `icons/` — master 1024px and Play Console's 512px hi-res icon, exported
  from the same brand mark used for apps/mobile's launcher icon (FIG-778/779).
- `feature-graphic-mobile.png` — Play Store's 1024x500 banner for the one
  listing. Placeholder layout (mark + name + tagline); swap for a real design
  pass before submitting. (`feature-graphic-teacher.png` is left from the
  separate Teacher app and is not used.)
- `listing-copy.md` — short/long description draft, category, content rating,
  for the one app (parents, students, drivers, teachers, and the school's admins
  and office staff). There is one store listing: the Teacher app was merged in on
  2026-11-06 and had never been published.
- `screenshots/mobile/`, `screenshots/teacher/` — real phone screenshots
  (1080x2160, Play Store's required ≤2:1 ratio), captured from an actual
  signed release build on an emulator, signed into real seeded demo accounts
  (see `packages/shared/src/demo.ts`'s `DEMO_LOGINS`) — not mockups. Covers
  Home/Fees/Results for parents and Attendance/Gradebook for teachers, all
  screens of the one app. Still missing: screenshots of the admin screens (the
  overview, fees, people, buses) taken from a real build, and iPhone sizes for
  App Store once FIG-463 unblocks iOS (no Mac/simulator available here).

The privacy policy (`apps/web/public/privacy.html`) and the page on deleting
an account (`apps/web/public/delete-account.html`) live there, not here, so
they ship with the web app's normal deploy and are reachable at real URLs
without separate hosting. `data-safety.md` has the answers for Play's Data
safety form and permission declarations and for App Store Connect, and the
checklist of what is still yours to confirm (legal review, the inbox, the
domain, the target-audience answer, background location).
