/** The part of `window` openInNewTab uses (a stand-in in tests). */
export interface TabOpener {
  open(url?: string, target?: string, features?: string): TabLike | null;
}

/** The part of a new tab's window openInNewTab touches. */
export interface TabLike {
  closed: boolean;
  opener: unknown;
  location: { href: string };
  document?: { title: string; body: { textContent: string | null } | null };
  close(): void;
}

export const POPUP_BLOCKED = "Your browser blocked the new tab. Allow pop-ups for this site and try again.";

/**
 * Opens an address that takes a moment to fetch (open-hr's one-time HR link)
 * in a new tab without the browser's popup blocker getting in the way: the
 * tab is opened at once, inside the click, and sent to the address when it
 * arrives. If fetching it fails, the blank tab is closed and the error thrown.
 * Call it straight from the click handler, before any await.
 */
export async function openInNewTab(getUrl: () => Promise<string>, placeholder: string, win: TabOpener = window as unknown as TabOpener): Promise<void> {
  const tab = win.open("", "_blank");
  if (tab?.document) {
    try {
      tab.document.title = placeholder;
      if (tab.document.body) tab.document.body.textContent = placeholder;
    } catch { /* a tab we can't write to still works */ }
  }
  let url: string;
  try {
    url = await getUrl();
  } catch (err) {
    tab?.close();
    throw err;
  }
  if (tab && !tab.closed) {
    tab.opener = null;   // the HR site gets no handle on this window
    tab.location.href = url;
    return;
  }
  // the blank tab was blocked or closed meanwhile: one more try, which a blocker may still stop
  // (not "noopener": with it, open() answers null even when it worked)
  const retry = win.open(url, "_blank");
  if (!retry) throw new Error(POPUP_BLOCKED);
  try { retry.opener = null; } catch { /* cross-origin already */ }
}
