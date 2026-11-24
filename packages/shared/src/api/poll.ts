/**
 * Polling in place of realtime. apps/api has no push channel (no websocket, no server-sent events), so a screen that
 * wanted a live update on Supabase asks again every few seconds on the API build. This file is the one place that does
 * the asking, so every area waits the same way and a tab that nobody is using stops asking.
 *
 * The rules (docs/handoffs/WEB-ON-API-TODO.md, "Polling instead of realtime"):
 *  - It asks one request at a time. A slow answer delays the next ask; it never stacks asks up.
 *  - It pauses while the page is hidden, and after IDLE_AFTER_MS (10 minutes) with no key, tap, scroll or pointer
 *    movement. Each ask counts as activity to the API's idle timer (15 minutes for staff, 30 for guardians), so a tab
 *    left open overnight that kept asking would keep the session alive for ever. Paused, it asks nothing.
 *  - It starts again at once (one catch-up ask) when the page is shown again, or on the next input after an idle pause.
 *  - A failed ask is reported to `onError` and tried again later, after twice the wait, then four times, up to a minute.
 *    A screen already showing data should keep showing it; polling is best effort.
 *  - Phones and Node have no page or input events: there the pauses are off and it asks at its interval until stopped.
 *    (A phone app can pass its own `env`, wired to AppState, to pause in the background.)
 *
 * What to use:
 *  - `startPolling(tick, opts)` is the loop. `tick` makes one ask and does what it likes with the answer.
 *  - `pollNewItems(read, keyOf, onNew, opts)` has the same shape as the Supabase `subscribe*` helpers that deliver rows
 *    as they arrive (`subscribeChatMessages`, `subscribeVisits`, `subscribeBusUpdates`): `read` answers the newest rows,
 *    and `onNew` is called once for each row not seen before, oldest first if `read` answers oldest first.
 *  - `pollChanges(read, onChange, opts)` has the shape of the ones that only say "something changed, load again"
 *    (`subscribeAnnouncements`, `subscribeLiveClasses`, `subscribeMyCalls`): `onChange` is called when what `read`
 *    answers is different from the last answer.
 *  - Each returns a function that stops it, as the `subscribe*` helpers do. Call it from the effect's cleanup.
 *  - `POLL_MS` names the usual waits: an open chat 4.5 s, buses and the gate 10 s, lists 30 s, badges 60 s.
 *
 * The first ask is one interval after the start, not at once: the screen has loaded its own data by then. Pass
 * `immediate: true` to ask straight away. `pollNewItems` and `pollChanges` take the first answer as the starting point
 * and say nothing about it (`emitFirst: true` reports it): a row that arrives between the screen's own load and that
 * first answer is the one thing this can miss, so a screen that must not miss it passes `emitFirst: true` and ignores
 * rows it already has (the chat thread does).
 *
 * This file compiles for the phone (no DOM), so every web global is read through `globalThis` and may be missing.
 */

/** The usual waits, in milliseconds. */
export const POLL_MS = {
  /** A chat that is open on screen. */
  thread: 4_500,
  /** Bus positions, the gate. */
  live: 10_000,
  /** A list or an inbox that is open. */
  list: 30_000,
  /** A badge in the menu, which is on screen all the time. */
  badge: 60_000,
} as const;

/** No input for this long and polling pauses until the next input. */
export const IDLE_AFTER_MS = 10 * 60_000;

/** The longest wait after repeated failures, unless the interval itself is longer. */
export const MAX_BACKOFF_MS = 60_000;

/** What polling needs from the page. A test passes its own; the app uses `webPollEnvironment()`. */
export interface PollEnvironment {
  now(): number;
  /** Runs `fn` once after `ms`; answers a function that cancels it. */
  after(fn: () => void, ms: number): () => void;
  /** Whether a person can see the page. Always true where there is no such thing. */
  visible(): boolean;
  /** Calls `cb` whenever the page is shown or hidden. Left out where there is no such thing. */
  onVisibility?(cb: () => void): () => void;
  /** Calls `cb` on a key, tap, scroll or pointer move. Left out where input cannot be seen: the idle pause is then off. */
  onInput?(cb: () => void): () => void;
}

export interface PollOptions {
  /** Wait between the end of one ask and the start of the next. */
  intervalMs: number;
  /** Pause after this long with no input. Default IDLE_AFTER_MS. 0 turns the idle pause off. */
  idleAfterMs?: number;
  /** Ask straight away as well, not only after the first interval. */
  immediate?: boolean;
  /** An ask threw (or its promise rejected). Polling goes on. */
  onError?: (err: unknown) => void;
  /** The page. Default `webPollEnvironment()`. */
  env?: PollEnvironment;
}

// ---------------------------------------------------------------- the page

interface WebTarget {
  addEventListener?(type: string, cb: () => void, opts?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener?(type: string, cb: () => void, opts?: { capture?: boolean }): void;
}
interface WebGlobals extends WebTarget {
  document?: WebTarget & { visibilityState?: string };
}

const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "touchstart", "wheel", "scroll"] as const;

/** One set of page listeners however many polls there are: each poll adds a callback, the last one out removes them. */
function sharedListener(attach: (fire: () => void) => () => void): (cb: () => void) => () => void {
  const subscribers = new Set<() => void>();
  let detach: (() => void) | null = null;
  return (cb) => {
    const entry = () => cb();
    subscribers.add(entry);
    if (!detach) detach = attach(() => { for (const s of [...subscribers]) s(); });
    return () => {
      subscribers.delete(entry);
      if (subscribers.size === 0 && detach) { detach(); detach = null; }
    };
  };
}

let webEnv: PollEnvironment | null = null;

/** The browser: Date.now, setTimeout, the page's visibility and its input events. Pieces that are missing are left out. */
export function webPollEnvironment(): PollEnvironment {
  if (webEnv) return webEnv;
  const g = globalThis as unknown as WebGlobals;
  const doc = g.document;
  const env: PollEnvironment = {
    now: () => Date.now(),
    after: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    },
    visible: () => doc?.visibilityState !== "hidden",
  };
  if (doc?.addEventListener && doc.removeEventListener) {
    env.onVisibility = sharedListener((fire) => {
      doc.addEventListener!("visibilitychange", fire);
      return () => doc.removeEventListener!("visibilitychange", fire);
    });
  }
  if (g.addEventListener && g.removeEventListener) {
    env.onInput = sharedListener((fire) => {
      // Capture, because a scroll in a panel does not bubble to the window.
      for (const name of INPUT_EVENTS) g.addEventListener!(name, fire, { capture: true, passive: true });
      return () => { for (const name of INPUT_EVENTS) g.removeEventListener!(name, fire, { capture: true }); };
    });
  }
  webEnv = env;
  return env;
}

/** Forgets the browser environment, so a test that changes the page's globals gets a fresh one. */
export function resetWebPollEnvironment(): void {
  webEnv = null;
}

// ---------------------------------------------------------------- the loop

/**
 * Calls `tick` every `intervalMs` while the page is in use. `tick` gets a signal that is aborted when polling stops; pass
 * it to the request so a stopped screen does not leave one in flight. Answers the function that stops polling.
 */
export function startPolling(tick: (signal: AbortSignal) => Promise<unknown> | unknown, opts: PollOptions): () => void {
  const env = opts.env ?? webPollEnvironment();
  const idleAfter = opts.idleAfterMs ?? IDLE_AFTER_MS;
  const controller = new AbortController();

  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let inFlight = false;
  let failures = 0;
  let lastInput = env.now();
  // True while nothing is scheduled because the page is hidden or the person is idle: an event wakes it.
  let sleeping = false;

  const clearTimer = () => { cancelTimer?.(); cancelTimer = null; };
  const idle = () => env.onInput !== undefined && idleAfter > 0 && env.now() - lastInput >= idleAfter;
  const paused = () => !env.visible() || idle();

  function schedule(ms: number): void {
    clearTimer();
    if (stopped) return;
    if (paused()) { sleeping = true; return; }
    sleeping = false;
    cancelTimer = env.after(() => { cancelTimer = null; void run(); }, ms);
  }

  async function run(): Promise<void> {
    if (stopped || inFlight) return;
    if (paused()) { sleeping = true; return; }
    inFlight = true;
    let failed = false;
    try {
      await tick(controller.signal);
    } catch (err) {
      failed = true;
      if (!stopped) opts.onError?.(err);
    }
    inFlight = false;
    if (stopped) return;
    failures = failed ? failures + 1 : 0;
    const backoff = Math.min(opts.intervalMs * 2 ** failures, Math.max(MAX_BACKOFF_MS, opts.intervalMs));
    schedule(failed ? backoff : opts.intervalMs);
  }

  function wake(): void {
    if (stopped || !sleeping || inFlight || paused()) return;
    sleeping = false;
    void run();
  }

  const stopVisibility = env.onVisibility?.(() => {
    if (stopped) return;
    if (env.visible()) {
      // Coming back to the page is activity: do not wait for a click before the catch-up ask.
      lastInput = env.now();
      wake();
    } else {
      clearTimer();
      sleeping = true;
    }
  });
  const stopInput = env.onInput?.(() => {
    lastInput = env.now();
    wake();
  });

  if (opts.immediate) void run();
  else schedule(opts.intervalMs);

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimer();
    controller.abort();
    stopVisibility?.();
    stopInput?.();
  };
}

// ---------------------------------------------------------------- the two shapes screens use

/** Most keys remembered by `pollNewItems`; a poll reads a page of at most 200 rows, so this is many pages of margin. */
const SEEN_LIMIT = 2_000;

/**
 * Rows as they arrive. `read` answers the newest rows (a page, not the whole table); `onNew` is called once for each
 * row whose key was not in an earlier answer, in the order `read` gave them. The first answer sets the starting point
 * and is not reported unless `emitFirst` is true.
 */
export function pollNewItems<T>(
  read: (signal: AbortSignal) => Promise<readonly T[]>,
  keyOf: (item: T) => string,
  onNew: (item: T) => void,
  opts: PollOptions & { emitFirst?: boolean },
): () => void {
  const seen = new Set<string>();
  let primed = false;
  return startPolling(async (signal) => {
    const items = await read(signal);
    if (signal.aborted) return;
    const report = primed || opts.emitFirst === true;
    primed = true;
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      if (report) onNew(item);
    }
    // Forget the oldest keys, which are first in a Set's order, so a long-open screen does not grow for ever.
    for (const key of seen) {
      if (seen.size <= SEEN_LIMIT) break;
      seen.delete(key);
    }
  }, opts);
}

/**
 * "Something changed, load again". `read` answers whatever the screen cares about (ids and times, a count); `onChange`
 * is called with the answer whenever it differs from the last one (`same` decides; default is JSON equality). The first
 * answer sets the starting point and is not reported unless `emitFirst` is true.
 */
export function pollChanges<T>(
  read: (signal: AbortSignal) => Promise<T>,
  onChange: (value: T) => void,
  opts: PollOptions & { emitFirst?: boolean; same?: (a: T, b: T) => boolean },
): () => void {
  const same = opts.same ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  let last: { value: T } | null = null;
  return startPolling(async (signal) => {
    const value = await read(signal);
    if (signal.aborted) return;
    const first = last === null;
    const changed = last !== null && !same(last.value, value);
    last = { value };
    if (changed || (first && opts.emitFirst === true)) onChange(value);
  }, opts);
}
