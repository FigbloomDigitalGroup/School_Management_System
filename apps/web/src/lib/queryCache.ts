import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * A small shared query cache: stale-while-revalidate for the screens that
 * read the same thing over and over (the inventory pages and their drill-downs).
 *
 * The app has no query library (it uses the home-grown useAsync), and adding
 * one for a handful of screens isn't worth the dependency. This keeps one
 * entry per key in memory for the tab's lifetime: going back to a page shows
 * what it had at once and refetches in the background when the entry is older
 * than its staleTime. Writes call invalidate() with a key prefix so the next
 * read (and any mounted reader) refetches.
 *
 * Keys always start with the tenant id, so one school's rows can never be
 * served to another session in the same tab.
 */

interface Entry {
  data?: unknown;
  error?: Error;
  at: number;
  /** Bumped by invalidate(): a fetch started before it is not allowed to write back. */
  gen: number;
  inflight?: Promise<unknown>;
  listeners: Set<() => void>;
}

const store = new Map<string, Entry>();
/** Plenty for a session's screens; the oldest unwatched entries go first. */
const MAX_ENTRIES = 400;

function entry(key: string): Entry {
  let e = store.get(key);
  if (!e) {
    e = { at: 0, gen: 0, listeners: new Set() };
    store.set(key, e);
    if (store.size > MAX_ENTRIES) {
      for (const [k, old] of store) {
        if (store.size <= MAX_ENTRIES) break;
        if (old.listeners.size === 0 && !old.inflight && k !== key) store.delete(k);
      }
    }
  }
  return e;
}

// ---------------------------------------------------------------- whose cache this is

let scope: string | null = null;

/** Who the cache belongs to (the signed-in user). A different user, or nobody, empties it. */
export function setCacheScope(next: string | null): void {
  if (next === scope) return;
  scope = next;
  store.clear();
}

export function cacheScope(): string | null {
  return scope;
}

/** For useAsync: a plain read and write, no subscription. */
export function cacheGet<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined;
}

export function cacheSet(key: string, data: unknown): void {
  const e = entry(key);
  e.data = data;
  e.error = undefined;
  e.at = Date.now();
}

function notify(e: Entry) {
  for (const l of e.listeners) l();
}

function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const e = entry(key);
  if (e.inflight) return e.inflight as Promise<T>;
  const gen = e.gen;
  const p = fn().then(
    (data) => {
      if (e.gen === gen) { e.data = data; e.error = undefined; e.at = Date.now(); }
      return data;
    },
    (error: Error) => {
      if (e.gen === gen) { e.error = error; e.at = Date.now(); }
      throw error;
    },
  ).finally(() => {
    if (e.inflight === p) e.inflight = undefined;
    notify(e);
  });
  e.inflight = p;
  notify(e);
  return p;
}

/** Drops every entry whose key starts with the prefix; mounted readers refetch. */
export function invalidate(prefix: string): void {
  for (const [key, e] of store) {
    if (!key.startsWith(prefix)) continue;
    e.gen += 1;
    e.at = 0;
    e.inflight = undefined;
    notify(e);
  }
}

/** Reads a cached value without subscribing (for an item opened from a list already on screen). */
export function peek<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined;
}

/** For tests. */
export function clearQueryCache(): void {
  store.clear();
}

export interface QueryState<T> {
  data: T | null;
  /** True only when there is nothing to show yet: a background refetch keeps the old data on screen. */
  loading: boolean;
  /** A refetch is under way (old data still shown). */
  refreshing: boolean;
  error: Error | null;
}

/**
 * useAsync with a cache. `key` must name everything the fetch depends on
 * (tenant, filters, page); `null` skips the fetch (e.g. until a modal opens).
 */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, { staleTime = 60_000 }: { staleTime?: number } = {}): QueryState<T> {
  const [, force] = useState(0);
  const snapshot = useSyncExternalStore(
    (cb) => {
      if (!key) return () => {};
      const e = entry(key);
      e.listeners.add(cb);
      return () => { e.listeners.delete(cb); };
    },
    () => (key ? `${entry(key).at}:${entry(key).gen}:${entry(key).inflight ? 1 : 0}` : ""),
  );

  useEffect(() => {
    if (!key) return;
    const e = entry(key);
    if (!e.inflight && (e.at === 0 || Date.now() - e.at > staleTime)) {
      run(key, fn).catch(() => force((n) => n + 1));
    }
    // fn is recreated each render; the key names what it fetches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, snapshot, staleTime]);

  if (!key) return { data: null, loading: false, refreshing: false, error: null };
  const e = entry(key);
  const has = e.data !== undefined;
  return {
    data: has ? (e.data as T) : null,
    loading: !has && !e.error,
    refreshing: !!e.inflight && has,
    error: has ? null : e.error ?? null,
  };
}
