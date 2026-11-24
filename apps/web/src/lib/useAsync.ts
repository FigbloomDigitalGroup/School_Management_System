import { useEffect, useState } from "react";
import { cacheGet, cacheScope, cacheSet } from "./queryCache";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export interface AsyncOptions {
  /**
   * Off for live screens (the sick-bay board, chat, bus tracking, payment
   * status): they always show what the server says now, never a remembered copy.
   */
  cache?: boolean;
  /** A key to use instead of the one worked out from the function and deps. */
  key?: string;
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Deps that make a stable key: strings, numbers, booleans, null, and arrays / plain objects of them. Anything else: no cache. */
function stable(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (depth > 2) return false;
  if (Array.isArray(v)) return v.length <= 200 && v.every((x) => stable(x, depth + 1));
  if (t === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v as object).every((x) => stable(x, depth + 1));
  return false;
}

/**
 * The key a fetch is cached under: who is signed in, what the function is
 * (its source: the same query written in the same place), and its deps.
 * Null (not cached) when nobody is signed in or a dep isn't plain data.
 */
export function asyncKey(fn: () => unknown, deps: unknown[], explicit?: string): string | null {
  const scope = cacheScope();
  if (!scope) return null;
  if (explicit) return `${scope}|k|${explicit}`;
  if (!stable(deps)) return null;
  return `${scope}|${fn.toString()}|${JSON.stringify(deps)}`;
}

/**
 * The one place a screen goes from "nothing yet" to "here is the real row" —
 * every screen calls a Supabase query through this and renders a Skeleton
 * while loading is true.
 *
 * With a cache (stale-while-revalidate): a fetch the session has already made
 * with the same deps shows its last answer at once, with no skeleton, and is
 * fetched again quietly behind it. A screen that saves something bumps a
 * reload key in its deps (a new key, fetched fresh); the cache is cleared on
 * sign-out and when another person signs in.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: AsyncOptions = {}): AsyncState<T> {
  const key = opts.cache === false ? null : asyncKey(fn, deps, opts.key);
  const [state, setState] = useState<AsyncState<T>>(() => {
    const hit = key ? cacheGet<T>(key) : undefined;
    return hit !== undefined ? { data: hit, loading: false, error: null } : { data: null, loading: true, error: null };
  });
  // The deps the last fetch was started for. On the render where deps change,
  // the effect below has not run yet, so `state.loading` is still false from
  // the previous fetch — without this, that one frame paints the empty state.
  const [fetchedFor, setFetchedFor] = useState<unknown[]>(deps);

  useEffect(() => {
    let alive = true;
    setFetchedFor(deps);
    const hit = key ? cacheGet<T>(key) : undefined;
    setState(hit !== undefined ? { data: hit, loading: false, error: null } : (s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => {
        if (key) cacheSet(key, data);
        if (alive) setState({ data, loading: false, error: null });
      })
      .catch((error: Error) => { if (alive && hit === undefined) setState({ data: null, loading: false, error }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (sameDeps(fetchedFor, deps)) return state;
  // deps changed and the effect hasn't run: show the cached answer for the new deps if there is one, else loading
  const hit = key ? cacheGet<T>(key) : undefined;
  return hit !== undefined ? { data: hit, loading: false, error: null } : { ...state, loading: true, error: null };
}
