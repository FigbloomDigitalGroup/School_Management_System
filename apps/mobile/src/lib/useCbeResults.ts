import { useEffect, useState } from "react";
import { loadPublishedCbeResults, type CbeLearningAreaResult } from "@figbloom/shared";

/**
 * One learner's published CBE strand results (per learning area, the latest
 * published assessment) — the same loader web's parent/student Results use.
 * `results` is null while loading; `failed` means the fetch errored, so the
 * caller should not read an empty list as "nothing published".
 */
export function useCbeResults(studentId: string | null, country: string): { results: CbeLearningAreaResult[] | null; failed: boolean } {
  const [state, setState] = useState<{ for: string | null; results: CbeLearningAreaResult[] | null; failed: boolean }>({ for: null, results: null, failed: false });

  useEffect(() => {
    if (!studentId) return;
    let alive = true;
    loadPublishedCbeResults([studentId], country)
      .then((m) => { if (alive) setState({ for: studentId, results: m.get(studentId) ?? [], failed: false }); })
      .catch(() => { if (alive) setState({ for: studentId, results: null, failed: true }); });
    return () => { alive = false; };
  }, [studentId, country]);

  // A switch to another child must not show the previous child's results while theirs load.
  if (!studentId) return { results: [], failed: false };
  if (state.for !== studentId) return { results: null, failed: false };
  return { results: state.results, failed: state.failed };
}
