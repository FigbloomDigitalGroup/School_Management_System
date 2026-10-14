# Store assets (FIG-780)

Draft collateral for the Play Store / App Store listings. None of this has
had a design or legal pass — treat it as a first draft to react to, not
final copy.

- `icons/` — master 1024px and Play Console's 512px hi-res icon, exported
  from the same brand mark used for apps/mobile's launcher icon (FIG-778/779).
- `feature-graphic-mobile.png`, `feature-graphic-teacher.png` — Play Store's
  1024x500 banner. Placeholder layout (mark + name + tagline); swap for a
  real design pass before submitting.
- `listing-copy-mobile.md`, `listing-copy-teacher.md` — short/long
  description drafts, category, content rating.
- `screenshots/mobile/`, `screenshots/teacher/` — real phone screenshots
  (1080x2160, Play Store's required ≤2:1 ratio), captured from an actual
  signed release build on an emulator, signed into real seeded demo accounts
  (see `packages/shared/src/demo.ts`'s `DEMO_LOGINS`) — not mockups. Covers
  Home/Fees/Results for the parent app and Attendance/Gradebook for the
  teacher app. Still missing: a 7"/10" tablet set for Play, and iPhone sizes
  for App Store once FIG-463 unblocks iOS (no Mac/simulator available here).

The privacy policy lives at `apps/web/public/privacy.html` (not here) so it
ships with the web app's normal deploy and is reachable at a real URL
without separate hosting — see the note inside it before using it for a
real submission (no legal review yet, confirm the contact inbox is real).
