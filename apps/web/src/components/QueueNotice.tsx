import { useEffect, useState } from "react";
import type { QueuedWrite } from "@figbloom/shared";
import { queue } from "../lib/queue";
import { Button } from "./ui/Button";

const WHAT: Record<string, string> = {
  attendance: "A register",
  marks: "Marks",
  announcements: "A message",
  cbe_results: "CBE results",
  cbe_assessment_comments: "CBE comments",
};

/**
 * Something saved on this device that the server refused. Waiting won't fix it,
 * so the queue set it aside: say what and why, and let the teacher discard it
 * once they have seen it (or re-enter it) rather than carrying it silently.
 */
export function QueueNotice() {
  const [refused, setRefused] = useState<QueuedWrite[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => { void queue.rejected().then((r) => { if (alive) setRefused(r); }).catch(() => {}); };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const first = refused[0];
  if (!first) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-warn-ink/30 bg-warn-ink/5 px-6 py-3 text-[12.5px] text-warn-ink">
      <p className="min-w-0">
        <strong>{WHAT[first.table] ?? "Something"} saved on this device could not be sent</strong>
        {refused.length > 1 ? ` (and ${refused.length - 1} more)` : ""}: {first.rejected?.message}. Check it, enter it again if you still need it, then discard this notice.
      </p>
      <Button onClick={() => { void queue.discard(first.id).then(() => queue.rejected()).then(setRefused); }}>Discard</Button>
    </div>
  );
}
