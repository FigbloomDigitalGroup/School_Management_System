import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_AREA, HR_LAUNCH_PATH, HR_PAGE, NAV } from "@figbloom/shared";
import { hrRoutes } from "../../api/ApiHrRoutes";
import { pages } from "../../api/pages/hr.pages";

/** What the API build registers for HR & Payroll (docs/web-on-api/hr-handoff.md). */
describe("HR & Payroll on the API build", () => {
  it("registers the connect page at admin/hr, with no menu entry of its own (the sidebar item opens it)", () => {
    expect(pages.admin).toHaveLength(1);
    expect(pages.admin![0]).toMatchObject({ path: HR_PAGE, inMenu: false });
    expect(pages.admin![0]!.menu).toBeUndefined(); // it is gated by its own area, not borrowed from another page's menu entry
    expect(pages.teacher ?? []).toEqual([]);
    expect(pages.staff ?? []).toEqual([]);
    for (const entries of Object.values(NAV)) expect(entries.map((i) => i.to)).not.toContain(HR_PAGE);
  });

  it("is opened by the Fees area, as on Supabase", () => {
    expect(ADMIN_PAGE_AREA[HR_PAGE]).toBe("fees");
  });

  it("adds the launch tab as a top-level route of the app, outside any school's console", () => {
    expect(hrRoutes).toHaveLength(1);
    expect(hrRoutes[0]!.props.path).toBe(HR_LAUNCH_PATH);
    expect(HR_LAUNCH_PATH).toBe("/hr/launch");
  });
});
