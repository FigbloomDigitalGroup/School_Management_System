import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads something when a screen opens, and again when asked (pull to refresh, "Try again"). `key` names what is
 * being loaded (a school's id, a class's id): a new key starts over with the skeleton. Until the first answer
 * `data` and `error` are both null, so a slow network reads as "coming", never as "empty". A refresh that fails
 * after data has arrived keeps the data on screen and reports the error beside it. Give `load` null to load
 * nothing (a section this person has no access to); it never reports loading.
 */
export function useLoad<T>(load: (() => Promise<T>) | null, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Which request is the latest, so an answer that arrives late (after a new key, or after leaving) is dropped.
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    const mine = ++latest.current;
    try {
      const next = await fn();
      if (mounted.current && latest.current === mine) { setData(next); setError(null); }
    } catch (err) {
      if (mounted.current && latest.current === mine) setError(err instanceof Error ? err.message : "Could not load this.");
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    void run();
    return () => { latest.current += 1; };
  }, [key, run]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await run();
    if (mounted.current) setRefreshing(false);
  }, [run]);

  const retry = useCallback(() => {
    setError(null);
    void run();
  }, [run]);

  return { data, error, loading: !!load && data === null && error === null, refreshing, refresh, retry };
}
