import { useState } from "react";
import { useCalls } from "./CallHost";

/**
 * Voice and video call buttons for one person. Whether the two of you may
 * call at all is the server's decision (may_contact); a refusal comes back
 * as a toast in its own words, so this can sit anywhere a name is shown.
 */
export function CallButton({ profileId, name, className = "" }: { profileId: string; name: string; className?: string }) {
  const { call, busy } = useCalls();
  const [starting, setStarting] = useState(false);

  async function start(video: boolean) {
    setStarting(true);
    try { await call(profileId, video); } finally { setStarting(false); }
  }

  const btn = "grid h-8 w-8 place-items-center rounded-md border border-[#D3DAD5] bg-white text-[14px] text-ink hover:bg-page disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <span className={`inline-flex shrink-0 gap-1.5 ${className}`} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={btn} disabled={busy || starting} onClick={() => void start(false)}
        aria-label={`Voice call ${name}`} title={`Voice call ${name}`}>
        <span aria-hidden>✆</span>
      </button>
      <button type="button" className={btn} disabled={busy || starting} onClick={() => void start(true)}
        aria-label={`Video call ${name}`} title={`Video call ${name}`}>
        <span aria-hidden>▶</span>
      </button>
    </span>
  );
}
