import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * The one place a screen goes from "nothing yet" to "here is the real row" —
 * every screen that used to import static arrays from lib/mock now calls a
 * Supabase query through this instead, and renders a Skeleton while loading
 * is true, exactly as it will once this hits production data.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  // The deps the last fetch was started for. On the render where deps change,
  // the effect below has not run yet, so `state.loading` is still false from
  // the previous fetch — without this, that one frame paints the empty state.
  const [fetchedFor, setFetchedFor] = useState<unknown[]>(deps);

  useEffect(() => {
    let alive = true;
    setFetchedFor(deps);
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => { if (alive) setState({ data, loading: false, error: null }); })
      .catch((error: Error) => { if (alive) setState({ data: null, loading: false, error }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return sameDeps(fetchedFor, deps) ? state : { ...state, loading: true, error: null };
}
