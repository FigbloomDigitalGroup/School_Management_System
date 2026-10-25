import { useEffect, useState } from "react";
import { loadParentHomework, type ChildHomework } from "@figbloom/shared";
import { useChildren, useParentProfileId } from "../data";

/**
 * Homework for every one of the parent's children, keyed by student id — the
 * same loader web's parent Homework screen uses. Loaded on its own, not as
 * part of the cached parent data, so fees and results never wait on it.
 * `byChild` is null while loading; `failed` means the fetch errored (most
 * often no connection), so an empty list is never shown as "nothing set".
 */
export function useParentHomework(): { byChild: Record<string, ChildHomework> | null; failed: boolean; reload: () => void } {
  const profileId = useParentProfileId();
  const ids = useChildren().map((c) => c.id).join(",");
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<{ byChild: Record<string, ChildHomework> | null; failed: boolean }>({ byChild: null, failed: false });

  useEffect(() => {
    let alive = true;
    loadParentHomework(profileId, ids ? ids.split(",") : [])
      .then((byChild) => { if (alive) setState({ byChild, failed: false }); })
      .catch(() => { if (alive) setState((s) => ({ byChild: s.byChild, failed: true })); });
    return () => { alive = false; };
  }, [profileId, ids, reloadKey]);

  return { ...state, reload: () => setReloadKey((k) => k + 1) };
}
