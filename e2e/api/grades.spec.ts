import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createApiClient, createMemoryTokenStore, isApiError, listAllPages, type ApiClient } from "../../packages/shared/src/api/index";
import type { SeedOutput } from "../../scripts/api-seed/seed";
import { computeTotpCode } from "../../scripts/api-seed/totp";

/**
 * Exams, the Gradebook, Performance and Reports on the new API (VITE_BACKEND=api).
 *
 * The seed (`npm run api:seed`) has two classes, two subjects, two learners and a teacher who is class teacher of Form 1 East. This spec
 * adds what a term of marks needs over the API (learners, teaching assignments, a second teacher who holds the Academics and People areas),
 * then drives the screens as three different people: the school admin, a teacher who holds those two areas, and a plain teacher.
 */

const SEED_PATH = process.env.API_SEED_OUTPUT
  ? resolve(process.cwd(), process.env.API_SEED_OUTPUT)
  : resolve(tmpdir(), "figbloom-api-seed.json");
const API_URL = (process.env.API_URL ?? process.env.VITE_API_URL ?? "http://127.0.0.1:4199").replace(/\/+$/, "");

function loadSeed(): SeedOutput {
  if (!existsSync(SEED_PATH)) throw new Error(`Missing API seed output at ${SEED_PATH}. Run "npm run api:seed" against a local apps/api first.`);
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as SeedOutput;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AREAS_EMAIL = "grader@alliance.sc.ke";
const AREAS_NAME = "Joyce Grader";
const AREAS_PASSWORD = "AllianceGrader!2026";

interface Fixture { tenantId: string; term: string; form1: string; form2: string }

/** Signs the admin in over the API. A TOTP code is accepted once per step, so a replay waits for the next step. */
async function adminClient(seed: SeedOutput): Promise<ApiClient> {
  const client = createApiClient({ baseUrl: API_URL, store: createMemoryTokenStore() });
  const login = await client.post("/v1/auth/login/email", { body: { email: seed.admin.email, password: seed.admin.password }, auth: false, tenantId: null });
  client.store.set({ token: login.token, expiresAt: login.expiresAt, userId: login.user.id });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.post("/v1/auth/mfa/challenge", { body: { code: computeTotpCode(seed.admin.totpSecret, Date.now(), 0) }, tenantId: null, keepSessionOn401: true });
      break;
    } catch (err) {
      if (attempt === 2 || !isApiError(err) || err.code !== "unauthorized") throw err;
      await sleep(30_000 - (Date.now() % 30_000) + 750);
    }
  }
  client.setActiveTenant(seed.tenantId);
  return client;
}

/** Learners, teaching assignments and a teacher who holds the Academics and People areas. Safe to run again. */
async function ensureGradesData(seed: SeedOutput): Promise<Fixture> {
  const api = await adminClient(seed);
  const tenantId = seed.tenantId;
  const path = { tenantId };
  const classes = await listAllPages(async (cursor) => { const r = await api.get("/v1/tenants/{tenantId}/classes", { path, query: { limit: 200, cursor } }); return { items: r.classes, page: r.page }; });
  const subjects = await listAllPages(async (cursor) => { const r = await api.get("/v1/tenants/{tenantId}/subjects", { path, query: { limit: 200, cursor } }); return { items: r.subjects, page: r.page }; });
  const terms = await listAllPages(async (cursor) => { const r = await api.get("/v1/tenants/{tenantId}/academic-terms", { path, query: { limit: 200, cursor } }); return { items: r.terms, page: r.page }; });
  const form1 = classes.find((c) => c.name === "Form 1 East")!.id;
  const form2 = classes.find((c) => c.name === "Form 2 West")!.id;
  const math = subjects.find((s) => s.code === "MATH")!.id;
  const english = subjects.find((s) => s.code === "ENG")!.id;
  const term = terms.find((t) => t.is_current)!;

  // Learners: three more in Form 2 West and two more in Form 1 East.
  const learners = await listAllPages(async (cursor) => { const r = await api.get("/v1/tenants/{tenantId}/learners", { path, query: { limit: 200, cursor } }); return { items: r.learners, page: r.page }; });
  const wanted = [
    ["GRD-1", "Grace Akinyi", "female", form2], ["GRD-2", "Hassan Ali", "male", form2], ["GRD-3", "Ivy Chebet", "female", form2],
    ["GRD-4", "John Mutua", "male", form1], ["GRD-5", "Kate Njoki", "female", form1],
  ] as const;
  for (const [adm, name, gender, classId] of wanted) {
    let id = learners.find((l) => l.admission_no === adm)?.id;
    if (!id) {
      id = (await api.post("/v1/tenants/{tenantId}/learners", { path, body: { admission_no: adm, full_name: name, gender, boarding: false, date_of_birth: "2011-05-05" } })).learner.id;
      await api.post("/v1/tenants/{tenantId}/class-memberships", { path, body: { learner_id: id, class_id: classId } });
    }
  }

  // The second teacher: an account (no two-step: she holds no Fees area), a staff record linked to it, and two areas.
  let accepted = false;
  try {
    const inv = await api.post("/v1/tenants/{tenantId}/invitations", { path, body: { email: AREAS_EMAIL, role: "teacher", full_name: AREAS_NAME } });
    if (inv.invitation.token) {
      await createApiClient({ baseUrl: API_URL, store: createMemoryTokenStore() }).post("/v1/invitations/accept", {
        body: { token: inv.invitation.token, password: AREAS_PASSWORD, full_name: AREAS_NAME }, auth: false, tenantId: null,
      });
      accepted = true;
    }
  } catch (err) {
    if (!(isApiError(err) && err.code === "conflict")) throw err;
  }
  void accepted;
  const login = await createApiClient({ baseUrl: API_URL, store: createMemoryTokenStore() }).post("/v1/auth/login/email", {
    body: { email: AREAS_EMAIL, password: AREAS_PASSWORD }, auth: false, tenantId: null,
  });
  const staff = await listAllPages(async (cursor) => { const r = await api.get("/v1/tenants/{tenantId}/staff", { path, query: { limit: 200, cursor } }); return { items: r.staff, page: r.page }; });
  let grader = staff.find((s) => s.full_name === AREAS_NAME);
  if (!grader) grader = (await api.post("/v1/tenants/{tenantId}/staff", { path, body: { full_name: AREAS_NAME, classification: "teacher", email: AREAS_EMAIL, userId: login.user.id } })).staff;
  await api.put("/v1/rbac/staff-areas", { body: { userId: login.user.id, areas: ["academics", "people"] } });

  // Who teaches what: David Kamau (the plain teacher) teaches Form 1 East; Joyce Grader teaches Form 2 West.
  const david = staff.find((s) => s.full_name === seed.teacher.email.split("@")[0] || s.full_name === "David Kamau")!;
  const assignments = await listAllPages(async (cursor) => { const r = await api.get("/v1/tenants/{tenantId}/teaching-assignments", { path, query: { limit: 200, cursor } }); return { items: r.assignments, page: r.page }; });
  for (const [staffId, classId, subjectId] of [[david.id, form1, math], [david.id, form1, english], [grader.id, form2, math], [grader.id, form2, english]] as const) {
    if (!assignments.some((a) => a.staff_member_id === staffId && a.class_id === classId && a.subject_id === subjectId && a.active)) {
      await api.post("/v1/tenants/{tenantId}/teaching-assignments", { path, body: { staff_member_id: staffId, class_id: classId, subject_id: subjectId } });
    }
  }
  return { tenantId, term: term.label, form1, form2 };
}

async function signOut(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).locator('button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 15_000 });
}

async function signInPlain(page: Page, seed: SeedOutput, email: string, password: string, landing: RegExp) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(email);
  await page.locator("#api-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
  void seed;
}

async function signInAdmin(page: Page, seed: SeedOutput) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.admin.email);
  await page.locator("#api-password").fill(seed.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const mfaInput = page.locator("#api-mfa-answer");
  await expect(mfaInput).toBeVisible({ timeout: 15_000 });
  const adminUrl = new RegExp(`/s/${seed.slug}/admin`);
  for (const attempt of [0, 1]) {
    if (attempt === 1) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 750);
    await mfaInput.fill(computeTotpCode(seed.admin.totpSecret, Date.now(), 0));
    await page.getByRole("button", { name: "Continue" }).click();
    try {
      // The console takes a few seconds to open after the code is accepted; a refused code leaves the page on the code box.
      await expect(page).toHaveURL(adminUrl, { timeout: 12_000 });
      return;
    } catch {
      if (attempt === 1) throw new Error("Admin MFA sign-in did not complete after waiting for next TOTP step.");
    }
  }
}

test.describe("Exams, Gradebook, Performance and Reports on the new API (VITE_BACKEND=api)", () => {
  test("the office sets an exam, a teacher with areas enters and publishes marks, and the office reads the results", async ({ page }) => {
    test.setTimeout(240_000);
    const seed = loadSeed();
    const fixture = await ensureGradesData(seed);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    // Sorts last in the exam list, and is new on every run so a re-run never meets last time's marks.
    const exam = `ZZ Mock ${Date.now()}`;

    // 1. The admin sets up an exam out of 50: a paper for every class and subject that has a teacher.
    await signInAdmin(page, seed);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Exams" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin/exams`));
    const main = page.locator("main");
    await main.getByRole("button", { name: "New exam" }).first().click();
    await page.locator("#exam-name").fill(exam);
    await page.locator("#exam-out-of").fill("0");
    await page.getByRole("button", { name: "Create exam" }).click();
    await expect(page.getByText("The total must be more than 0")).toBeVisible();
    await page.locator("#exam-out-of").fill("50");
    await page.getByRole("button", { name: "Create exam" }).click();
    await expect(page.getByText(/created: \d+ papers?/)).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText(exam)).toBeVisible();
    // Rename and Delete are not on the API: they are hidden, and so is "Marks entered".
    await expect(main.getByRole("button", { name: "Rename" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(main.getByText("Marks entered")).toHaveCount(0);
    await main.getByRole("button", { name: "Papers" }).last().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Form 2 West").first()).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText("Draft").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await signOut(page);

    // 2. Joyce Grader (Academics and People areas) enters Form 2 West's Mathematics marks, out of 50, and publishes them.
    await signInPlain(page, seed, AREAS_EMAIL, AREAS_PASSWORD, new RegExp(`/s/${seed.slug}/admin`));
    await page.goto(`/s/${seed.slug}/teacher/gradebook`);
    await expect(page.getByLabel("Class", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Class", { exact: true }).selectOption({ label: "Form 2 West" });
    await page.getByLabel("Subject", { exact: true }).selectOption({ label: "Mathematics" });
    await page.getByLabel("Exam", { exact: true }).selectOption({ label: exam });
    await expect(page.getByText("MARK / 50")).toBeVisible({ timeout: 20_000 });
    const mark = (name: string) => page.getByLabel(`Mark for ${name}`);
    await expect(mark("Brian Kamau")).toBeVisible();
    // A mark above the paper's total is refused where it is typed; a decimal is allowed on the new system.
    await mark("Brian Kamau").fill("51");
    await expect(page.getByText("This paper is out of 50.")).toBeVisible();
    await mark("Brian Kamau").fill("40");
    await mark("Grace Akinyi").fill("45.5");
    await mark("Hassan Ali").fill("abs");
    await mark("Ivy Chebet").fill("25");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await page.getByLabel("Class", { exact: true }).selectOption({ label: "Form 2 West" });
    await page.getByLabel("Subject", { exact: true }).selectOption({ label: "Mathematics" });
    await page.getByLabel("Exam", { exact: true }).selectOption({ label: exam });
    await expect(mark("Grace Akinyi")).toHaveValue("45.5", { timeout: 20_000 });
    await expect(mark("Brian Kamau")).toHaveValue("40");
    await expect(mark("Hassan Ali")).toHaveValue("");
    // Publishing waits until every learner has a mark or "abs".
    await mark("Hassan Ali").fill("abs");
    await page.getByRole("button", { name: "Publish marks" }).click();
    await expect(page.getByText(/is now visible to \d+ learners/)).toBeVisible({ timeout: 20_000 });
    // Published marks are final on the new system: read-only, no Withdraw.
    await expect(page.getByText("Published to parents")).toBeVisible({ timeout: 20_000 });
    await expect(mark("Brian Kamau")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Withdraw results" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await page.goto(`/s/${seed.slug}/admin`);
    await signOut(page);

    // 3. The admin reads the results: the paper is published, the mean (as a percentage of 50) is in Performance and Reports.
    await signInAdmin(page, seed);
    await page.goto(`/s/${seed.slug}/admin/exams`);
    await main.getByRole("button", { name: "Papers" }).last().click();
    const papers = page.getByRole("dialog");
    await expect(papers.getByRole("row", { name: /Form 2 West.*Mathematics/ }).getByText("Published")).toBeVisible({ timeout: 20_000 });
    await expect(papers.getByRole("row", { name: /Form 2 West.*Mathematics/ })).toContainText("3");
    await expect(papers.getByRole("row", { name: /Form 2 West.*English/ }).getByText("Draft")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(`/s/${seed.slug}/admin/performance`);
    await expect(page.getByRole("heading", { name: "Performance over time" })).toBeVisible();
    await expect(page.locator("#perf-exam option", { hasText: exam })).toHaveCount(1, { timeout: 30_000 });
    // 40/50, 45.5/50 and 25/50 are 80, 91 and 50 per cent: a mean of 73.7.
    await expect(page.getByText("73.7").first()).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/reports`);
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(page.getByText(exam).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("row", { name: /Form 2 West/ }).filter({ hasText: "learners" })).toBeVisible();
    await signOut(page);

    expect(errors).toEqual([]);
  });

  test("a plain teacher is told what the Gradebook and Performance need, and the CBE gradebook is not offered", async ({ page }) => {
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await signInPlain(page, seed, seed.teacher.email, seed.teacher.password, new RegExp(`/s/${seed.slug}/teacher`));
    await page.goto(`/s/${seed.slug}/teacher/gradebook`);
    await expect(page.getByText("The Gradebook is not open to you yet")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Academics and People areas/)).toBeVisible();
    await expect(page.getByRole("tab", { name: /Strand assessment/ })).toHaveCount(0);
    await page.goto(`/s/${seed.slug}/teacher/performance`);
    await expect(page.getByRole("heading", { name: "Performance over time" })).toBeVisible();
    await page.goto(`/s/${seed.slug}/admin`);
    // A teacher with no admin areas has no Exams or Reports page: the address sends them home.
    await page.goto(`/s/${seed.slug}/admin/exams`);
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher`), { timeout: 20_000 });
    expect(errors).toEqual([]);
  });
});
