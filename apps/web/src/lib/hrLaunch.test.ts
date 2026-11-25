import { describe, expect, it } from "vitest";
import { openHrLaunchTab, type LaunchWindow } from "./hrLaunch";

const LAUNCH = "/hr/launch?school=11111111-1111-4111-8111-111111111111&slug=reu";

function fakeWindow(tab: { opener: unknown } | null) {
  const opened: { url?: string; target?: string }[] = [];
  const assigned: string[] = [];
  const win: LaunchWindow = {
    open(url, target) { opened.push({ url, target }); return tab; },
    location: { assign(url) { assigned.push(url); } },
  };
  return { win, opened, assigned };
}

describe("openHrLaunchTab", () => {
  it("opens the launch page in a new tab at once (no placeholder, no fetch first) and cuts the opener", () => {
    const tab = { opener: {} as unknown };
    const { win, opened, assigned } = fakeWindow(tab);
    expect(openHrLaunchTab(LAUNCH, win)).toBe("tab");
    expect(opened).toEqual([{ url: LAUNCH, target: "_blank" }]);
    expect(tab.opener).toBeNull();
    expect(assigned).toEqual([]);
  });

  it("blocked: this tab goes to the launch page instead", () => {
    const { win, opened, assigned } = fakeWindow(null);
    expect(openHrLaunchTab(LAUNCH, win)).toBe("same_tab");
    expect(opened.length).toBe(1);
    expect(assigned).toEqual([LAUNCH]);
  });

  it("a tab whose opener can't be cut still counts as opened", () => {
    const tab = Object.defineProperty({}, "opener", { get: () => null, set: () => { throw new Error("no"); } }) as { opener: unknown };
    const { win, assigned } = fakeWindow(tab);
    expect(openHrLaunchTab(LAUNCH, win)).toBe("tab");
    expect(assigned).toEqual([]);
  });
});
