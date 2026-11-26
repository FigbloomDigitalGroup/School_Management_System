# People: learner logins (W0.3, first PR)

The API build shows the **Login** column and **Create logins** action on the current learner roster to school administrators and super administrators. Teachers and staff can use them only when they hold the People area. Organisation administrators are excluded because the student-account endpoints do not grant them access. The archived learner view does not show the login column.

The status read is `GET /v1/tenants/{tenantId}/learners/{learnerId}/student-account`. The screen requests status only for learners on the current People page, with at most four reads in flight. It caches statuses as the user pages through the current roster. An unreadable status is shown as unavailable; it is never treated as an absent login. The Login column and creation action remain hidden for users without permission.

Creating a login uses `POST /v1/tenants/{tenantId}/learners/{learnerId}/student-account` for each selected learner known to have no login. The API returns a one-time password once, which the modal displays for direct handover. The API does not send e-mail or SMS. The Supabase build keeps its existing provisioning path.

## API findings

- **people-1 — status:** The existing GET endpoint returns `account.login_id` as a string or `null`; the UI uses that value instead of inferring login state from the People roster. A permission or server error is surfaced as unavailable.
- **people-2 — creation:** The existing POST endpoint returns `account.login_id` and `account.one_time_password` with status 201. Duplicate accounts are refused; the UI does not create replacement credentials after a conflict.

This PR only connects the web screen to the student-account endpoints already on `dev-joe`; it does not change API routes or database objects. Fees, early sign-outs, learner activities, unassigning a class and password resets remain hidden for the second W0.3 PR or their later slice.
