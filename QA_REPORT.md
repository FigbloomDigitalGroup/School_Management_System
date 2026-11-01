# School Management System: final QA report and release recommendation

Prepared 2026-11-01. It answers one question: **is the system safe to release, and what is the evidence?** It collects the results of QA 01 to QA 18 ([FIG-1234](https://linear.app/figbloom/issue/FIG-1234) to [FIG-1251](https://linear.app/figbloom/issue/FIG-1251)); the only new testing in it is the re-run of every automated suite on the merged code (section 6). A copy is published as a Linear document on [FIG-1252](https://linear.app/figbloom/issue/FIG-1252).

Everything was tested on a local copy of the system (local Supabase, a browser on a laptop, one Android phone). Nothing was run against the live demo or a production project. Numbers from a hosted project will differ.

---

## 1. Recommendation: NO-GO today

**NO-GO.** The system is close in the areas that hurt most when they go wrong (money paths, cross-school privacy, sign-in), but four things stop a release now:

1. **A school of 1,500 learners does not work yet.** On a realistic test school the admin Dashboard's attendance query takes 20.7 seconds and is cut off at 8 (a 500 error), a parent's payments list never loads and their home screen takes 9 seconds, and under load no parent could open the app cleanly at any size tried (15 to 500). One root cause is behind most of it (the permission check runs once per row) and a measured fix exists: [FIG-1496](https://linear.app/figbloom/issue/FIG-1496), [FIG-1497](https://linear.app/figbloom/issue/FIG-1497), [FIG-1500](https://linear.app/figbloom/issue/FIG-1500), all P1 and open.
2. **Money figures are wrong above 1,000 invoices.** The Dashboard and Reports add up only the first 1,000 invoices, so for a larger school the collected and billed amounts are wrong ([FIG-1438](https://linear.app/figbloom/issue/FIG-1438), P1, open). Four more reports share the same 1,000-row limit.
3. **Two critical areas could not be tested at all.** A real M-Pesa payment (BLOCKED: no Daraja keys exist locally) and a backup-and-restore drill (BLOCKED: no separate production project). Nothing was tested on a hosted project, and the new CI job has never run on GitHub. By the rules of this audit, no GO while a critical area is BLOCKED or NOT TESTED.
4. **113 of the 143 bugs found are still open in Linear**: 4 P1, 46 P2 and 63 P3 (the 30 closed ones are fixed on main; the register in section 4 says how each was re-checked).

**What held up:** no cross-site-scripting, no live secret in the code or its history, no way found to read another school's files, the one P0 (a permission check that let callers through) was found, fixed by Michael and re-tested, the payment code is correct under concurrent use (20 simultaneous payments of 10,000 all land; 4 simultaneous payments of 400,000 against a 1,000,000 invoice leave exactly 2), and 30 bugs, most of them in the money and sign-in paths, were fixed on main while the audit ran.

**What would make this a CONDITIONAL GO** (each condition is on the roadmap in section 7): the four open P1s fixed and re-measured on the 1,500-learner test school; a live M-Pesa test with real Daraja sandbox keys; one restore drill on a production project that is separate from the demo one; the whole test suite run once in CI and once against a staging project; and the owners reading the open P2 list and accepting in writing any they ship with. A smaller pilot (a school well under 1,000 learners, few parents opening at once) is the owners' call; the evidence here neither supports nor rules it out, because only a 1,512-learner school was load-tested.

---

## 2. How it was tested

| | |
|---|---|
| Code tested | branch `dev-essy` with `main` (0015960, pull request #219) merged in, locally; 132 database migrations; nothing pushed |
| Database | a local Supabase stack, reset and reseeded for the final run (11 schools, 419 learners at Alliance High School and Kijani Ridge Academy) |
| Browser | Microsoft Edge driven by Playwright |
| Phones | one real Samsung Galaxy A14 (Android 15), debug builds; no emulator, no iPhone |
| Load | k6 0.54.0 on the same laptop, a 1,512-learner school, 60 teachers, 500 parents |
| Not touched | the demo and production projects, hosted Supabase and Vercel, live Daraja (M-Pesa), iOS |

The audit ran in 19 steps, QA 01 to QA 19. Each step ended with a status comment on its Linear issue and each failure became its own bug issue (label Bug, assigned to Michael, severity P0 to P3 in the title). Those comments are the primary evidence; this report collects them.

---

## 3. Coverage matrix

Status is the one status in each step's closing comment. "Blocked / not tested" lists what the step could not do.

| QA | Area | Status | Bugs (P0 / P1 / P2 / P3) | Blocked or not tested |
|---|---|---|---|---|
| [01](https://linear.app/figbloom/issue/FIG-1234) | Baseline: typecheck, lint, unit, edge, browser | PASS | 0 / 0 / 1 / 0 | code coverage (the coverage package is not installed, so no figure exists) |
| [02](https://linear.app/figbloom/issue/FIG-1235) | Test environment and integration tests | PASS | 0 / 0 / 0 / 1 | `npm run db:fresh` end to end was run in pieces only |
| [03](https://linear.app/figbloom/issue/FIG-1236) | Cross-school isolation | FAIL | 1 / 1 / 1 / 1 | `chat-files` bucket; 74 tables with no seed rows to test cross-references; 53 helper-function cells inconclusive |
| [04](https://linear.app/figbloom/issue/FIG-1237) | Roles inside a school | FAIL | 0 / 0 / 3 / 0 | 9 checks with no seed rows |
| [05](https://linear.app/figbloom/issue/FIG-1238) | Recording payments | FAIL | 0 / 1 / 2 / 1 | waivers, discounts, bursaries, refunds, reversals are not in the product |
| [06](https://linear.app/figbloom/issue/FIG-1239) | M-Pesa | FAIL | 0 / 0 / 3 / 3 | **a live Daraja run: BLOCKED**; reconciliation of pending payments recorded as a known gap |
| [07](https://linear.app/figbloom/issue/FIG-1240) | Money reconciliation | FAIL | 0 / 1 / 3 / 4 | the phone Pay and Fees screens on a device; platform invoices |
| [08](https://linear.app/figbloom/issue/FIG-1241) | Sign-in and accounts | FAIL | 0 / 0 / 2 / 5 | six functions that differed on main (ai-assist, reset-user-password, send-push, visit-notify, invite-org-admin, medical-notify) and delete-account were not tested then; the merged code passes the edge-function isolation tests but they were not re-tested one by one |
| [09](https://linear.app/figbloom/issue/FIG-1242) | Marks, grades, report cards | FAIL | 0 / 0 / 2 / 5 | CBC and higher-education gradebooks in a browser; the teacher phone app; PDF layout |
| [10](https://linear.app/figbloom/issue/FIG-1243) | Attendance | FAIL | 0 / 0 / 6 / 6 | an emulator pass (phone queue was covered in QA 17); no school over 1,000 learners seeded then |
| [11](https://linear.app/figbloom/issue/FIG-1244) | Learners and CSV import | FAIL | 0 / 0 / 6 / 9 | People on a phone; billing stop on archive; a real spreadsheet |
| [12](https://linear.app/figbloom/issue/FIG-1245) | School setup and timetable | FAIL | 0 / 0 / 3 / 8 | grading-scheme change (NOT APPLICABLE: none is stored); the other K-12-only addresses |
| [13](https://linear.app/figbloom/issue/FIG-1246) | Reports and dashboards | FAIL | 0 / 1 / 12 / 7 | date filters (NOT APPLICABLE: no report has a date range); audit "access" events |
| [14](https://linear.app/figbloom/issue/FIG-1247) | Security sweep | FAIL | 0 / 0 / 3 / 6 | **GitHub secret scanning, push protection, Actions settings (BLOCKED, 403)**; Google Cloud key restrictions; phone apps on a device |
| [15](https://linear.app/figbloom/issue/FIG-1248) | Database integrity | FAIL | 0 / 0 / 1 / 4 | hosted databases; failing rollbacks inside account functions; a large populated copy |
| [16](https://linear.app/figbloom/issue/FIG-1249) | UX and accessibility | FAIL | 0 / 0 / 5 / 11 | screen readers, other browsers, real devices, 200% zoom, print, colour-blindness, touch-target size, right-to-left |
| [17](https://linear.app/figbloom/issue/FIG-1250) | Phone apps | FAIL | 0 / 0 / 3 / 4 | **live M-Pesa, the Maps key and real push delivery (BLOCKED)**; iOS; the exam switcher and CBE entry on the device |
| [18](https://linear.app/figbloom/issue/FIG-1251) | Performance, load, CI, release readiness | FAIL | 0 / 3 / 2 / 2 | **backup and restore drill (BLOCKED)**; M-Pesa under load (BLOCKED); browser and phone rendering time; edge functions under load; an Android API 36 build; iOS |
| **Total** | | 2 PASS, 16 FAIL | **1 / 7 / 58 / 77** (143) | |

A FAIL means the step found at least one bug, not that the step failed to run. QA 18 was run in a second session and its test kit is described in section 6.

---

## 4. Defect register

All 143 bugs raised by the audit (142 by QA 18 time, one more, [FIG-1501](https://linear.app/figbloom/issue/FIG-1501), found in the re-run for this report). Severity is the P0 to P3 in the Linear title (Medium priority = P2, Low = P3). "Linear" is the issue's status in Linear on 2026-11-01. **Re-run** is what the 2026-11-01 re-run of the automated suites showed on the merged code (section 6):

- **fixed**: the test that used to record this bug as open now passes, or was rewritten to the fixed behaviour;
- **partly fixed**: main changed it and the test shows what is left;
- **covered**: closed in Linear and the checks that cover it pass, but no test names this bug alone;
- **still open**: a test, SQL check or browser spec still names it as open and nothing flipped;
- **not re-run**: no test or check in the suites names it (mostly performance, phone-app and CI findings), so Linear's status stands; this does not say it is fixed.

| FIG | Sev | QA | Linear | Re-run 2026-11-01 | What was wrong |
|---|---|---|---|---|---|
| [1295](https://linear.app/figbloom/issue/FIG-1295) | P2 | 01 | Done | covered | 33 database access rules lacked a role, so anonymous callers got errors |
| [1296](https://linear.app/figbloom/issue/FIG-1296) | P3 | 02 | Backlog | not re-run | A second browser-test run hits the login-ID lookup limit |
| [1297](https://linear.app/figbloom/issue/FIG-1297) | P0 | 03 | Done | covered | Permission checks that could not tell yes from no let callers through |
| [1312](https://linear.app/figbloom/issue/FIG-1312) | P1 | 03 | Done | covered | A suspended organization's admin still ran four account functions |
| [1313](https://linear.app/figbloom/issue/FIG-1313) | P2 | 03 | Done | covered | An admin could save rows pointing at another school's records |
| [1314](https://linear.app/figbloom/issue/FIG-1314) | P3 | 03 | Done | covered | Three helper functions acted for people who were not the owner |
| [1303](https://linear.app/figbloom/issue/FIG-1303) | P2 | 04 | Backlog | not re-run | Teachers can read every family's fees, documents, health and marks |
| [1304](https://linear.app/figbloom/issue/FIG-1304) | P2 | 04 | Backlog | not re-run | Every school user can read the vehicles table |
| [1305](https://linear.app/figbloom/issue/FIG-1305) | P2 | 04 | Backlog | still open | An archived learner can still sign in |
| [1315](https://linear.app/figbloom/issue/FIG-1315) | P2 | 05 | Done | fixed | An invoice total could be edited by hand with no audit event |
| [1316](https://linear.app/figbloom/issue/FIG-1316) | P2 | 05 | Done | fixed | A payment could push the paid amount above the total |
| [1317](https://linear.app/figbloom/issue/FIG-1317) | P3 | 05 | Done | covered | "Pay half" offered 40 to 67 percent of the balance |
| [1319](https://linear.app/figbloom/issue/FIG-1319) | P1 | 05 | Done | fixed | An invoice with payments could be deleted, payments and all, with no audit |
| [1320](https://linear.app/figbloom/issue/FIG-1320) | P2 | 06 | Done | covered | Any signed-in user could send an M-Pesa prompt to any phone |
| [1321](https://linear.app/figbloom/issue/FIG-1321) | P2 | 06 | Done | fixed | The M-Pesa double-tap guard was not atomic and failed open |
| [1322](https://linear.app/figbloom/issue/FIG-1322) | P2 | 06 | Done | fixed | An empty or null M-Pesa result code was read as paid |
| [1323](https://linear.app/figbloom/issue/FIG-1323) | P3 | 06 | Done | fixed | Two simultaneous callbacks wrote the audit event twice |
| [1324](https://linear.app/figbloom/issue/FIG-1324) | P3 | 06 | Done | fixed | A JSON null body gave an unhandled 500 from the M-Pesa function |
| [1325](https://linear.app/figbloom/issue/FIG-1325) | P3 | 06 | Done | covered | A dead web screen kept a fake "received" timer |
| [1327](https://linear.app/figbloom/issue/FIG-1327) | P1 | 07 | Done | fixed | The parent's Fees screen could show an older term's invoice and Pay would pay it |
| [1328](https://linear.app/figbloom/issue/FIG-1328) | P2 | 07 | Done | fixed | The same bank slip could be credited twice on one invoice |
| [1329](https://linear.app/figbloom/issue/FIG-1329) | P2 | 07 | Done | fixed | Fee item changes left no audit event |
| [1330](https://linear.app/figbloom/issue/FIG-1330) | P2 | 07 | Done | fixed | Changing the school's payment details was unaudited and unchecked |
| [1331](https://linear.app/figbloom/issue/FIG-1331) | P3 | 07 | Done | fixed | The billing audit event came from the plan, not what was saved |
| [1332](https://linear.app/figbloom/issue/FIG-1332) | P3 | 07 | Done | covered | The demo seed data did not reconcile with its payments |
| [1333](https://linear.app/figbloom/issue/FIG-1333) | P3 | 07 | Done | covered | An invoice's status never became overdue |
| [1334](https://linear.app/figbloom/issue/FIG-1334) | P3 | 07 | Done | fixed | Cents were rounded and M-Pesa could not clear them |
| [1336](https://linear.app/figbloom/issue/FIG-1336) | P2 | 08 | Done | fixed | Rate limits trusted headers the caller sets |
| [1337](https://linear.app/figbloom/issue/FIG-1337) | P2 | 08 | Done | fixed | Organization sign-up marked any email address as confirmed |
| [1338](https://linear.app/figbloom/issue/FIG-1338) | P3 | 08 | Done | partly fixed: the flag clears only when the password changes; the rest is by design (see 5.2) | First-sign-in rule and password length were enforced by screens only |
| [1339](https://linear.app/figbloom/issue/FIG-1339) | P3 | 08 | Done | partly fixed: tokens last 15 minutes; a signed token cannot be recalled | An old access token kept reading data for an hour after sign-out |
| [1340](https://linear.app/figbloom/issue/FIG-1340) | P3 | 08 | Done | fixed | Signing out on one device ended every session |
| [1341](https://linear.app/figbloom/issue/FIG-1341) | P3 | 08 | Done | fixed | Forgot-password stopped working for trial or overdue schools |
| [1342](https://linear.app/figbloom/issue/FIG-1342) | P3 | 08 | Done | fixed | Functions returned raw database error text |
| [1374](https://linear.app/figbloom/issue/FIG-1374) | P2 | 09 | Backlog | still open | The gradebook counts a refused mark as entered |
| [1375](https://linear.app/figbloom/issue/FIG-1375) | P3 | 09 | Backlog | still open | The server publishes a class with learners missing |
| [1376](https://linear.app/figbloom/issue/FIG-1376) | P3 | 09 | Backlog | still open | A mark's "entered by" can name someone else |
| [1377](https://linear.app/figbloom/issue/FIG-1377) | P3 | 09 | Backlog | still open | A higher-education mark above the total is accepted |
| [1387](https://linear.app/figbloom/issue/FIG-1387) | P2 | 09 | Backlog | still open | Changing the term keeps the old term's exams ticked |
| [1388](https://linear.app/figbloom/issue/FIG-1388) | P3 | 09 | Backlog | still open | Report cards include marks the class never published |
| [1389](https://linear.app/figbloom/issue/FIG-1389) | P3 | 09 | Backlog | still open | A sent report card can be rewritten through the API |
| [1400](https://linear.app/figbloom/issue/FIG-1400) | P2 | 10 | Backlog | still open | A register is filed under the phone's UTC date |
| [1401](https://linear.app/figbloom/issue/FIG-1401) | P2 | 10 | Backlog | still open | Dashboard "attendance today" shows the latest register on file |
| [1402](https://linear.app/figbloom/issue/FIG-1402) | P2 | 10 | Backlog | still open | Reports read attendance unpaged (1,000-row cap) |
| [1403](https://linear.app/figbloom/issue/FIG-1403) | P2 | 10 | Backlog | still open | A held register is sent or lost by whoever signs in next |
| [1404](https://linear.app/figbloom/issue/FIG-1404) | P2 | 10 | Backlog | still open | A parent's attendance percentage counts every term |
| [1405](https://linear.app/figbloom/issue/FIG-1405) | P2 | 10 | Backlog | not re-run | The promised 09:00 absence text message is never sent |
| [1406](https://linear.app/figbloom/issue/FIG-1406) | P3 | 10 | Backlog | fixed | A corrected register overwrites who took it, with no trace |
| [1407](https://linear.app/figbloom/issue/FIG-1407) | P3 | 10 | Backlog | still open | An attendance row is not checked against the learner's class |
| [1408](https://linear.app/figbloom/issue/FIG-1408) | P3 | 10 | Backlog | still open | The group "present today" leaves out late arrivals |
| [1409](https://linear.app/figbloom/issue/FIG-1409) | P3 | 10 | Backlog | still open | An archived learner is counted in "here" but not "on roll" |
| [1410](https://linear.app/figbloom/issue/FIG-1410) | P3 | 10 | Backlog | still open | A held register overwrites a newer one |
| [1411](https://linear.app/figbloom/issue/FIG-1411) | P3 | 10 | Backlog | still open | Submit works before the roster has loaded |
| [1412](https://linear.app/figbloom/issue/FIG-1412) | P2 | 11 | Backlog | still open | An impossible birth date loses the whole import |
| [1413](https://linear.app/figbloom/issue/FIG-1413) | P2 | 11 | Backlog | still open | The duplicate check ignores archived learners |
| [1414](https://linear.app/figbloom/issue/FIG-1414) | P2 | 11 | Backlog | fixed | The import's allergies and medical columns never saved |
| [1415](https://linear.app/figbloom/issue/FIG-1415) | P3 | 11 | Backlog | not re-run | The import sends every row in one request |
| [1416](https://linear.app/figbloom/issue/FIG-1416) | P2 | 11 | Backlog | still open | People and Dashboard see only the first 1,000 learners |
| [1417](https://linear.app/figbloom/issue/FIG-1417) | P2 | 11 | Backlog | still open | "Change class" and "Export" only show a message |
| [1418](https://linear.app/figbloom/issue/FIG-1418) | P2 | 11 | Backlog | still open | A class change hides the family's published marks |
| [1419](https://linear.app/figbloom/issue/FIG-1419) | P3 | 11 | Backlog | still open | A deleted learner's login stays and can sign in |
| [1420](https://linear.app/figbloom/issue/FIG-1420) | P3 | 11 | Backlog | still open | Promote leaves leavers with no archive stamp or audit |
| [1421](https://linear.app/figbloom/issue/FIG-1421) | P3 | 11 | Backlog | still open | Nothing limits a learner's date of birth |
| [1422](https://linear.app/figbloom/issue/FIG-1422) | P3 | 11 | Backlog | still open | A refused add or import shows no reason |
| [1423](https://linear.app/figbloom/issue/FIG-1423) | P3 | 11 | Backlog | still open | Import line numbers shift; "yess" is read as day scholar |
| [1424](https://linear.app/figbloom/issue/FIG-1424) | P3 | 11 | Backlog | still open | Search misses admission numbers that contain a letter |
| [1425](https://linear.app/figbloom/issue/FIG-1425) | P3 | 11 | Backlog | still open | A quoted line break splits a CSV cell |
| [1426](https://linear.app/figbloom/issue/FIG-1426) | P3 | 11 | Backlog | still open | CSV export lets text run as a spreadsheet formula |
| [1427](https://linear.app/figbloom/issue/FIG-1427) | P2 | 12 | Backlog | still open | A refused new term leaves the school with no current term |
| [1428](https://linear.app/figbloom/issue/FIG-1428) | P2 | 12 | Backlog | still open | Deleting an emptied class deletes the attendance it held |
| [1429](https://linear.app/figbloom/issue/FIG-1429) | P2 | 12 | Backlog | still open | A teacher can be put in two classes at the same time |
| [1430](https://linear.app/figbloom/issue/FIG-1430) | P3 | 12 | Backlog | still open | A subject or term with records can be deleted unchecked |
| [1431](https://linear.app/figbloom/issue/FIG-1431) | P3 | 12 | Backlog | still open | A refused timetable save wipes the timetable |
| [1432](https://linear.app/figbloom/issue/FIG-1432) | P3 | 12 | Backlog | still open | Terms can overlap or run out of order |
| [1433](https://linear.app/figbloom/issue/FIG-1433) | P3 | 12 | Backlog | still open | Overlapping leave requests are accepted |
| [1434](https://linear.app/figbloom/issue/FIG-1434) | P3 | 12 | Backlog | still open | Cover: busy teacher offered, no notice when withdrawn |
| [1435](https://linear.app/figbloom/issue/FIG-1435) | P3 | 12 | Backlog | still open | A class with marks can be moved to another level |
| [1436](https://linear.app/figbloom/issue/FIG-1436) | P3 | 12 | Backlog | still open | A subject's form range can run backwards |
| [1437](https://linear.app/figbloom/issue/FIG-1437) | P3 | 12 | Backlog | still open | The other institution type's screens open by address |
| [1438](https://linear.app/figbloom/issue/FIG-1438) | P1 | 13 | Backlog | still open | Dashboard and Reports add up only the first 1,000 invoices |
| [1439](https://linear.app/figbloom/issue/FIG-1439) | P2 | 13 | Backlog | still open | Reports work out class means from the first 1,000 marks |
| [1440](https://linear.app/figbloom/issue/FIG-1440) | P2 | 13 | Backlog | still open | Reports show "387 of 43" marks entered |
| [1441](https://linear.app/figbloom/issue/FIG-1441) | P2 | 13 | Backlog | still open | Reports show a class mean from unpublished marks |
| [1442](https://linear.app/figbloom/issue/FIG-1442) | P2 | 13 | Backlog | still open | "Active tenants" shows 11 while only 6 are active |
| [1443](https://linear.app/figbloom/issue/FIG-1443) | P2 | 13 | Backlog | still open | Group fees add up every term, not the current one |
| [1444](https://linear.app/figbloom/issue/FIG-1444) | P3 | 13 | Backlog | still open | Group "present today" is stale after midnight |
| [1445](https://linear.app/figbloom/issue/FIG-1445) | P3 | 13 | Backlog | still open | A new school's Dashboard says "Loading" for ever |
| [1446](https://linear.app/figbloom/issue/FIG-1446) | P2 | 13 | Backlog | still open | Platform buttons say an action happened that did not |
| [1447](https://linear.app/figbloom/issue/FIG-1447) | P3 | 13 | Backlog | not re-run | "New announcement" only shows a message |
| [1448](https://linear.app/figbloom/issue/FIG-1448) | P3 | 13 | Backlog | not re-run | Hard-coded figures are shown as if real |
| [1449](https://linear.app/figbloom/issue/FIG-1449) | P2 | 13 | Backlog | still open | Usage seats add up all 11 schools and count staff as seats |
| [1450](https://linear.app/figbloom/issue/FIG-1450) | P2 | 13 | Backlog | still open | Usage reads every learner unpaged, so seats are too low |
| [1451](https://linear.app/figbloom/issue/FIG-1451) | P2 | 13 | Backlog | still open | "MRR" is a sum of per-term prices |
| [1452](https://linear.app/figbloom/issue/FIG-1452) | P2 | 13 | Backlog | still open | Audit-trail cards count only the latest 200 events |
| [1453](https://linear.app/figbloom/issue/FIG-1453) | P2 | 13 | Backlog | still open | The platform admin can edit or delete impersonation sessions |
| [1454](https://linear.app/figbloom/issue/FIG-1454) | P3 | 13 | Backlog | still open | Impersonation log cards miscount |
| [1455](https://linear.app/figbloom/issue/FIG-1455) | P3 | 13 | Backlog | still open | Strand CSV error lines shift after a blank line |
| [1456](https://linear.app/figbloom/issue/FIG-1456) | P3 | 13 | Backlog | not re-run | Errors are plain objects, so the reason is hidden in 178 places |
| [1457](https://linear.app/figbloom/issue/FIG-1457) | P2 | 14 | Backlog | not re-run | No GitHub rule makes CI pass before a merge |
| [1458](https://linear.app/figbloom/issue/FIG-1458) | P2 | 14 | Backlog | still open | The release workflow installs with install scripts on |
| [1459](https://linear.app/figbloom/issue/FIG-1459) | P2 | 14 | Backlog | still open | No Content-Security-Policy, referrer, nosniff or frame headers |
| [1460](https://linear.app/figbloom/issue/FIG-1460) | P3 | 14 | Backlog | still open | The photo bucket accepts any file type and size |
| [1461](https://linear.app/figbloom/issue/FIG-1461) | P3 | 14 | Backlog | still open | Any teacher can replace the logo and others' photos |
| [1462](https://linear.app/figbloom/issue/FIG-1462) | P3 | 14 | Backlog | still open | The security scan misses six ways of planting code |
| [1463](https://linear.app/figbloom/issue/FIG-1463) | P3 | 14 | Backlog | still open | npm audit reports 31 findings in the phone apps and tooling |
| [1464](https://linear.app/figbloom/issue/FIG-1464) | P3 | 14 | Backlog | not re-run | Bus location history is never deleted |
| [1465](https://linear.app/figbloom/issue/FIG-1465) | P3 | 14 | Backlog | not re-run | No way to ask for an account or its data to be deleted |
| [1466](https://linear.app/figbloom/issue/FIG-1466) | P2 | 15 | Backlog | still open | An admin can put another school's learner on a bus trip |
| [1467](https://linear.app/figbloom/issue/FIG-1467) | P3 | 15 | Backlog | still open | The learner delete guard misses report cards, health and more |
| [1468](https://linear.app/figbloom/issue/FIG-1468) | P3 | 15 | Backlog | still open | Simultaneous account creations get the same login number |
| [1469](https://linear.app/figbloom/issue/FIG-1469) | P3 | 15 | Backlog | still open | schema.sql and rls.sql claim to be the source of truth and are not |
| [1470](https://linear.app/figbloom/issue/FIG-1470) | P3 | 15 | Backlog | still open | Account functions ignore a failed audit entry |
| [1471](https://linear.app/figbloom/issue/FIG-1471) | P2 | 16 | Backlog | still open | Every dialog is wider than a phone screen |
| [1472](https://linear.app/figbloom/issue/FIG-1472) | P2 | 16 | Backlog | still open | The Announcements composer overlaps and Send is cut off on a phone |
| [1473](https://linear.app/figbloom/issue/FIG-1473) | P2 | 16 | Backlog | still open | The fee screens do not fit a phone |
| [1474](https://linear.app/figbloom/issue/FIG-1474) | P2 | 16 | Backlog | still open | A failed request shows an empty list instead of an error |
| [1475](https://linear.app/figbloom/issue/FIG-1475) | P2 | 16 | Backlog | still open | One failed profile read signs the person out |
| [1476](https://linear.app/figbloom/issue/FIG-1476) | P3 | 16 | Backlog | still open | The shared table has ARIA roles without a table |
| [1477](https://linear.app/figbloom/issue/FIG-1477) | P3 | 16 | Backlog | still open | 14 scrolling panes on a phone cannot be reached by keyboard |
| [1478](https://linear.app/figbloom/issue/FIG-1478) | P3 | 16 | Backlog | still open | Three colours fail the 4.5 to 1 contrast minimum on every screen |
| [1479](https://linear.app/figbloom/issue/FIG-1479) | P3 | 16 | Backlog | still open | The sign-in page has no form, so Enter does nothing |
| [1480](https://linear.app/figbloom/issue/FIG-1480) | P3 | 16 | Backlog | still open | Dialogs do not keep Tab inside or return focus |
| [1481](https://linear.app/figbloom/issue/FIG-1481) | P3 | 16 | Backlog | still open | Twelve more screens do not fit a phone |
| [1482](https://linear.app/figbloom/issue/FIG-1482) | P3 | 16 | Backlog | still open | Very long names push five phone screens sideways |
| [1483](https://linear.app/figbloom/issue/FIG-1483) | P3 | 16 | Backlog | still open | The Largest text size breaks six screens |
| [1484](https://linear.app/figbloom/issue/FIG-1484) | P3 | 16 | Backlog | still open | The driver's page has no Accessibility button |
| [1485](https://linear.app/figbloom/issue/FIG-1485) | P3 | 16 | Backlog | still open | The organization sign-up page is wider than a phone |
| [1486](https://linear.app/figbloom/issue/FIG-1486) | P3 | 16 | Backlog | still open | The organization picker changes the address while drawing |
| [1487](https://linear.app/figbloom/issue/FIG-1487) | P2 | 17 | Backlog | not re-run | Opening the phone app with no signal shows the sign-in screen |
| [1488](https://linear.app/figbloom/issue/FIG-1488) | P2 | 17 | Backlog | not re-run | A driver app closed mid-trip says "in progress" while nothing tracks the bus |
| [1489](https://linear.app/figbloom/issue/FIG-1489) | P2 | 17 | Backlog | not re-run | Sign-out leaves the notification token, cached data and unsent writes |
| [1490](https://linear.app/figbloom/issue/FIG-1490) | P3 | 17 | Backlog | not re-run | Pings held in a dead zone are dropped silently at trip end |
| [1491](https://linear.app/figbloom/issue/FIG-1491) | P3 | 17 | Backlog | not re-run | A trip starts with Location off and nothing says why |
| [1492](https://linear.app/figbloom/issue/FIG-1492) | P3 | 17 | Backlog | not re-run | Two layout glitches in the phone app |
| [1493](https://linear.app/figbloom/issue/FIG-1493) | P3 | 17 | Backlog | not re-run | The homework due date is a bare text box |
| [1494](https://linear.app/figbloom/issue/FIG-1494) | P2 | 18 | Backlog | not re-run | Android apps target API 34 (Play wants 36); versionCode fixed at 1 |
| [1495](https://linear.app/figbloom/issue/FIG-1495) | P3 | 18 | Backlog | not re-run | A build without Supabase settings shows a blank page |
| [1496](https://linear.app/figbloom/issue/FIG-1496) | P1 | 18 | Backlog | not re-run | Admin Dashboard attendance query takes 20 s and is cut off at 8 s |
| [1497](https://linear.app/figbloom/issue/FIG-1497) | P1 | 18 | Backlog | still open: seen again (parent and student screens took 5 to 9 s on the seeded data) | Parent home takes 9 s and the payments list never loads |
| [1498](https://linear.app/figbloom/issue/FIG-1498) | P2 | 18 | Backlog | not re-run | Saving a register is slow and fails under a burst |
| [1499](https://linear.app/figbloom/issue/FIG-1499) | P3 | 18 | Backlog | not re-run | Every save recounts a group summary only group schools read |
| [1500](https://linear.app/figbloom/issue/FIG-1500) | P1 | 18 | Backlog | still open: the cause of the slow parent and student screens | Permission checks run once per row and scale with the whole platform |
| [1501](https://linear.app/figbloom/issue/FIG-1501) | P2 | 13 | Backlog | new: found in this re-run | Reports leave archived learners' invoices out; Fees and Dashboard count them |

Re-run tally (143 bugs): covered 10, not re-run 23, still open 87, fixed 20, partly fixed 2, new 1.

**Totals.** By severity: P0 1, P1 7, P2 58, P3 77. By Linear status: Done 30, Backlog 113. Open (Backlog) by severity: P1 4, P2 46, P3 63; no open P0. By assignee: Michael 137, Esther N. 5 ([FIG-1296](https://linear.app/figbloom/issue/FIG-1296), [1297](https://linear.app/figbloom/issue/FIG-1297), [1303](https://linear.app/figbloom/issue/FIG-1303), [1304](https://linear.app/figbloom/issue/FIG-1304), [1305](https://linear.app/figbloom/issue/FIG-1305)).

**Things to know about the register**

- Linear still lists [FIG-1406](https://linear.app/figbloom/issue/FIG-1406) and [FIG-1414](https://linear.app/figbloom/issue/FIG-1414) as Backlog, but the merged code already fixes them (main now audits every table, and the learner import records the family's consent form). They can be closed after a look.
- [FIG-1338](https://linear.app/figbloom/issue/FIG-1338) and [FIG-1339](https://linear.app/figbloom/issue/FIG-1339) are Done in Linear but only partly closed the gap (details in section 5.2).
- [FIG-1474](https://linear.app/figbloom/issue/FIG-1474) and [FIG-1475](https://linear.app/figbloom/issue/FIG-1475) were rated P2 for their effect; by the issue's own rule they would be P3.
- Four Bug issues created on 2026-10-28 ([FIG-1306](https://linear.app/figbloom/issue/FIG-1306), 1307, 1308, 1310) came from the landing-page and legal work, not this audit, and are not counted.
- Several QA closing comments say "Backlog" or "left in Todo" for issues that have since moved to Done. Linear is the live record.

---

## 5. Findings by theme

### 5.1 Security: held up, with gaps to close before release

- **Cross-school privacy.** Every table that carries a school id was probed as every kind of user from the other school (`tenant_matrix.sql`: 960 checks, 0 failures on the final run), plus 28 storage tests and 46 edge-function tests; none could read or change another school's data. The cross-school reference holes (an admin saving a row that points at another school's learner, [FIG-1313](https://linear.app/figbloom/issue/FIG-1313)) were fixed on main and are checked by `same_school_refs.sql` (25 PASS) and `cross_school_references.sql` (32 PASS). One is still open: a school admin can put another school's learner on a bus trip ([FIG-1466](https://linear.app/figbloom/issue/FIG-1466), P2).
- **The one P0** ([FIG-1297](https://linear.app/figbloom/issue/FIG-1297)): permission checks answered "can't tell" in a way that let callers through. Fixed (pull request #181) and re-tested (`null_guards.sql`, 23 PASS).
- **Sign-in and accounts.** Rate limits keyed on headers a caller sets ([FIG-1336](https://linear.app/figbloom/issue/FIG-1336)), organization sign-up that marked any email as confirmed ([FIG-1337](https://linear.app/figbloom/issue/FIG-1337)), and a sign-out that ended every device's session ([FIG-1340](https://linear.app/figbloom/issue/FIG-1340)) were all fixed on main. An archived learner can still sign in ([FIG-1305](https://linear.app/figbloom/issue/FIG-1305), open) and teachers can read every family's fees, documents, health and marks ([FIG-1303](https://linear.app/figbloom/issue/FIG-1303), open: needs a decision on whether that is intended).
- **Web and pipeline.** No cross-site scripting (42 checks over about 40 screens) and no live secret (330 commits scanned, 8 findings, none live). Open: no Content-Security-Policy or other security headers ([FIG-1459](https://linear.app/figbloom/issue/FIG-1459)); no GitHub rule makes CI pass before a merge ([FIG-1457](https://linear.app/figbloom/issue/FIG-1457), needs a repo admin); the release workflow installs packages with install scripts on, on the machine that holds the signing key ([FIG-1458](https://linear.app/figbloom/issue/FIG-1458)); the public photo bucket accepts any file type ([FIG-1460](https://linear.app/figbloom/issue/FIG-1460), [1461](https://linear.app/figbloom/issue/FIG-1461)); 31 `npm audit` findings, all in the phone apps and dev tooling ([FIG-1463](https://linear.app/figbloom/issue/FIG-1463)).
- **Not verified:** GitHub's own secret scanning, push protection and Actions settings (the token got 403), Google Cloud key restrictions.

### 5.2 Data integrity and money

- **The payment code is sound.** Amounts, methods and status changes were worked out by hand on a 1,000,000-cent invoice; concurrent payments behave (4 at once for 400,000 gives exactly 2; 20 at once for 10,000 gives 20; 2 at once for the whole balance gives 1). Removing the row lock in a test made the tests fail, so they would catch that mistake.
- **Fixed on main during the audit (30 bugs):** deleting an invoice that has payments, hand-editing a total, overpayment, "Pay half" rounding, cents that M-Pesa cannot clear, the same bank slip twice, unaudited fee and payment-detail changes, the parent seeing an older term's invoice, any user prompting any phone, the double-tap guard, empty result codes read as paid, and more. Their tests now pass; the money-path SQL check (`fees.sql`) went from 45 PASS and 5 known gaps to 108 PASS and none.
- **Partly fixed:** [FIG-1338](https://linear.app/figbloom/issue/FIG-1338) (first-sign-in password): the flag now clears only when the password changes, and a profile edit cannot clear it; the server still answers other requests while the flag is set, which main chose on purpose (whoever holds the temporary password can choose a new one first). The 8-character minimum is now in `config.toml` (needs the stack restarted locally and the hosted setting changed by hand). [FIG-1339](https://linear.app/figbloom/issue/FIG-1339) (token after sign-out): access tokens now last 15 minutes instead of an hour; a signed token cannot be recalled, so the window is shorter, not closed.
- **Still wrong or open:** report figures built on the first 1,000 rows ([FIG-1438](https://linear.app/figbloom/issue/FIG-1438) P1, [1439](https://linear.app/figbloom/issue/FIG-1439), [1402](https://linear.app/figbloom/issue/FIG-1402), [1416](https://linear.app/figbloom/issue/FIG-1416), [1450](https://linear.app/figbloom/issue/FIG-1450)); a figure that compares unlike things or mixes terms ([FIG-1440](https://linear.app/figbloom/issue/FIG-1440), [1441](https://linear.app/figbloom/issue/FIG-1441), [1443](https://linear.app/figbloom/issue/FIG-1443), [1449](https://linear.app/figbloom/issue/FIG-1449), [1451](https://linear.app/figbloom/issue/FIG-1451), [1452](https://linear.app/figbloom/issue/FIG-1452), and the new [FIG-1501](https://linear.app/figbloom/issue/FIG-1501)); buttons that say they did something and did not ([FIG-1417](https://linear.app/figbloom/issue/FIG-1417), [1446](https://linear.app/figbloom/issue/FIG-1446)); attendance filed under the wrong day ([FIG-1400](https://linear.app/figbloom/issue/FIG-1400)); deleting a class or term silently removes the records under it ([FIG-1428](https://linear.app/figbloom/issue/FIG-1428), [1430](https://linear.app/figbloom/issue/FIG-1430)); a class change hides a family's published marks ([FIG-1418](https://linear.app/figbloom/issue/FIG-1418)).
- **Not in the product** (recorded, not filed): waivers, discounts, bursaries, arrears carry-forward, refunds, reversals, overpayment credit, and a scheduled job that reconciles pending M-Pesa payments.

### 5.3 Performance (QA 18, local, 1,512 learners)

| What | Result |
|---|---|
| Admin Dashboard, latest register date | 20,693 ms; the app gets a 500 at 8 s |
| A parent's payments list | 10,832 ms; the app gets a 500 at 8 s, so it never loads |
| Parent home screen (13 requests) | 8,669 ms |
| A whole term of attendance (68,040 rows), admin | 21,217 ms with the permission rules, 17 ms without |
| Saving a 42-learner register | 1,315 ms (3,174 ms for a correction) |
| 60 teachers saving at the same instant | whole flow p50 15 to 18 s, p95 23 to 26 s; 7 to 17 of 479 requests failed |
| 60 teachers spread over 5 minutes | 0 errors; save p50 1.29 s, p95 1.42 s |
| 100 payments by 20 clerks | 0 errors; p50 40 to 50 ms, p95 about 155 ms |
| Parents opening the app (15 / 30 / 60 / 120 / 500 over a minute) | 0 clean opens at every size |
| Password sign-ins | about 170 a second; 250 at once dropped 14 |

**Seen again on the small seeded data.** In the final re-run (11 schools, 419 learners, 380 payments) the signed-in parent and student screens took 5 to 9 seconds to show a child in the browser, which broke several 5-second waits in the browser specs until they were lengthened (each is commented with FIG-1497). Straight in the database, as the seeded parent: counting the 2 learner rows took 1.6 s, the invoices 1.8 s, the payments 1.6 s and the 10 attendance rows 9 s, because every row on the platform is checked before the parent’s own rows are kept. So the slowness does not need a big school; it grows with the size of the whole platform. When the test databases held about 1,600 learners and 7,800 invoices (after the money tests left their data behind), even an anonymous request for the student list passed its 3-second limit.

The database was the bottleneck in every failing run (about 1,000% CPU, 10 of 16 cores). The cause is one thing: the permission check (`has_perm`, `my_students`) runs once per row and `my_students()` scans every learner on the platform. Two rolled-back experiments show the size of the fix: an index on attendance took the Dashboard query from 20,693 ms to 0.56 ms, and splitting the 69 combined read-and-write policies took the register save from 1,315 to 223 ms. The web app ships about 1.55 MB (440 kB gzipped) on first sign-in, with no size budget. Rendering time in a browser or on a phone, and the edge functions under load, were not measured. **Caveat:** the schema changed under the QA 18 run (114 to 132 migrations) and another session was using the same database part of the time; the report on [FIG-1251](https://linear.app/figbloom/issue/FIG-1251) states which runs are on which schema.

### 5.4 Accessibility and usability (QA 16)

258 screen visits (86 screens at 1280, 768 and 390 px) were checked with axe-core, then by keyboard, with failed and slow requests, double clicks, long names and the accessibility settings. Nothing breaks at desktop width. At phone width 17 screens do not fit (every dialog is wider than the screen, so its Close button is off the edge, [FIG-1471](https://linear.app/figbloom/issue/FIG-1471)); three colours fail the 4.5-to-1 contrast minimum on 85 of 86 screens ([FIG-1478](https://linear.app/figbloom/issue/FIG-1478)); six screens show "0 total" or an empty list when a request fails instead of an error ([FIG-1474](https://linear.app/figbloom/issue/FIG-1474)); one failed profile read signs the person out ([FIG-1475](https://linear.app/figbloom/issue/FIG-1475)). Passing: the focus ring, loading states, double clicks (each of four flows sends one request) and the accessibility settings. Not checked: screen readers, other browsers, real devices, 200% zoom, print, touch-target size. The sign-in page is now also too wide for a 360 px phone (evidence added to [FIG-1485](https://linear.app/figbloom/issue/FIG-1485)), and the screens main added after QA 16 (the Bloom study helper, the front desk, the Other staff screens) are not in the walk.

### 5.5 Phone apps (QA 17, one real phone)

Parent, learner, teacher and driver apps were run on a Samsung Galaxy A14. The parent and learner screens match the database, the teacher's offline register queue held a register and sent it (42 rows), the driver's trip sent a location every 15 seconds, and the push prompt and token saved. Failing: opening the app with no signal shows the sign-in screen so the offline copy cannot be reached ([FIG-1487](https://linear.app/figbloom/issue/FIG-1487)); a driver app closed mid-trip reopens saying "Trip in progress" while nothing tracks the bus ([FIG-1488](https://linear.app/figbloom/issue/FIG-1488)); signing out leaves the notification token, cached family data and unsent writes on the phone ([FIG-1489](https://linear.app/figbloom/issue/FIG-1489)). Blocked: live M-Pesa, the Maps key, real push delivery. Not tested: iOS.

### 5.6 Operations and release readiness (QA 18)

- **CI:** a new job `database-and-browser` (start the local stack, seed, run every SQL check through `scripts/run-rls-checks.sh`, run the browser flows) was written and passes `actionlint`, but **it has not run on GitHub**. Running its parts here showed one thing it would hit on its first run: main's `e2e/flows.spec.ts` was out of date with two of main's own interface changes (the onboarding message and the new in-page confirm boxes); that is fixed in this branch (section 6). The integration tests are still not in CI. Making CI required before a merge needs a repo admin ([FIG-1457](https://linear.app/figbloom/issue/FIG-1457)). The runner `scripts/run-rls-checks.sh` ran here for the first time on the whole suite: 29 files, all pass.
- **Errors:** there is no error reporting anywhere, and a web build without its Supabase settings shows a blank white page on every app screen with nothing in the page ([FIG-1495](https://linear.app/figbloom/issue/FIG-1495)).
- **Runbook:** `RUNBOOK.md` (deploy and rollback for migrations and functions) was written from the repo and **has not been rehearsed**; no hosted project was linked.
- **Backup and restore drill:** BLOCKED until a production project separate from the demo exists.
- **Android:** both apps target API 34 and fix `versionCode` at 1 ([FIG-1494](https://linear.app/figbloom/issue/FIG-1494)); Google's rule (read through a web search, please confirm in Play Console) asks for API 36.

---

## 6. Automated testing report

Commands and results from the final run on 2026-11-01, on `dev-essy` with `main` merged, after a clean `npm run db:fresh` (132 migrations). Coverage was not measured: no coverage package is installed, so no percentage is claimed.

| Command | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors, 2 warnings (unused names in two landing files) |
| `npm run test:unit` (Vitest) | 1,377 tests in 76 files, all pass |
| `npm run test:edge` (Deno, edge functions) | 92 tests (633 steps), all pass |
| `sh scripts/run-rls-checks.sh` (29 SQL check files) | all 29 pass, 0 FAIL; 42 lines still marked KNOWN (open bugs) |
| `npm run test:integration` (Vitest against the local stack, 16 files) | 371 tests, all pass on a freshly reset database; the files that pay invoices also pass when run again on the same database |
| Browser specs (Playwright through Edge) | 12 specs, 223 tests, every one passing on its last run: flows 24, signin 8, reconciliation 5, gradebook 10, reportCards 10, attendance 13, learners 19, setup 19, xss 8, reports 68, usability 21, a11y 18 (tests that expect a known bug to fail count as passes). Six specs failed on first contact with the merged code and were repaired (below); usability and a11y were re-run only in part after their last fix (2 and 3 tests), and the large-scale part of reports (8 tests) after its last edit; everything else ran whole. Run whole, `reports` takes 11 minutes, `a11y` 15, `usability` 13 |
| Jest (`npm test` in each phone app) | 21 tests in 4 files (9 + 12), all pass |
| `sh scripts/security-scan.sh` | passed before the browser runs and again before the commit |

**What the merge changed in the tests.** Main fixed 17 bugs that the audit's tests had recorded as open ("known defect" markers that pass while a bug exists and fail the day it is fixed). Each flipped and was converted to a normal test: [FIG-1315](https://linear.app/figbloom/issue/FIG-1315), 1316, 1319, 1321, 1322, 1323, 1324, 1327, 1328, 1329, 1330, 1331, 1336, 1341, 1342, 1406, 1414, plus [FIG-1334](https://linear.app/figbloom/issue/FIG-1334) in the browser test. Other tests had to follow main's design changes: whole shillings only (a one-cent payment is now refused), the billing run is one `bill_term` call that writes its own audit event, the rate limit reads `cf-connecting-ip` only, proof-of-payment files and paid invoices can no longer be deleted, and the learner import needs the family's consent form for allergies. Two more known-defect tests had been passing for the wrong reason (the code they described had changed shape: [FIG-1337](https://linear.app/figbloom/issue/FIG-1337)'s signup test and [FIG-1340](https://linear.app/figbloom/issue/FIG-1340)'s sign-out test); they were removed or rewritten to model what the apps now do. Because paid invoices and their terms can no longer be deleted, the money tests leave their throwaway terms behind: each run uses a year of its own, so re-running works, and `npm run db:fresh` clears them.

**What the browser specs needed to follow main** (stale tests, not product bugs, except the last item): `e2e/flows.spec.ts`, main's own spec, still expected "Nothing was emailed or texted" (the card now says "Not emailed: email isn't set up yet...") and still answered the browser's confirm box, which main replaced with its own in-page box (commit `fbd3b2f`; helper `e2e/support/confirm.ts`, used by 4 specs); the sign-in page has five portals, not six (guard and reception became "Other staff"); the parent's Home and Bus screens load Google Maps, which nothing here can reach, so two specs answer its requests with nothing; the billing run is one `bill_term` call and its audit event comes from the database; the seed now has 300 real payments, so "0 payments" baselines were wrong; the parent and student screens take 5 to 9 seconds to show a child (FIG-1497), so six waits are longer and say why. One real finding came out of it: with an archived learner who has an invoice, Reports and Fees disagree on the collected percentage ([FIG-1501](https://linear.app/figbloom/issue/FIG-1501), new, P2); the sign-in page being 392 px wide (a 32 px sideways scroll at 360 px) was added as evidence to [FIG-1485](https://linear.app/figbloom/issue/FIG-1485), which shares its layout.

Leftovers: `e2e/reports.spec.ts` seeds 1,200 learners with paid invoices to pass 1,000 rows and, under main's delete guard, cannot remove them; run `npm run db:fresh` after it and before `e2e/reconciliation.spec.ts`. CI starts from a fresh database each run, so it is not affected.

**What the audit leaves in the repository** (all on `dev-essy`; committed locally, not pushed; the branch is protected, so it goes in by pull request): unit tests (`packages/shared`, `apps/web/src/lib`, `tests/security`), Deno tests for the edge functions, 29 SQL check files, 16 integration test files, 12 browser specs (including an accessibility walk over every screen and a usability spec), 4 Jest test files for the phone apps, and the QA 18 kit in `tests/load/` (a repeatable 1,512-learner school builder and k6 scenarios; see its README; still uncommitted). The README lists each suite and how to run it. Known bugs are written as tests that pass while the bug exists (`it.fails`, `test.fail()`, `KNOWN` lines in SQL) and fail the day it is fixed, so a fix is noticed: convert such a test to a plain one when that happens.

**Limits of these results.** The browser specs run on one browser (Edge) at three widths; the phone results are from one phone; the load numbers are from one laptop where the database, API, auth and load generator share the machine; the QA 03 to QA 14 results were first taken on a database that lacked some of main's migrations, and were re-run on the merged code for this report.

---

## 7. Remediation roadmap

**Immediate** (critical data, security or operations; before anything else):
1. Fix the permission-check cost ([FIG-1500](https://linear.app/figbloom/issue/FIG-1500)), the Dashboard's latest-register query ([FIG-1496](https://linear.app/figbloom/issue/FIG-1496)) and the parent's payments query ([FIG-1497](https://linear.app/figbloom/issue/FIG-1497)); re-run `tests/load/` on a 1,500-learner school and record the new numbers.
2. Fix the 1,000-row totals ([FIG-1438](https://linear.app/figbloom/issue/FIG-1438) first, then 1439, 1402, 1416, 1450): sum in the database, not in the browser.
3. Have a repo admin make CI a required check on `main` and `dev-staging` ([FIG-1457](https://linear.app/figbloom/issue/FIG-1457)); run the new CI job once and fix what it shows.
4. Decide [FIG-1303](https://linear.app/figbloom/issue/FIG-1303) and [FIG-1304](https://linear.app/figbloom/issue/FIG-1304): whether teachers and other school users should read that much (a privacy question, not a coding one).

**Before release:**
5. Live M-Pesa test with sandbox Daraja keys: a real prompt, PIN, callback, balance, timeout and cancel. Until then the payment path is proven only against a stand-in.
6. Create the production project separately from the demo and run one backup-and-restore drill; rehearse `RUNBOOK.md` on it.
7. Run the full suite once against a staging project.
8. Fix or knowingly accept every open P2: attendance on the wrong day ([FIG-1400](https://linear.app/figbloom/issue/FIG-1400)), the promised absence text message that is never sent ([FIG-1405](https://linear.app/figbloom/issue/FIG-1405)), wrong report figures (14 bugs in QA 13 and its re-run), silent deletes ([FIG-1428](https://linear.app/figbloom/issue/FIG-1428)), a teacher in two classes at once ([FIG-1429](https://linear.app/figbloom/issue/FIG-1429)), the phone offline and sign-out problems ([FIG-1487](https://linear.app/figbloom/issue/FIG-1487) to [1489](https://linear.app/figbloom/issue/FIG-1489)), and the phone layout ([FIG-1471](https://linear.app/figbloom/issue/FIG-1471) to [1473](https://linear.app/figbloom/issue/FIG-1473)).
9. Android: target API 36 and raise `versionCode` per build ([FIG-1494](https://linear.app/figbloom/issue/FIG-1494)); add error reporting and a visible start-up failure message ([FIG-1495](https://linear.app/figbloom/issue/FIG-1495)); add security headers ([FIG-1459](https://linear.app/figbloom/issue/FIG-1459)); close the release-workflow install-scripts gap ([FIG-1458](https://linear.app/figbloom/issue/FIG-1458)).
10. Close [FIG-1406](https://linear.app/figbloom/issue/FIG-1406) and [FIG-1414](https://linear.app/figbloom/issue/FIG-1414) in Linear (fixed on main), and set the 8-character password minimum on the hosted project.

**Short term** (after release, in the first weeks): the P3 correctness bugs (CSV edge cases, import messages, term and leave overlaps), contrast and keyboard fixes ([FIG-1478](https://linear.app/figbloom/issue/FIG-1478), [1476](https://linear.app/figbloom/issue/FIG-1476), [1477](https://linear.app/figbloom/issue/FIG-1477), [1480](https://linear.app/figbloom/issue/FIG-1480)), the upload bucket limits ([FIG-1460](https://linear.app/figbloom/issue/FIG-1460), [1461](https://linear.app/figbloom/issue/FIG-1461)), `npm audit` ([FIG-1463](https://linear.app/figbloom/issue/FIG-1463)), a way to ask for data deletion ([FIG-1465](https://linear.app/figbloom/issue/FIG-1465)), bus-location retention ([FIG-1464](https://linear.app/figbloom/issue/FIG-1464)), and putting the integration tests in CI.

**Long term:** split the web bundle by role and set a size budget; measure code coverage; re-run the load tests on the hosted project every release; an iOS pass; a screen-reader pass; keep `supabase/schema.sql` and `rls.sql` honest or delete them ([FIG-1469](https://linear.app/figbloom/issue/FIG-1469)); waivers, discounts and refunds if the schools need them.

---

## 8. What this audit did not cover

A hosted Supabase or Vercel project; live M-Pesa; backup and restore; iOS and any emulator; other browsers; screen readers; the edge functions under load; rendering time in a browser or on a phone; hosted secret scanning and Actions settings; Google Cloud key restrictions; code coverage. Each is marked BLOCKED or NOT TESTED in the step that met it; none is passed by silence.

## 9. Corrections made along the way

The runner disclosed its own mistakes in the step comments and they are kept here so the numbers can be trusted: the QA 08 probe that emptied the whole local mail inbox; the QA 14 miscounts, edited in place; the QA 15 foreign-key count (218 with main's migrations, 167 branch-only); the QA 16 screen count (17 first, 20 after a recount); the QA 17 offline attempt that did not cut an open connection (so the first try went through; the valid tests used an app restart or a restart of the debug bridge); and the QA 18 earlier-versus-later timing differences, which a laptop that slept can explain. QA 18 was run by a second session; this report and the re-run on the merged code were done by the session that merged main. Where a comment and the Linear issue disagree, Linear is current.
