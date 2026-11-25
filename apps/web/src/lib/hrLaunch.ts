/** The part of `window` openHrLaunchTab uses (a stand-in in tests). */
export interface LaunchWindow {
  open(url?: string, target?: string): { opener: unknown } | null;
  location: { assign(url: string): void };
}

/**
 * Opens the HR launch tab (/hr/launch, HR_CONNECT_SPEC.md): the school's page stays where it is, and the new tab
 * shows the "Opening Figbloom HR" screen, asks open-hr for the one-time sign-in link itself and replaces itself
 * with it. Call it straight from the click handler, with no await before it, so pop-up blockers let the tab open.
 * Blocked anyway: this tab goes to the launch page instead. Answers which happened.
 *
 * Not "noopener" in the features: with it, open() answers null even when it worked, and the fallback would then
 * open HR twice. The opener is cut by hand instead (the launch page is our own, but HR's page replaces it).
 */
export function openHrLaunchTab(launchUrl: string, win: LaunchWindow = window as unknown as LaunchWindow): "tab" | "same_tab" {
  const tab = win.open(launchUrl, "_blank");
  if (!tab) {
    win.location.assign(launchUrl);
    return "same_tab";
  }
  try {
    tab.opener = null;
  } catch {
    /* a browser that doesn't allow it: the page is our own anyway */
  }
  return "tab";
}
