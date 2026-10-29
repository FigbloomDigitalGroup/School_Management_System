import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 07 (FIG-1240): the money figures on each screen against the rows they are built from.
 *
 * The expected numbers are worked out here from the database rows (read with the service role, summed with plain loops), not by
 * calling any of the app's own code. Each screen is then read as a person sees it, so a screen that sums the wrong rows, picks the
 * wrong term or rounds differently fails here. Read-only apart from the pay-dialog check, which types into a field and sends nothing.
 *
 * Seed data only (npm run db:seed and db:seed-org): it reads the first demo school (Alliance), its parent PT-0002 and learner ST-0002,
 * and the Kijani Ridge Group. Prints a side-by-side table of every figure at the end (the QA 07 comment in Linear uses it).
 * supabase/rls-checks/reconciliation.sql asks the same questions of the database without a browser.
 */
test.describe.configure({ mode: "serial" });

const PASSWORD = "figbloom-dev";
const table: string[][] = [["Screen", "Figure", "Database", "Screen shows"]];

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
});

test.afterAll(() => {
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  console.log("\n" + table.map((r) => "| " + r.map((cell, c) => cell.padEnd(widths[c]!)).join(" | ") + " |").join("\n"));
});

// ---------------------------------------------------------------- the database side
/** "KSh 9,667,000": whole shillings (Kenya shows no decimals). Formatting only; the cents come from the rows. */
const ksh = (cents: number) => `KSh ${Math.round(cents / 100).toLocaleString("en-KE")}`;

interface Inv { total_cents: number; paid_cents: number; students: { class_id: string | null; classes: { name: string } | null } | null }

async function alliance() {
  const t = await db.from("tenants").select("id").eq("slug", "alliance").single();
  const tenantId = t.data!.id as string;
  const term = await db.from("terms").select("id, name").eq("tenant_id", tenantId).eq("is_current", true).single();
  const rows: Inv[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from("fee_invoices").select("total_cents, paid_cents, students(class_id, classes(name))")
      .eq("tenant_id", tenantId).eq("term_id", term.data!.id as string).order("id").range(from, from + 499).returns<Inv[]>();
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 500) break;
  }
  let billed = 0, collected = 0, owing = 0, fully = 0;
  for (const r of rows) {
    billed += r.total_cents; collected += r.paid_cents;
    if (r.paid_cents < r.total_cents) owing += 1;
    if (r.paid_cents >= r.total_cents && r.total_cents > 0) fully += 1;
  }
  const byClass = new Map<string, { billed: number; paid: number }>();
  for (const r of rows) {
    const name = r.students?.classes?.name;
    if (!name) continue;
    const c = byClass.get(name) ?? { billed: 0, paid: 0 };
    c.billed += r.total_cents; c.paid += r.paid_cents;
    byClass.set(name, c);
  }
  return { rows, billed, collected, owing, fully, byClass, term: term.data!.name as string };
}

/** One learner's current-term invoice, by the login id of their own account (ST-...) or of a parent (PT-...). */
async function invoiceOfLearners(loginId: string) {
  const prof = await db.from("profiles").select("id, role").eq("login_id", loginId).single();
  const studentIds: string[] = [];
  if (prof.data!.role === "parent") {
    const g = await db.from("guardians").select("student_id").eq("profile_id", prof.data!.id as string);
    studentIds.push(...(g.data ?? []).map((x) => x.student_id as string));
  } else {
    const s = await db.from("students").select("id").eq("profile_id", prof.data!.id as string);
    studentIds.push(...(s.data ?? []).map((x) => x.id as string));
  }
  const term = await db.from("terms").select("id").eq("is_current", true).eq("tenant_id", (await db.from("profiles").select("tenant_id").eq("id", prof.data!.id as string).single()).data!.tenant_id as string).single();
  const out: { first: string; adm: string; total: number; paid: number }[] = [];
  for (const id of studentIds) {
    const s = await db.from("students").select("full_name, admission_no").eq("id", id).single();
    const inv = await db.from("fee_invoices").select("total_cents, paid_cents").eq("student_id", id).eq("term_id", term.data!.id as string).single();
    out.push({ first: (s.data!.full_name as string).split(" ")[0]!, adm: s.data!.admission_no as string, total: inv.data!.total_cents as number, paid: inv.data!.paid_cents as number });
  }
  return out.sort((a, b) => a.adm.localeCompare(b.adm));
}

// ---------------------------------------------------------------- the screen side
async function textLines(page: Page): Promise<string[]> {
  await page.waitForLoadState("networkidle");
  return (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The n lines after a label. Labels are upper-cased by CSS, and innerText follows that, so compare without case. */
function after(lines: string[], label: string, n: number): string[] {
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  expect(i, `"${label}" is on the screen`).toBeGreaterThanOrEqual(0);
  return lines.slice(i + 1, i + 1 + n);
}

/** Records one figure for the table and checks it. */
function same(screen: string, figure: string, database: string, shown: string | undefined) {
  table.push([screen, figure, database, shown ?? "(missing)"]);
  expect(shown, `${screen}: ${figure}`).toBe(database);
}

async function waitForSignedIn(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

async function signInEmail(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

async function signInWithId(page: Page, school: string, loginId: string, portal: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill(school);
  await page.getByRole("button").filter({ hasText: school }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

// ---------------------------------------------------------------- the checks
test.describe("admin screens, Alliance, current term", () => {
  test("Fees, Dashboard and Reports show the sums of the invoices", async ({ page }) => {
    const a = await alliance();
    const pct = a.billed > 0 ? Math.round((a.collected / a.billed) * 100) : 0;
    const fullyPct = Math.round((a.fully / a.rows.length) * 100);
    await signInEmail(page, "principal@alliance.sc.ke");

    await page.goto("/s/alliance/admin/fees");
    await expect(page.getByText(/billed this term/i).first()).toBeVisible();
    let ls = await textLines(page);
    const billed = after(ls, "Billed this term", 2), collected = after(ls, "Collected", 2), outstanding = after(ls, "Outstanding", 2), fully = after(ls, "Fully paid", 2);
    same("Fees", "billed this term", ksh(a.billed), billed[0]);
    same("Fees", "learners billed", `${a.rows.length} learners`, billed[1]);
    same("Fees", "collected", ksh(a.collected), collected[0]);
    same("Fees", "collected % of billed", `${pct}% of billed`, collected[1]);
    same("Fees", "outstanding (billed - collected)", ksh(a.billed - a.collected), outstanding[0]);
    same("Fees", "learners owing", `${a.owing} learners owe a balance`, outstanding[1]);
    same("Fees", "fully paid %", `${fullyPct}%`, fully[0]);
    same("Fees", "invoices cleared", `${a.fully} invoices cleared`, fully[1]);

    for (const [route, name] of [["/s/alliance/admin", "Dashboard"], ["/s/alliance/admin/reports", "Reports"]] as const) {
      await page.goto(route);
      await expect(page.getByText(/fees collected/i).first()).toBeVisible();
      ls = await textLines(page);
      const card = after(ls, "Fees collected", 2);
      same(name, "fees collected %", `${pct}%`, card[0]);
      same(name, "collected of billed", `${ksh(a.collected)} of ${ksh(a.billed)}`, card[1]);
    }

    // Reports: fee collection by class (balance is clamped at zero per class, not per learner)
    const header = ls.findIndex((l) => l.toLowerCase() === "fee collection by class · this term");
    expect(header, "the by-class table is on the Reports screen").toBeGreaterThanOrEqual(0);
    const tableLines = ls.slice(header + 1);
    for (const [name, c] of [...a.byClass.entries()].sort()) {
      const i = tableLines.indexOf(name);
      expect(i, `class ${name} is in the table`).toBeGreaterThanOrEqual(0);
      same("Reports", `${name}: collected %`, `${Math.round((c.paid / c.billed) * 100)}%`, tableLines[i + 1]);
      same("Reports", `${name}: balance`, ksh(Math.max(c.billed - c.paid, 0)), tableLines[i + 2]);
    }
  });
});

test.describe("parent and student screens", () => {
  test("the parent's Fees screen shows each child's invoice for this term", async ({ page }) => {
    const kids = await invoiceOfLearners("PT-0002");
    expect(kids.length).toBeGreaterThanOrEqual(2);
    await signInWithId(page, "Alliance High School", "PT-0002", "Parent");
    await page.goto("/s/alliance/parent/fees");
    for (const [n, kid] of kids.entries()) {
      if (n > 0) await page.getByRole("button", { name: kid.first, exact: true }).first().click();
      await expect(page.getByText(`ADM ${kid.adm.replace(/^ADM\s*/i, "")}`)).toBeVisible();
      const ls = await textLines(page);
      const balance = Math.max(kid.total - kid.paid, 0);
      const paidSoFar = kid.total - balance;
      same(`Parent (${kid.first})`, "balance", ksh(balance), after(ls, "Balance", 1)[0]);
      same(`Parent (${kid.first})`, "billed this term", ksh(kid.total), after(ls, "Billed this term", 1)[0]);
      const paid = after(ls, "Paid so far", 2);
      same(`Parent (${kid.first})`, "paid so far", ksh(paidSoFar), paid[0]);
      same(`Parent (${kid.first})`, "paid %", `${Math.round((paidSoFar / kid.total) * 100)}% of billed`, paid[1]);
    }
  });

  test("the student's Fees screen shows their own invoice for this term", async ({ page }) => {
    const [kid] = await invoiceOfLearners("ST-0002");
    await signInWithId(page, "Alliance High School", "ST-0002", "Student");
    await page.goto("/s/alliance/student/fees");
    await expect(page.getByText(/billed this term/i).first()).toBeVisible();
    const ls = await textLines(page);
    const balance = Math.max(kid!.total - kid!.paid, 0);
    same(`Student (${kid!.first})`, "balance", ksh(balance), after(ls, "Balance", 1)[0]);
    same(`Student (${kid!.first})`, "billed this term", ksh(kid!.total), after(ls, "Billed this term", 1)[0]);
    same(`Student (${kid!.first})`, "paid so far", ksh(kid!.total - balance), after(ls, "Paid so far", 2)[0]);
  });
});

test.describe("organization screen, Kijani Ridge Group", () => {
  test("the group dashboard shows the sums of its school's invoices (all terms: the summary is not per term)", async ({ page }) => {
    const k = await db.from("tenants").select("id").eq("slug", "kijani-ridge").single();
    const inv = await db.from("fee_invoices").select("total_cents, paid_cents").eq("tenant_id", k.data!.id as string);
    const billed = (inv.data ?? []).reduce((a, r) => a + (r.total_cents as number), 0);
    const collected = (inv.data ?? []).reduce((a, r) => a + (r.paid_cents as number), 0);
    await signInEmail(page, "group@kijaniridge.sc.ke");
    await page.goto("/org/kijani-ridge-group/dashboard");
    await expect(page.getByText(/fees collected/i).first()).toBeVisible();
    const card = after(await textLines(page), "Fees collected", 2);
    same("Org dashboard", "fees collected", ksh(collected), card[0]);
    same("Org dashboard", "% of billed", `${Math.round((collected / billed) * 100)}% of ${ksh(billed)} billed`, card[1]);
  });
});

test.describe("the M-Pesa amount field", () => {
  // The field strips everything but digits, so a typed "500.50" becomes 50050 shillings, a hundred times what was meant. It is
  // refused only if it exceeds the balance. Written as the behaviour we want; test.fail() passes while the defect exists.
  test("FIG-1334 (open): typing a decimal amount does not turn it into a different amount", async ({ page }) => {
    test.fail();
    await signInWithId(page, "Alliance High School", "PT-0002", "Parent");
    await page.goto("/s/alliance/parent/fees");
    await page.getByRole("button", { name: "Pay with M-Pesa" }).first().click();
    await page.getByRole("button", { name: "Another amount" }).click();
    const amount = page.locator('input[inputmode="numeric"]').first();
    await amount.fill("500.50");
    expect(await amount.inputValue(), "what the field now says").not.toBe("50050");
  });
});
