import { useEffect, useState } from "react";
import { fetchHealthConsentRequests } from "@figbloom/shared";
import { Button } from "../ui/Button";
import { useAsync } from "../../lib/useAsync";
import { useParentData } from "../../lib/parentContext";

/** Sent by HealthEditor after a family decides, so this list catches up. */
export const HEALTH_CONSENT_EVENT = "figbloom:health-consent";

/**
 * "Health details need your OK": children whose health details were saved
 * before consent was asked for. Review opens the child's profile below, where
 * the parent agrees or deletes them. Says nothing when there's nothing to ask.
 */
export function HealthConsentRequests() {
  const { setChildId } = useParentData();
  const [reloadKey, setReloadKey] = useState(0);
  const { data } = useAsync(() => fetchHealthConsentRequests(), [reloadKey]);

  useEffect(() => {
    const again = () => setReloadKey((k) => k + 1);
    window.addEventListener(HEALTH_CONSENT_EVENT, again);
    return () => window.removeEventListener(HEALTH_CONSENT_EVENT, again);
  }, []);

  if (!data?.length) return null;

  function review(studentId: string) {
    setChildId(studentId);
    // after the profile below has switched to this child
    setTimeout(() => document.getElementById("child-profile")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  return (
    <section className="mb-4 overflow-hidden rounded-lg border border-orange-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold">Health details need your OK</h2>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          The school has health details on file from before it asked for consent. Agree to the school keeping them, or delete them. Either way, your child is treated the same.
        </p>
      </header>
      <ul>
        {data.map((r) => (
          <li key={r.studentId} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
            <span className="text-[13.5px] font-medium">{r.fullName}</span>
            <Button variant="primary" onClick={() => review(r.studentId)}>Review</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
