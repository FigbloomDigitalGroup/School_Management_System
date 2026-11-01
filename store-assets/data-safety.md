# Store privacy answers (FIG-780, FIG-1002)

What to enter in Play Console (Data safety, App content, permission
declarations) and App Store Connect (App Privacy) so the listings match
`apps/web/public/privacy.html` and what the apps do. Worked out from the code
on 2026-10-29; re-check it whenever a feature that collects data is added.

Two apps: **Figbloom Schools** (`apps/mobile`: parent, student, driver) and
**Figbloom Teacher** (`apps/teacher-mobile`).

## URLs and contact

| Field | Value |
|---|---|
| Privacy policy URL | https://schoolmanagement.figbloom.org/privacy.html |
| Account deletion URL (Play: "Delete account URL") | https://schoolmanagement.figbloom.org/delete-account.html |
| Privacy contact | privacy@figbloom.org (**confirm it is a real, monitored inbox**) |
| Developer contact on the listing | Figbloom Digital Group, Enterprise Road, SMK Business Centre, Nairobi, Kenya; sales@figbloom.org; +254 796 286 676 |

Both pages are static files in `apps/web/public`, so they go live with the
web app's next deploy. Both apps link to them from Account ("Your data").

## Play Console: Data safety

**Collected data is encrypted in transit:** Yes (HTTPS everywhere).
**Users can ask for their data to be deleted:** Yes, with the URL above
(accounts are made by schools, so deletion goes through the school; the page
says so).
**Independent security review:** No.
**Shared with third parties:** No for every type below. The providers in the
privacy policy (Supabase, Google/Firebase, LiveKit, Safaricom, Resend, the AI
model provider) process data on our behalf, which Google's form does not count
as sharing. If your adviser reads it differently, mark the M-Pesa phone number
and Bloom text as shared with a payment processor and an AI provider.

### Figbloom Schools

| Data type | Collected | Required? | Why |
|---|---|---|---|
| Name | Yes | Required | Account management, app functionality |
| Email address | Yes | Optional (only where the school has one) | Account management |
| User IDs (school login ID) | Yes | Required | Account management |
| Phone number | Yes | Optional (M-Pesa payer, contacts) | App functionality |
| Address (home address, bus stop) | Yes | Optional | App functionality |
| Other personal info (date of birth, class, guardians, emergency contacts, bio data) | Yes | Optional | App functionality |
| Other financial info (fee balances, receipts, M-Pesa transaction codes; **no card numbers**) | Yes | Required for paying | App functionality |
| Health info (learner health profile, sick-bay and medication records, medication requests) | Yes | Optional | App functionality |
| Precise location (driver trips only) | Yes | Required for drivers | App functionality |
| Photos (profile photo, payment proof, prescription, chat) | Yes | Optional | App functionality |
| Files and docs (PDFs and documents sent in chat or to the school) | Yes | Optional | App functionality |
| Other in-app messages (chat; Bloom study helper) | Yes | Optional | App functionality |
| Device or other IDs (push token) | Yes | Required for notifications | App functionality |

**Not collected:** contacts, calendar, SMS, call logs, web browsing, search
history, installed apps, advertising ID, app interactions, crash logs or
diagnostics (there is no analytics or crash-reporting SDK).

**Voice and video calls and live classes.** Audio and video are relayed in real
time through LiveKit and are not recorded or stored. Google's definition treats
data that is only processed in memory to serve the request as ephemeral and not
collected, so these are left undeclared. If you would rather be cautious,
declare Voice or sound recordings and Videos as collected, optional, for app
functionality; nothing else on the form changes.

### Figbloom Teacher

Same as Figbloom Schools **except**: no precise location, no health info, no
phone/address/financial rows. Declare: Name, Email address, User IDs, Other
personal info (staff and learner names, marks and attendance entered), Photos,
Files and docs, Other in-app messages (chat and Bloom chat), Device or other IDs
(push token). Same call note as above.

## Play Console: App content

- **Target audience.** This needs a decision from you before submitting. The
  student app is used by schoolchildren, some under 13, on accounts a school
  creates. If you declare children in the target age range, Google's Families
  Policy applies (no advertising, only certified SDKs, a privacy policy that
  covers children, no collecting more than needed). The apps have no ads or
  analytics, but check each SDK (Firebase Messaging, Google Maps, LiveKit,
  react-native-blob-util) against the Families list before choosing. If you
  declare 13+ or adults only, say that the child accounts are created and run
  by schools.
- **Ads:** No.
- **Health apps declaration:** the apps are not health apps; they show a
  school's own sick-bay records. Answer "No health features" for the health
  apps form unless the reviewer asks.
- **Government / financial features:** the apps let a parent start an M-Pesa
  payment of school fees. Declare it under financial features as "payments to
  schools, via M-Pesa".

## Play Console: permission declarations

| Permission | App | Declaration |
|---|---|---|
| `ACCESS_BACKGROUND_LOCATION` | Schools | **Needs a declaration form and a demo video, or remove it** (see below). Core purpose: during an active school-bus trip the driver's phone reports the bus's position so parents and staff can follow the bus, including with the screen off. |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, `FOREGROUND_SERVICE` | Schools | Foreground service of type location, shown as a persistent notification while a trip is active. |
| `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT` | both | Photos to send, and voice and video calls and live classes (Bluetooth headsets). Camera and microphone hardware are optional. |
| `POST_NOTIFICATIONS` | both | Announcements, messages, trip updates, visitor arrivals. |
| `USE_BIOMETRIC` | both | Optional fingerprint app lock. |
| `READ_MEDIA_IMAGES` | Teacher | **Removed** (this change): photos come from the system photo picker, which needs no permission. |

**Background location: the decision that is yours.** The driver app currently
requires the phone's "Allow all the time" location setting before a trip can
start. Google only accepts that with a declaration and review, and wants an
in-app disclosure shown before the permission prompt. The alternative is to
drop `ACCESS_BACKGROUND_LOCATION` and rely on the foreground service alone,
which Android allows to keep reading location with the screen off when the
trip was started from the open app; it makes the review much simpler, but it
changes how the driver app behaves and has to be tried on a real phone through
a locked-screen trip. Nothing about it is changed in this PR.

## App Store Connect: App Privacy (iOS, when FIG-463 unblocks)

Data linked to the user, none used for tracking: Contact info (name, email,
phone, address), Health & fitness (health), Financial info (other financial
info), Precise location (drivers), User content (photos, files, messages),
Identifiers (user ID, device ID), Other data. Matches
`apps/mobile/ios/Figbloom/PrivacyInfo.xcprivacy`. App Review will also ask why
the driver app wants "Always" location: same wording as the Play declaration.
Add a "Delete account" path in the review notes (the page above plus the
school route).

## Before you submit

- [ ] Web app deployed, so both pages are live at the URLs above.
- [ ] privacy@figbloom.org exists and someone reads it.
- [ ] Production domain confirmed (it is also hard-coded in
      `packages/shared/src/legalLinks.ts`, `index.html`, `robots.txt`, `sitemap.xml`).
- [ ] Legal review of the policy (it covers children's data, health data and
      location in Kenya's Data Protection Act, 2019). Also check whether
      Figbloom Digital Group has to register with the Office of the Data
      Protection Commissioner as a data processor.
- [ ] Target-audience answer chosen (above), and the background-location
      decision made.
- [ ] If an SMS provider is used for fee reminders and absences, add it to the
      policy's provider table (none is in the code today).
