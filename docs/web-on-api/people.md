# People: learner logins (W0.3, first PR)

The API build shows the **Login** column and **Create logins** action on the current learner roster to school administrators and super administrators. Teachers and staff can use them only when they hold the People area. Organisation administrators are excluded because the student-account endpoints do not grant them access. The archived learner view does not show the login column.

The status read is `GET /v1/tenants/{tenantId}/learners/{learnerId}/student-account`. The screen requests status only for learners on the current People page, with at most four reads in flight. It caches statuses as the user pages through the current roster. An unreadable status is shown as unavailable; it is never treated as an absent login. The Login column and creation action remain hidden for users without permission.

Creating a login uses `POST /v1/tenants/{tenantId}/learners/{learnerId}/student-account` for each selected learner known to have no login. The API returns a one-time password once, which the modal displays for direct handover. The API does not send e-mail or SMS. The Supabase build keeps its existing provisioning path.

## API findings

- **people-1 — status:** The existing GET endpoint returns `account.login_id` as a string or `null`; the UI uses that value instead of inferring login state from the People roster. A permission or server error is surfaced as unavailable.
- **people-2 — creation:** The existing POST endpoint returns `account.login_id` and `account.one_time_password` with status 201. Duplicate accounts are refused; the UI does not create replacement credentials after a conflict.

This PR connects the web screen to the student-account endpoints already on `dev-joe`; it does not change API routes or database objects.

## Learner record tabs (second PR)

On the API build, the learner roster's Fees column reads current-term invoice totals only when the caller has both Finance and academic-term read access. A caller without those rights sees no Fees column; a permission failure is not shown as “No invoice.” Voided invoices are excluded. The Supabase roster keeps its existing fee read.

The learner card's Early sign-outs section is available to full administrators and Attendance-area holders on the API build. It searches the newest school-wide pages, filters them to the learner, and stops after 12 pages of 200 rows. The card says when that bounded search may have missed older records. Collector details appear only when the API returns them. The Supabase build keeps its existing Attendance and Visitors access rules.

The learner card's Sports & activities section uses the school activity list and each activity's member list; it does not use the family endpoint. It reads at most 50 activities, with at most four member-list requests in flight, and says when more activities were not checked. The API has no event or achievement read for this office card, so it shows clubs and teams only.

Unassigning a learner archives the current-year class membership. Rejoining a class the learner left earlier in the year is supported by migration 101. No API routes or database objects were added or changed for this web slice.

### Findings

- **people-3 — fees:** The People roster has no fee endpoint of its own. The screen composes the current term from the existing academic-terms and finance-invoices reads, which require both `resource.academics.read` and `resource.finance.read`.
- **people-4 — early sign-outs:** The API has a paged school-wide `GET /v1/tenants/{tenantId}/early-sign-outs`, not a learner-specific history route. The API card bounds the scan and uses collector data embedded in each row when the caller has the collector permission.
- **people-5 — activities:** There is no office learner-to-activity or event-history endpoint. The card composes membership from `GET /activities` and `GET /activities/{activityId}/members`; the family activity read remains unchanged.
- **people-6 — class assignment:** Unassign uses `POST /v1/tenants/{tenantId}/class-memberships/{membershipId}/archive`; migration 101 permits a later membership in a class the learner previously left.
