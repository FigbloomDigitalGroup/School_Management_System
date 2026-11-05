import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * "Your school's account is suspended." on sign-in. Every Supabase call is
 * answered here (page.route), so this needs no seeded database: the answers
 * are the ones Supabase gives a suspended school's users.
 *
 *   - login-ID sign-in: resolve-login-id answers 403 code "school_suspended"
 *   - email sign-in: Auth answers 400 code "user_banned", "User is banned"
 *   - an already-open session: the school row is hidden (my_tenant()) and
 *     my_school_suspended() says true
 */

const TITLE = "Your school's account is suspended.";
const BODY = "Please contact your school's administrator or Figbloom support.";
const SUSPENDED = `${TITLE} ${BODY}`;
const SCHOOL = { id: "11111111-1111-4111-8111-111111111111", name: "Alliance High School", slug: "alliance", county: "Kiambu" };

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The school search finds Alliance; resolve-login-id says it is suspended. */
async function suspendedSchool(page: Page) {
  await page.route("**/functions/v1/search-schools", (r) => json(r, { schools: [SCHOOL] }));
  await page.route("**/functions/v1/resolve-login-id", (r) => json(r, { error: SUSPENDED, code: "school_suspended" }, 403));
}

async function expectNotice(page: Page) {
  const notice = page.getByTestId("suspended-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(TITLE);
  await expect(notice).toContainText(BODY);
  await expect(notice.getByRole("link", { name: "support@figbloom.org" })).toHaveAttribute("href", "mailto:support@figbloom.org");
  return notice;
}

test.describe("suspended school", () => {
  test("a school ID at a suspended school shows the message, not 'ID not found'", async ({ page }) => {
    await suspendedSchool(page);
    await page.goto("/signin");
    await page.getByRole("button", { name: /^Teacher/ }).click();
    await page.getByLabel("School").fill("Alliance");
    await page.getByRole("button", { name: /Alliance High School/ }).click();
    await page.getByLabel("Your ID").fill("TC-0001");
    await page.getByLabel("Your ID").blur();

    const notice = await expectNotice(page);
    await expect(notice).not.toContainText("Unpaid");
    await expect(page.getByText("We couldn't find that ID")).toHaveCount(0);
    // no password box: there is nothing to sign in to
    await expect(page.getByLabel("Password")).toHaveCount(0);

    // picking another school clears it
    await page.getByRole("button", { name: "Change" }).or(page.getByRole("button", { name: /change/i })).first().click();
    await expect(page.getByTestId("suspended-notice")).toHaveCount(0);
  });

  test("an email sign-in refused with user_banned shows the message", async ({ page }) => {
    await page.route("**/auth/v1/token**", (r) => json(r, { code: "user_banned", error_code: "user_banned", msg: "User is banned" }, 400));
    await page.goto("/signin");
    await page.getByRole("button", { name: /^Admin/ }).click();
    await page.getByRole("button", { name: "Sign in with email instead" }).click();
    await page.getByLabel("Email").fill("head@alliance.example");
    await page.getByLabel("Password", { exact: true }).fill("not-the-point");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expectNotice(page);
    await expect(page.getByText("Check the email and password.")).toHaveCount(0);
  });

  test("wrong credentials still say so, not that the school is suspended", async ({ page }) => {
    await page.route("**/auth/v1/token**", (r) => json(r, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400));
    await page.goto("/signin");
    await page.getByRole("button", { name: /^Admin/ }).click();
    await page.getByRole("button", { name: "Sign in with email instead" }).click();
    await page.getByLabel("Email").fill("head@alliance.example");
    await page.getByLabel("Password", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByText("Check the email and password.")).toBeVisible();
    await expect(page.getByTestId("suspended-notice")).toHaveCount(0);
  });

  test("an open session whose school is then suspended lands on sign-in with the message", async ({ page }) => {
    const userId = "22222222-2222-4222-8222-222222222222";
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const user = { id: userId, aud: "authenticated", role: "authenticated", email: "tc-0001@login.alliance.figbloom.internal", app_metadata: {}, user_metadata: {} };
    const session = {
      access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, role: "authenticated", aud: "authenticated", exp })}.c2ln`,
      refresh_token: "refresh", token_type: "bearer", expires_in: 3600, expires_at: exp, user,
    };

    // signed in while the school still worked, as far as this browser knows
    let suspendedNow = false;
    let signedOut = false;
    await page.route("**/functions/v1/search-schools", (r) => json(r, { schools: [SCHOOL] }));
    await page.route("**/functions/v1/resolve-login-id", (r) => json(r, { display_name: "Otieno O.", email: user.email }));
    await page.route("**/auth/v1/token**", (r) => json(r, session));
    await page.route("**/auth/v1/user**", (r) => json(r, user));
    await page.route("**/auth/v1/logout**", (r) => { signedOut = true; return r.fulfill({ status: 204 }); });
    await page.route("**/rest/v1/rpc/my_school_suspended**", (r) => json(r, suspendedNow));
    await page.route("**/rest/v1/profiles**", (r) => {
      const profile = { id: userId, role: "teacher", tenant_id: SCHOOL.id, full_name: "Otieno Omondi", must_change_password: false };
      return (r.request().headers()["accept"] ?? "").includes("vnd.pgrst.object") ? json(r, profile) : json(r, [profile]);
    });
    // my_tenant() hides a suspended school's row: no rows
    await page.route("**/rest/v1/tenants**", (r) =>
      (r.request().headers()["accept"] ?? "").includes("vnd.pgrst.object")
        ? json(r, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, 406)
        : json(r, []));

    await page.goto("/signin");
    await page.getByRole("button", { name: /^Teacher/ }).click();
    await page.getByLabel("School").fill("Alliance");
    await page.getByRole("button", { name: /Alliance High School/ }).click();
    await page.getByLabel("Your ID").fill("TC-0001");
    await page.getByLabel("Your ID").blur();
    await page.getByLabel("Password", { exact: true }).fill("a-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // the school row can't be read and nothing says it is suspended: the old answer, and the session stays
    await expect(page.getByText("Could not find your school. Contact Figbloom support.")).toBeVisible();
    expect(signedOut).toBe(false);

    // then the school is suspended, and the console is opened with that session
    suspendedNow = true;
    await page.goto("/s/alliance/teacher/attendance");
    await expect(page).toHaveURL(/\/signin$/);
    await expectNotice(page);
    expect(signedOut).toBe(true);
  });

  test("signing in when the school row is hidden and the school is suspended shows the message and signs out", async ({ page }) => {
    const userId = "33333333-3333-4333-8333-333333333333";
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const user = { id: userId, aud: "authenticated", role: "authenticated", email: "tc-0002@login.alliance.figbloom.internal", app_metadata: {}, user_metadata: {} };
    let signedOut = false;
    await page.route("**/functions/v1/search-schools", (r) => json(r, { schools: [SCHOOL] }));
    await page.route("**/functions/v1/resolve-login-id", (r) => json(r, { display_name: "Akinyi W.", email: user.email }));
    await page.route("**/auth/v1/token**", (r) => json(r, {
      access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, role: "authenticated", aud: "authenticated", exp })}.c2ln`,
      refresh_token: "refresh", token_type: "bearer", expires_in: 3600, expires_at: exp, user,
    }));
    await page.route("**/auth/v1/logout**", (r) => { signedOut = true; return r.fulfill({ status: 204 }); });
    await page.route("**/rest/v1/rpc/my_school_suspended**", (r) => json(r, true));
    await page.route("**/rest/v1/profiles**", (r) => {
      const profile = { id: userId, role: "teacher", tenant_id: SCHOOL.id };
      return (r.request().headers()["accept"] ?? "").includes("vnd.pgrst.object") ? json(r, profile) : json(r, [profile]);
    });
    await page.route("**/rest/v1/tenants**", (r) =>
      (r.request().headers()["accept"] ?? "").includes("vnd.pgrst.object")
        ? json(r, { code: "PGRST116", message: "no rows" }, 406)
        : json(r, []));

    await page.goto("/signin");
    await page.getByRole("button", { name: /^Teacher/ }).click();
    await page.getByLabel("School").fill("Alliance");
    await page.getByRole("button", { name: /Alliance High School/ }).click();
    await page.getByLabel("Your ID").fill("TC-0002");
    await page.getByLabel("Your ID").blur();
    await page.getByLabel("Password", { exact: true }).fill("a-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expectNotice(page);
    await expect(page.getByText("Could not find your school")).toHaveCount(0);
    await expect.poll(() => signedOut).toBe(true);
  });
});
