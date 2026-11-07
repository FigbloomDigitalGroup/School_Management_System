import { useEffect, useRef, useState } from "react";

/**
 * A search that runs as a person types, after a short pause (so a name being typed is not a search for each letter),
 * and only once there are enough letters to mean something. An answer that arrives after the person has typed on, or
 * left, is dropped. `key` names what is being searched (learners, staff): a new key searches again. `paused` stops it
 * (the person has already chosen) and clears what it found.
 */
export function useSearch<T>(query: string, search: (q: string) => Promise<T[]>, options: { min?: number; waitMs?: number; paused?: boolean; key?: string } = {}) {
  const { min = 2, waitMs = 250, paused = false, key = "" } = options;
  const [results, setResults] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(search);
  latest.current = search;
  const text = query.trim();

  useEffect(() => {
    if (paused || text.length < min) { setResults([]); setError(null); setSearching(false); return; }
    setSearching(true);
    let alive = true;
    const timer = setTimeout(() => {
      latest.current(text)
        .then((found) => { if (alive) { setResults(found); setError(null); } })
        .catch((err: unknown) => { if (alive) { setResults([]); setError(err instanceof Error ? err.message : "Could not search."); } })
        .finally(() => { if (alive) setSearching(false); });
    }, waitMs);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, min, waitMs, paused, key]);

  /** Whether the person has typed enough for a search to have been asked for. */
  return { results, searching, error, enough: text.length >= min };
}
