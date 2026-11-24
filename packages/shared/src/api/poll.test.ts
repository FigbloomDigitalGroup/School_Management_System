import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_AFTER_MS, MAX_BACKOFF_MS, POLL_MS, pollChanges, pollNewItems, startPolling, webPollEnvironment, resetWebPollEnvironment, type PollEnvironment } from "./poll";

/** A page with a clock the test turns by hand, and a count of the listeners the polls have left on it. */
function fakePage(opts: { input?: boolean; visibility?: boolean } = {}) {
  let now = 0;
  let hidden = false;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const visibility = new Set<() => void>();
  const input = new Set<() => void>();

  const env: PollEnvironment = {
    now: () => now,
    after: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return () => { timers.delete(id); };
    },
    visible: () => !hidden,
  };
  if (opts.visibility !== false) env.onVisibility = (cb) => { visibility.add(cb); return () => { visibility.delete(cb); }; };
  if (opts.input !== false) env.onInput = (cb) => { input.add(cb); return () => { input.delete(cb); }; };

  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  return {
    env,
    listeners: () => ({ visibility: visibility.size, input: input.size }),
    pendingTimers: () => timers.size,
    /** Turns the clock forward, running each timer that falls due, in order, with the promises settled between. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    async hide() { hidden = true; for (const cb of [...visibility]) cb(); await flush(); },
    async show() { hidden = false; for (const cb of [...visibility]) cb(); await flush(); },
    async type() { for (const cb of [...input]) cb(); await flush(); },
  };
}

const SECOND = 1000;

describe("startPolling", () => {
  it("waits one interval before the first ask, then asks every interval", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    expect(tick).not.toHaveBeenCalled();
    await page.advance(4_999);
    expect(tick).not.toHaveBeenCalled();
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await page.advance(10 * SECOND);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("asks at once when immediate", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, immediate: true, env: page.env });
    await page.advance(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("never has two asks open: the wait starts when the answer comes", async () => {
    const page = fakePage();
    let open = 0;
    let most = 0;
    let releases: (() => void)[] = [];
    const tick = vi.fn(() => {
      open++;
      most = Math.max(most, open);
      return new Promise<void>((resolve) => { releases.push(() => { open--; resolve(); }); });
    });
    const stop = startPolling(tick, { intervalMs: 4 * SECOND, env: page.env });
    await page.advance(4 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);
    // Slow: 30 s pass with the ask still open, and no second ask is made.
    await page.advance(30 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);
    releases.forEach((r) => r());
    releases = [];
    await page.advance(0);
    await page.advance(3_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
    stop();
  });

  it("does not ask while the page is hidden, and asks once at once when it is shown", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);

    await page.hide();
    expect(page.pendingTimers()).toBe(0);
    await page.advance(5 * 60 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);

    await page.show();
    expect(tick).toHaveBeenCalledTimes(2);
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("hiding and showing the page while an ask is open does not start a second one", async () => {
    const page = fakePage();
    let open = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const tick = vi.fn(() => {
      open++;
      most = Math.max(most, open);
      return new Promise<void>((resolve) => { releases.push(() => { open--; resolve(); }); });
    });
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.advance(5 * SECOND);
    await page.hide();
    await page.show();
    expect(tick).toHaveBeenCalledTimes(1);
    releases[0]!();
    await page.advance(0);
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
    stop();
  });

  it("an input on a hidden page does not start asking again", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.hide();
    await page.type();
    await page.advance(60 * SECOND);
    expect(tick).not.toHaveBeenCalled();
    expect(page.pendingTimers()).toBe(0);
    stop();
  });

  it("does not ask at all when it starts on a hidden page, until the page is shown", async () => {
    const page = fakePage();
    await page.hide();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, immediate: true, env: page.env });
    await page.advance(60 * SECOND);
    expect(tick).not.toHaveBeenCalled();
    await page.show();
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("an ask that ends while the page is hidden does not set the next one going", async () => {
    const page = fakePage();
    let release: () => void = () => {};
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);
    await page.hide();
    release();
    await page.advance(60 * SECOND);
    expect(page.pendingTimers()).toBe(0);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses after ten minutes with no input, and asks once at once on the next input", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 30 * SECOND, env: page.env });
    await page.advance(IDLE_AFTER_MS);
    // Asks at 30 s, 60 s ... 570 s; at exactly ten minutes the page counts as idle, so there is no 20th.
    expect(tick).toHaveBeenCalledTimes(19);
    // Nothing is asked after the pause, however long the page is left.
    await page.advance(90 * 60 * SECOND);
    expect(tick).toHaveBeenCalledTimes(19);
    const paused = tick.mock.calls.length;
    expect(page.pendingTimers()).toBe(0);

    await page.type();
    expect(tick.mock.calls.length).toBe(paused + 1);
    await page.advance(30 * SECOND);
    expect(tick.mock.calls.length).toBe(paused + 2);
    stop();
  });

  it("input before the ten minutes are up keeps it going", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 30 * SECOND, env: page.env });
    for (let i = 0; i < 6; i++) {
      await page.advance(5 * 60 * SECOND);
      await page.type();
    }
    // Thirty minutes passed in all, and the page never sat idle for ten.
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(58);
    await page.advance(5 * 60 * SECOND);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(68);
    stop();
  });

  it("an input while it is not paused does not make an extra ask", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.type();
    await page.type();
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("showing the page after a long time hidden counts as activity, so it does not stay in the idle pause", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 30 * SECOND, env: page.env });
    await page.advance(5 * SECOND);
    await page.hide();
    await page.advance(3 * 60 * 60 * SECOND);
    const hiddenCalls = tick.mock.calls.length;
    await page.show();
    expect(tick.mock.calls.length).toBe(hiddenCalls + 1);
    await page.advance(30 * SECOND);
    expect(tick.mock.calls.length).toBe(hiddenCalls + 2);
    stop();
  });

  it("idleAfterMs: 0 turns the idle pause off", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 60 * SECOND, idleAfterMs: 0, env: page.env });
    await page.advance(60 * 60 * SECOND);
    expect(tick).toHaveBeenCalledTimes(60);
    stop();
  });

  it("a page that cannot see input (the phone) is never idle", async () => {
    const page = fakePage({ input: false, visibility: false });
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 60 * SECOND, env: page.env });
    await page.advance(2 * 60 * 60 * SECOND);
    expect(tick).toHaveBeenCalledTimes(120);
    stop();
  });

  it("reports a failed ask, keeps going, and waits twice as long, then four times, then no more than a minute", async () => {
    const page = fakePage();
    const errors: unknown[] = [];
    const tick = vi.fn(async () => { throw new Error("down"); });
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, onError: (e) => errors.push(e), env: page.env });
    await page.advance(5 * SECOND);        // ask 1 fails at 5 s
    expect(tick).toHaveBeenCalledTimes(1);
    await page.advance(9_999);              // next after 10 s
    expect(tick).toHaveBeenCalledTimes(1);
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(2);  // ask 2 fails at 15 s; next after 20 s
    await page.advance(19_999);
    expect(tick).toHaveBeenCalledTimes(2);
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(3);  // ask 3 at 35 s; next after 40 s
    await page.advance(40 * SECOND);
    expect(tick).toHaveBeenCalledTimes(4);  // ask 4 at 75 s; next after 80 s, which the minute caps
    await page.advance(59_999);
    expect(tick).toHaveBeenCalledTimes(4);
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(errors).toHaveLength(5);
    expect((errors[0] as Error).message).toBe("down");
    expect(MAX_BACKOFF_MS).toBe(60 * SECOND);
    stop();
  });

  it("a success between two failures starts the backoff again: twice the wait, not four times", async () => {
    const page = fakePage();
    const script = [false, true, false];
    const tick = vi.fn(async () => { if (!script.shift()) throw new Error("down"); });
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.advance(5 * SECOND);        // fails at 5 s; next after 10 s
    await page.advance(10 * SECOND);       // works at 15 s; next after 5 s
    await page.advance(5 * SECOND);        // fails at 20 s; next after 10 s, not 20 s
    expect(tick).toHaveBeenCalledTimes(3);
    await page.advance(9_999);
    expect(tick).toHaveBeenCalledTimes(3);
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });

  it("goes back to the normal wait after an ask works", async () => {
    const page = fakePage();
    let fail = true;
    const tick = vi.fn(async () => { if (fail) throw new Error("down"); });
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.advance(5 * SECOND);       // fails; next after 10 s
    fail = false;
    await page.advance(10 * SECOND);      // works at 15 s
    expect(tick).toHaveBeenCalledTimes(2);
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("a failed ask never makes the wait shorter than the interval, even when the interval is over a minute", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => { throw new Error("down"); });
    const stop = startPolling(tick, { intervalMs: 90 * SECOND, env: page.env });
    await page.advance(90 * SECOND);
    await page.advance(89_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await page.advance(1);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("an ask that throws synchronously is a failed ask, not a dead poll", async () => {
    const page = fakePage();
    let n = 0;
    const tick = vi.fn(() => { n++; if (n === 1) throw new Error("boom"); });
    const onError = vi.fn();
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, onError, env: page.env });
    await page.advance(5 * SECOND);
    expect(onError).toHaveBeenCalledTimes(1);
    await page.advance(10 * SECOND);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop ends it: no more asks, the signal is aborted, the page listeners are gone, and stopping twice is fine", async () => {
    const page = fakePage();
    let signal: AbortSignal | null = null;
    const tick = vi.fn(async (s: AbortSignal) => { signal = s; });
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    expect(page.listeners()).toEqual({ visibility: 1, input: 1 });
    await page.advance(5 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    stop();
    stop();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(page.listeners()).toEqual({ visibility: 0, input: 0 });
    expect(page.pendingTimers()).toBe(0);
    await page.advance(60 * SECOND);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("an ask still open when it is stopped does not schedule another, and its failure is not reported", async () => {
    const page = fakePage();
    let fail: (e: Error) => void = () => {};
    const tick = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const onError = vi.fn();
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, onError, env: page.env });
    await page.advance(5 * SECOND);
    stop();
    fail(new Error("late"));
    await page.advance(60 * SECOND);
    expect(onError).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(page.pendingTimers()).toBe(0);
  });

  it("a stopped poll is not woken by the page", async () => {
    const page = fakePage();
    const tick = vi.fn(async () => {});
    const stop = startPolling(tick, { intervalMs: 5 * SECOND, env: page.env });
    await page.hide();
    stop();
    await page.show();
    await page.type();
    expect(tick).not.toHaveBeenCalled();
  });
});

describe("pollNewItems", () => {
  type Msg = { id: string; text: string };
  const m = (id: string): Msg => ({ id, text: `t${id}` });

  it("says nothing about the first answer, then reports each new row once, in the order given", async () => {
    const page = fakePage();
    const answers: Msg[][] = [[m("1"), m("2")], [m("1"), m("2"), m("3"), m("4")], [m("1"), m("2"), m("3"), m("4")], [m("5")]];
    const got: string[] = [];
    const stop = pollNewItems(async () => answers.shift()!, (x) => x.id, (x) => got.push(x.id), { intervalMs: POLL_MS.thread, env: page.env });
    await page.advance(POLL_MS.thread);
    expect(got).toEqual([]);
    await page.advance(POLL_MS.thread);
    expect(got).toEqual(["3", "4"]);
    await page.advance(POLL_MS.thread);
    expect(got).toEqual(["3", "4"]);
    await page.advance(POLL_MS.thread);
    expect(got).toEqual(["3", "4", "5"]);
    stop();
  });

  it("reports the first answer too when emitFirst", async () => {
    const page = fakePage();
    const got: string[] = [];
    const stop = pollNewItems(async () => [m("1"), m("2")], (x) => x.id, (x) => got.push(x.id), { intervalMs: 1000, emitFirst: true, env: page.env });
    await page.advance(1000);
    expect(got).toEqual(["1", "2"]);
    await page.advance(5000);
    expect(got).toEqual(["1", "2"]);
    stop();
  });

  it("a row reported twice in one answer is reported once", async () => {
    const page = fakePage();
    const got: string[] = [];
    let n = 0;
    const stop = pollNewItems(async () => (n++ === 0 ? [] : [m("1"), m("1")]), (x) => x.id, (x) => got.push(x.id), { intervalMs: 1000, env: page.env });
    await page.advance(2000);
    expect(got).toEqual(["1"]);
    stop();
  });

  it("a failed read does not lose the starting point", async () => {
    const page = fakePage();
    const got: string[] = [];
    const script: (Msg[] | Error)[] = [[m("1")], new Error("down"), [m("1"), m("2")]];
    const stop = pollNewItems(async () => { const next = script.shift()!; if (next instanceof Error) throw next; return next; }, (x) => x.id, (x) => got.push(x.id), { intervalMs: 1000, env: page.env });
    await page.advance(1000);       // sets the starting point
    await page.advance(1000);       // fails; next after 2 s
    await page.advance(2000);
    expect(got).toEqual(["2"]);
    stop();
  });

  it("does not report after it is stopped, even for an answer that was on its way", async () => {
    const page = fakePage();
    const got: string[] = [];
    let release: (v: Msg[]) => void = () => {};
    let n = 0;
    const stop = pollNewItems(
      () => (n++ === 0 ? Promise.resolve([m("1")]) : new Promise<Msg[]>((resolve) => { release = resolve; })),
      (x) => x.id, (x) => got.push(x.id), { intervalMs: 1000, env: page.env },
    );
    await page.advance(1000);
    await page.advance(1000);
    stop();
    release([m("1"), m("2")]);
    await page.advance(5000);
    expect(got).toEqual([]);
  });

  it("does not remember more than 2,000 keys", async () => {
    const page = fakePage();
    const got: string[] = [];
    const many = Array.from({ length: 2_500 }, (_, i) => m(String(i)));
    const answers: Msg[][] = [many, [m("0")], [m("2499")]];
    const stop = pollNewItems(async () => answers.shift() ?? [], (x) => x.id, (x) => got.push(x.id), { intervalMs: 1000, env: page.env });
    await page.advance(3000);
    // "0" was one of the oldest 500 and was forgotten, so it looks new; "2499" is still remembered.
    expect(got).toEqual(["0"]);
    stop();
  });
});

describe("pollChanges", () => {
  it("says nothing about the first answer, then reports each different answer", async () => {
    const page = fakePage();
    const answers = [{ n: 1 }, { n: 1 }, { n: 2 }, { n: 2 }, { n: 1 }];
    const got: number[] = [];
    const stop = pollChanges(async () => answers.shift()!, (v) => got.push(v.n), { intervalMs: 1000, env: page.env });
    await page.advance(5000);
    expect(got).toEqual([2, 1]);
    stop();
  });

  it("reports the first answer when emitFirst", async () => {
    const page = fakePage();
    const got: number[] = [];
    const stop = pollChanges(async () => 7, (v) => got.push(v), { intervalMs: 1000, emitFirst: true, env: page.env });
    await page.advance(3000);
    expect(got).toEqual([7]);
    stop();
  });

  it("uses `same` to decide what counts as a change", async () => {
    const page = fakePage();
    const answers = [{ n: 1, noise: "a" }, { n: 1, noise: "b" }, { n: 2, noise: "b" }];
    const got: number[] = [];
    const stop = pollChanges(async () => answers.shift()!, (v) => got.push(v.n), { intervalMs: 1000, same: (a, b) => a.n === b.n, env: page.env });
    await page.advance(3000);
    expect(got).toEqual([2]);
    stop();
  });

  it("compares by value, so a new array with the same contents is no change", async () => {
    const page = fakePage();
    const got: string[][] = [];
    let n = 0;
    const stop = pollChanges(async () => (n++ < 2 ? ["a:1", "b:2"] : ["a:1", "b:3"]), (v) => got.push(v), { intervalMs: 1000, env: page.env });
    await page.advance(3000);
    expect(got).toEqual([["a:1", "b:3"]]);
    stop();
  });

  it("a failed read is not a change", async () => {
    const page = fakePage();
    const got: number[] = [];
    const script: (number | Error)[] = [1, new Error("down"), 1];
    const stop = pollChanges(async () => { const next = script.shift()!; if (next instanceof Error) throw next; return next; }, (v) => got.push(v), { intervalMs: 1000, env: page.env });
    await page.advance(4_000);
    expect(script).toEqual([]);
    expect(got).toEqual([]);
    stop();
  });
});

describe("webPollEnvironment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetWebPollEnvironment();
  });

  function stubPage(visibilityState = "visible") {
    const doc = new Map<string, Set<() => void>>();
    const win = new Map<string, { cb: () => void; capture: boolean }[]>();
    vi.stubGlobal("document", {
      visibilityState,
      addEventListener: (t: string, cb: () => void) => { (doc.get(t) ?? doc.set(t, new Set()).get(t)!).add(cb); },
      removeEventListener: (t: string, cb: () => void) => { doc.get(t)?.delete(cb); },
    });
    vi.stubGlobal("addEventListener", (t: string, cb: () => void, o?: { capture?: boolean }) => { win.set(t, [...(win.get(t) ?? []), { cb, capture: !!o?.capture }]); });
    vi.stubGlobal("removeEventListener", (t: string, cb: () => void) => { win.set(t, (win.get(t) ?? []).filter((x) => x.cb !== cb)); });
    return {
      docCount: (t: string) => doc.get(t)?.size ?? 0,
      winCount: () => [...win.values()].reduce((n, l) => n + l.length, 0),
      winCaptured: () => [...win.values()].flat().every((x) => x.capture),
      fireDoc: (t: string) => [...(doc.get(t) ?? [])].forEach((cb) => cb()),
      fireWin: (t: string) => (win.get(t) ?? []).forEach((x) => x.cb()),
    };
  }

  it("says the page is hidden when the browser does", () => {
    stubPage("hidden");
    expect(webPollEnvironment().visible()).toBe(false);
    resetWebPollEnvironment();
    stubPage("visible");
    expect(webPollEnvironment().visible()).toBe(true);
  });

  it("has one set of listeners however many polls there are, and removes them with the last", () => {
    const page = stubPage();
    const env = webPollEnvironment();
    const a = vi.fn();
    const b = vi.fn();
    const offA = env.onInput!(a);
    const offB = env.onInput!(b);
    expect(page.winCount()).toBe(6);
    expect(page.winCaptured()).toBe(true);
    page.fireWin("keydown");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    expect(page.winCount()).toBe(6);
    page.fireWin("scroll");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
    expect(page.winCount()).toBe(0);

    const v = vi.fn();
    const offV = env.onVisibility!(v);
    expect(page.docCount("visibilitychange")).toBe(1);
    page.fireDoc("visibilitychange");
    expect(v).toHaveBeenCalledTimes(1);
    offV();
    expect(page.docCount("visibilitychange")).toBe(0);
  });

  it("covers keys, taps, pointer, wheel and scroll", () => {
    const page = stubPage();
    const cb = vi.fn();
    const off = webPollEnvironment().onInput!(cb);
    for (const name of ["keydown", "pointerdown", "pointermove", "touchstart", "wheel", "scroll"]) page.fireWin(name);
    expect(cb).toHaveBeenCalledTimes(6);
    off();
  });

  it("leaves out what the platform does not have: no page, always visible, no idle", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("addEventListener", undefined);
    const env = webPollEnvironment();
    expect(env.visible()).toBe(true);
    expect(env.onInput).toBeUndefined();
    expect(env.onVisibility).toBeUndefined();
    expect(typeof env.now()).toBe("number");
  });

  it("runs a real timer and cancels it", async () => {
    vi.useFakeTimers();
    try {
      const env = webPollEnvironment();
      const fn = vi.fn();
      const cancel = env.after(fn, 100);
      cancel();
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();
      env.after(fn, 100);
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the usual waits", () => {
  it("are the ones the handover names", () => {
    expect(POLL_MS.thread).toBeGreaterThanOrEqual(4_000);
    expect(POLL_MS.thread).toBeLessThanOrEqual(5_000);
    expect(POLL_MS.live).toBe(10_000);
    expect(POLL_MS.list).toBeGreaterThanOrEqual(20_000);
    expect(POLL_MS.badge).toBeLessThanOrEqual(60_000);
    expect(IDLE_AFTER_MS).toBe(10 * 60_000);
  });
});
