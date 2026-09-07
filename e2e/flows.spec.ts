import { expect, test } from "@playwright/test";

/**
 * The five flows that must never break. Each mirrors a real user's morning, so
 * a failure here means somebody's day is broken, not that a selector moved.
 */

test.describe("sign in", () => {
  test("a parent is asked for a phone number, not an email", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("tab", { name: "Parent" }).click();
    await expect(page.getByLabel("Mobile number")).toBeVisible();
    await page.getByLabel("Mobile number").fill("0722118004");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await expect(page.getByLabel("The six-digit code")).toBeVisible();
  });

  test("a student signs in with an admission number", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("tab", { name: "Student" }).click();
    await expect(page.getByLabel("Admission number")).toBeVisible();
  });
});

test("super admin onboards a school in five steps", async ({ page }) => {
  await page.goto("/platform/tenants");
  await page.getByRole("button", { name: "+ Onboard" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("step 1 of 5");

  await dialog.getByLabel("School name").fill("Kabarak High School");
  await dialog.getByRole("button", { name: "Continue" }).click();

  // The address is suggested from the name and flagged as permanent.
  await expect(dialog).toContainText("cannot be changed later");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();

  await dialog.getByLabel("Full name").fill("Peter Mwangi");
  await dialog.getByRole("button", { name: "Continue" }).click();

  await expect(dialog).toContainText("Review before creating");
  await expect(dialog).toContainText("Kabarak High School");
  await dialog.getByRole("button", { name: "Create school and send invite" }).click();

  // Success tracks delivery rather than claiming victory.
  await expect(dialog).toContainText("Waiting for first login");
});

test("a taken address is refused with the name of the school holding it", async ({ page }) => {
  await page.goto("/platform/tenants");
  await page.getByRole("button", { name: "+ Onboard" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("School name").fill("Alliance");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toContainText("belongs to Alliance High School");
});

test("teacher submits a full register in a handful of actions", async ({ page }) => {
  await page.goto("/s/alliance/teacher/attendance");

  // Everyone starts present, so the count is the whole roster.
  await expect(page.getByText(/\d+ present/)).toBeVisible();
  await expect(page.getByText("Everyone starts present")).toBeVisible();

  const rows = page.getByRole("listitem");
  await rows.nth(0).getByRole("button", { name: "Absent" }).click();
  await rows.nth(1).getByRole("button", { name: "Late" }).click();

  await page.getByRole("button", { name: "Submit register" }).click();
  await expect(page.getByText("register is in")).toBeVisible();
  await expect(page.getByText(/Parents of absent learners/)).toBeVisible();
});

test("an all-present register asks for one confirmation", async ({ page }) => {
  await page.goto("/s/alliance/teacher/attendance");
  await page.getByRole("button", { name: "Submit register" }).click();
  await expect(page.getByText(/Marking all \d+ learners present/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByText("register is in")).toBeVisible();
});

test("gradebook will not publish a partial column", async ({ page }) => {
  await page.goto("/s/alliance/teacher/gradebook");
  const publish = page.getByRole("button", { name: /still to enter|Publish marks/ });
  await expect(publish).toBeVisible();

  // Out-of-range marks are refused in the teacher's own words.
  const first = page.locator('[data-row="0"]');
  await first.fill("140");
  await expect(page.getByText("This paper is out of 100")).toBeVisible();

  // "abs" is a valid entry — a missed paper is missing, not zero.
  await first.fill("abs");
  await expect(page.getByText("This paper is out of 100")).toHaveCount(0);
});

test("parent pays a fee and gets a receipt", async ({ page }) => {
  await page.goto("/s/alliance/parent");
  await page.getByRole("button", { name: "Pay with M-Pesa" }).click();
  await page.getByRole("button", { name: "Send M-Pesa prompt" }).click();

  // The waiting state tells them to expect a prompt on the handset.
  await expect(page.getByText("Check your phone")).toBeVisible();
  await expect(page.getByText(/received/)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("SJ91MX441")).toBeVisible();
});

test("a failed payment says whether money left the account", async ({ page }) => {
  await page.goto("/s/alliance/parent");
  await page.getByRole("button", { name: "Pay with M-Pesa" }).click();

  // Overpaying triggers the failure path in the mock.
  await page.getByRole("button", { name: "Another amount" }).click();
  await page.locator('input[inputmode="numeric"]').first().fill("99999");
  await page.getByRole("button", { name: "Send M-Pesa prompt" }).click();

  await expect(page.getByText("did not go through")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/No money left your account/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay at the school office instead" })).toBeVisible();
});

test("switching children changes every figure on the screen", async ({ page }) => {
  await page.goto("/s/alliance/parent");
  await expect(page.getByText("Form 2 West")).toBeVisible();

  await page.getByRole("button", { name: "Samuel Achieng" }).click();
  await expect(page.getByText("Form 4 East")).toBeVisible();
  // Samuel's fees are cleared, so the pay button must be gone.
  await expect(page.getByRole("button", { name: "Pay with M-Pesa" })).toHaveCount(0);
  await expect(page.getByText("Cleared")).toBeVisible();
});

test("a student never sees a class position", async ({ page }) => {
  await page.goto("/s/alliance/student");
  await page.getByRole("button", { name: /Results/ }).click();
  await expect(page.getByText(/class mean/)).toBeVisible();
  await expect(page.getByText(/position/i)).toContainText("not shown");
});

test("console chips cannot contradict their own stat cards", async ({ page }) => {
  await page.goto("/platform/incidents");
  await page.getByRole("button", { name: "Open" }).click();
  // "Open" must include Investigating and Fix in review, not just one of them.
  await expect(page.getByText("Investigating")).toBeVisible();
  await expect(page.getByText("Fix in review")).toBeVisible();
  await expect(page.getByText("Resolved")).toHaveCount(0);
});
