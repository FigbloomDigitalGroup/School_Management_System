import { expect, type Page } from "@playwright/test";

/**
 * The app asks "Archive them?", "Send to families?" and the like in its own box (apps/web/src/components/ui/Confirm.tsx, role
 * "alertdialog") since main's fbd3b2f; before that it used the browser's confirm(), which the specs answered with
 * page.once("dialog"). Click the box's confirming button and return the text of the question, for specs that check what was asked.
 */
export async function confirmDialog(page: Page, button: string): Promise<string> {
  const box = page.getByRole("alertdialog");
  await expect(box, `a question with a "${button}" button`).toBeVisible();
  const asked = (await box.innerText()).replace(/\s+/g, " ").trim();
  await box.getByRole("button", { name: button, exact: true }).click();
  return asked;
}

/** Answers "no" to whatever the app asks, and returns what it asked. */
export async function dismissConfirm(page: Page): Promise<string> {
  const box = page.getByRole("alertdialog");
  await expect(box).toBeVisible();
  const asked = (await box.innerText()).replace(/\s+/g, " ").trim();
  await box.getByRole("button", { name: "Cancel", exact: true }).click();
  return asked;
}
