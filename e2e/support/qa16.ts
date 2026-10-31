import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type test as PlaywrightTest } from "@playwright/test";

/**
 * Shared by e2e/a11y.spec.ts (every screen at three widths) and e2e/usability.spec.ts (keyboard, dialogs, error and slow states,
 * double clicks, long names, the accessibility preferences). Not a spec itself: Playwright only runs *.spec.ts.
 */

export const PASSWORD = "figbloom-dev";
export const SCHOOL = "Alliance High School";
export const S = "/s/alliance";

export interface Finding {
  role: string;
  route: string;
  width: number;
  kind: string;
  detail: string;
  nodes?: { target: string; html: string; data?: unknown }[];
}

export async function emailLogin(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 20000 });
}

export async function idLogin(page: Page, portal: "Teacher" | "Student" | "Parent" | "Driver", loginId: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill(SCHOOL);
  await page.getByRole("button").filter({ hasText: SCHOOL }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 10000 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 20000 });
}

export const LOGINS = {
  "platform admin": (p: Page) => emailLogin(p, "joyce@figbloom.co.ke"),
  "school admin": (p: Page) => emailLogin(p, "principal@alliance.sc.ke"),
  "group admin": (p: Page) => emailLogin(p, "group@kijaniridge.sc.ke"),
  teacher: (p: Page) => idLogin(p, "Teacher", "TC-0002"),
  parent: (p: Page) => idLogin(p, "Parent", "PT-0002"),
  student: (p: Page) => idLogin(p, "Student", "ST-0002"),
  driver: (p: Page) => idLogin(p, "Driver", "BD-0001"),
  "signed out": async () => undefined, // the public pages
} as const;
export type RoleName = keyof typeof LOGINS;

/** A screen that moves on by itself just after it settles (a redirect, a reload) breaks a measurement in flight: wait for it to settle and measure again. */
async function afterNavigation<T>(page: Page, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (e) {
      if (attempt >= 3 || !/Execution context was destroyed/.test(String(e))) throw e;
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(700);
    }
  }
}

/**
 * What a screen looks like at this width. An ancestor excuses an element only if it really scrolls sideways (a wide table in its own
 * scroll box), or clips it on purpose with an ellipsis. <main> scrolls up and down, so it does not excuse anything: it only clips.
 */
export async function measure(page: Page, scope?: string) {
  return afterNavigation(page, () => page.evaluate((scopeSelector) => {
    const root: Element = (scopeSelector ? document.querySelector(scopeSelector) : null) ?? document.body;
    const doc = document.documentElement;
    const width = window.innerWidth;

    let widest: { tag: string; text: string; right: number } | null = null;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed" && r.right <= width + 1) continue;
      if (r.right > width + 1 && (!widest || r.right > widest.right)) {
        let a: Element | null = el.parentElement, scrolls = false;
        while (a && a !== document.body) {
          const o = getComputedStyle(a).overflowX;
          if (((o === "auto" || o === "scroll") && a.scrollWidth > a.clientWidth + 1) || o === "hidden") { scrolls = true; break; }
          a = a.parentElement;
        }
        if (!scrolls) widest = { tag: el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""), text: (el.textContent ?? "").trim().slice(0, 40), right: Math.round(r.right) };
      }
    }

    // a control that is partly hidden: by the window's edge, or by an ancestor that clips without scrolling
    const clippedControls: string[] = [];
    for (const el of Array.from(root.querySelectorAll("button, a[href], input, select, textarea, [role=button]"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.left >= width || r.right <= 0) continue; // an off-screen pane waiting to slide in is elsewhere, not clipped
      let left = Math.max(r.left, 0), right = Math.min(r.right, width), scrollable = false;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if ((o === "auto" || o === "scroll") && a.scrollWidth > a.clientWidth + 1) { scrollable = true; break; }
        if (o === "hidden" || o === "clip" || o === "auto" || o === "scroll") { const ar = a.getBoundingClientRect(); left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
      }
      if (!scrollable && r.width - (right - left) > 2) {
        const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 30);
        clippedControls.push(`${name} (${Math.round(right - left)} of ${Math.round(r.width)}px visible)`);
      }
    }

    // words and figures hidden by an outer box: a leaf element whose visible part, after every clipping ancestor and the window,
    // is narrower than the text
    const hiddenText: string[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? "").trim();
      if (text.length < 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || getComputedStyle(el).visibility === "hidden") continue;
      if (r.left >= width || r.right <= 0) continue;
      let left = Math.max(r.left, 0), right = Math.min(r.right, width), skip = false;
      for (let a = el as Element | null; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.textOverflow === "ellipsis") { skip = true; break; }
        if (a !== el && (cs.overflowX === "auto" || cs.overflowX === "scroll") && a.scrollWidth > a.clientWidth + 1) { skip = true; break; }
        if (a !== el && (cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.overflowX === "auto" || cs.overflowX === "scroll")) { const ar = a.getBoundingClientRect(); left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
      }
      if (!skip && r.width - (right - left) > 2) hiddenText.push(`"${text.replace(/\s+/g, " ").slice(0, 34)}" (${Math.round(right - left)} of ${Math.round(r.width)}px visible)`);
    }

    const broken = Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0 && !!i.currentSrc).map((i) => i.currentSrc.slice(0, 90));
    const main = document.querySelector("main");
    const mainScrollsSideways = !scopeSelector && !!main && main.scrollWidth > main.clientWidth + 1; // page-level: not part of a dialog
    return {
      mainScrollsSideways, mainWidths: main ? `${main.scrollWidth}px of ${main.clientWidth}px` : "",
      scrollWidth: doc.scrollWidth, width, overflow: !scopeSelector && doc.scrollWidth > width + 1, widest,
      clippedControls, hiddenText, broken, bodyText: (document.body.innerText ?? "").trim().length,
    };
  }, scope ?? null));
}

/** The layout findings for one screen at one width, in the form the specs keep them. */
export function layoutFindings(role: string, route: string, width: number, m: Awaited<ReturnType<typeof measure>>): Finding[] {
  const out: Finding[] = [];
  const add = (kind: string, detail: string) => out.push({ role, route, width, kind, detail });
  if (m.mainScrollsSideways) add("content scrolls sideways", `the content area is ${m.mainWidths}`);
  if (m.overflow) add("overflow", `page ${m.scrollWidth}px in a ${m.width}px window; widest: ${m.widest ? `<${m.widest.tag}> "${m.widest.text}" reaches ${m.widest.right}px` : "unknown"}`);
  for (const c of m.clippedControls) add("clipped control", c);
  for (const c of m.hiddenText.slice(0, 12)) add("text hidden", c);
  for (const src of m.broken) add("broken image", src);
  if (m.bodyText < 20) add("blank", `only ${m.bodyText} characters of text`);
  return out;
}

/** Serious and critical axe violations (WCAG 2.0 and 2.1, levels A and AA, colour contrast included), optionally inside one element. */
export async function axeFindings(page: Page, role: string, route: string, width: number, scope?: string): Promise<Finding[]> {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (scope) builder = builder.include(scope);
  const res = await afterNavigation(page, () => builder.analyze());
  return res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      role, route, width, kind: `axe ${v.impact} ${v.id}`,
      detail: `${v.nodes.length} element(s), e.g. ${v.nodes[0]?.target.join(" ").slice(0, 110)} | ${v.help}`,
      nodes: v.nodes.slice(0, 300).map((n) => ({ target: n.target.join(" ").slice(0, 140), html: n.html.slice(0, 200), data: (n.any[0]?.data ?? n.all[0]?.data ?? n.none[0]?.data) as unknown })),
    }));
}

/** One bug found by QA 16: its Linear issue, what a fixed app does, and which findings belong to it. */
export interface Known { tag: string; fig: string; what: string; match: (f: Finding) => boolean }

const show = (f: Finding) => `${f.role} | ${f.route} | ${f.width}px | ${f.kind} | ${f.detail}`.slice(0, 230);

/** The three colour pairs FIG-1478 lists. A contrast failure with any other pair is new, and nothing excuses it. */
export function isKnownContrast(f: Finding): boolean {
  const nodes = f.nodes ?? [];
  return nodes.length > 0 && nodes.every((n) => {
    const d = n.data as { fgColor?: string; bgColor?: string } | null | undefined;
    return d?.fgColor === "#7b877f" || (d?.fgColor === "#ffffff" && d?.bgColor === "#f26a1b") || (d?.fgColor === "#8ba095" && d?.bgColor === "#17402a");
  });
}

/**
 * A test per known bug, expected to fail (test.fail) while the bug is open, so the suite is green today and goes red on the day a fix
 * lands, as the reminder to delete the test. The last test fails on any finding that no known bug accounts for.
 * They read what the walk tests of the same file gathered, so run them together: -g "<group>|<tag>".
 */
export function defineKnownTests(t: typeof PlaywrightTest, group: string, known: Known[], findings: Finding[], ran: () => boolean) {
  for (const k of known) {
    t(`${k.tag} ${k.fig}: ${k.what}`, () => {
      t.skip(!ran(), `reads what the walk found: run it with -g "${group}|${k.tag}"`);
      t.fail();
      expect(findings.filter(k.match).map(show)).toEqual([]);
    });
  }
  t(`${group}-NEW no finding is left that a known bug does not account for`, () => {
    t.skip(!ran(), `reads what the walk found: run it with -g "${group}"`);
    expect(findings.filter((f) => !known.some((k) => k.match(f))).map(show)).toEqual([]);
  });
}
