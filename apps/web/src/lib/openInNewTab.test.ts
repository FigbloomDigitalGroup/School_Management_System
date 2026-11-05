import { describe, expect, it } from "vitest";
import { openInNewTab, POPUP_BLOCKED, type TabLike, type TabOpener } from "./openInNewTab";

function fakeTab(): TabLike & { closedByUs: boolean } {
  const tab = {
    closed: false,
    closedByUs: false,
    opener: {} as unknown,
    location: { href: "about:blank" },
    document: { title: "", body: { textContent: "" as string | null } },
    close() { tab.closed = true; tab.closedByUs = true; },
  };
  return tab;
}

function fakeWindow(opens: (TabLike | null)[]) {
  const calls: { url?: string; target?: string; features?: string }[] = [];
  const win: TabOpener = {
    open(url, target, features) { calls.push({ url, target, features }); return opens.shift() ?? null; },
  };
  return { win, calls };
}

describe("openInNewTab", () => {
  it("opens the tab before the address is fetched (inside the click), then sends it there", async () => {
    const tab = fakeTab();
    const { win, calls } = fakeWindow([tab]);
    let openedBeforeFetch = false;
    await openInNewTab(async () => { openedBeforeFetch = calls.length === 1; return "https://hr.example/handoff?code=x"; }, "Opening HR & Payroll…", win);
    expect(openedBeforeFetch).toBe(true);
    expect(calls).toEqual([{ url: "", target: "_blank", features: undefined }]);
    expect(tab.document!.title).toBe("Opening HR & Payroll…");
    expect(tab.location.href).toBe("https://hr.example/handoff?code=x");
    expect(tab.opener).toBeNull();
  });

  it("opens the tab synchronously, before the first await", () => {
    const { win, calls } = fakeWindow([fakeTab()]);
    void openInNewTab(() => new Promise<string>(() => {}), "…", win);
    expect(calls.length).toBe(1);
  });

  it("closes the blank tab and throws the reason when fetching fails", async () => {
    const tab = fakeTab();
    const { win } = fakeWindow([tab]);
    await expect(openInNewTab(async () => { throw new Error("HR & Payroll isn't switched on for this school yet."); }, "…", win))
      .rejects.toThrow(/isn't switched on/);
    expect(tab.closedByUs).toBe(true);
    expect(tab.location.href).toBe("about:blank");
  });

  it("if the blank tab was blocked, tries once more with the address", async () => {
    const retry = fakeTab();
    const { win, calls } = fakeWindow([null, retry]);
    await openInNewTab(async () => "https://hr.example/h", "…", win);
    expect(calls[1]).toEqual({ url: "https://hr.example/h", target: "_blank", features: undefined });
    expect(retry.opener).toBeNull();
  });

  it("says pop-ups are blocked when both are", async () => {
    const { win } = fakeWindow([null, null]);
    await expect(openInNewTab(async () => "https://hr.example/h", "…", win)).rejects.toThrow(POPUP_BLOCKED);
  });
});
