import type { Ref } from "react";
import { HR_LAUNCH_PROBLEMS, hrPagePath, type HrLaunchProblem } from "@figbloom/shared";

/**
 * What the launch tab shows (no calls, so the tests can render it; the classes are in hrLaunch.css): the full-screen
 * "Opening Figbloom HR" orbit loader, exactly as HR's own /handoff page and boot screen (HR_HANDOFF_LOADER_SPEC.md),
 * or a problem on the same page colour and font with the logo still, a title, a message and what to do next.
 */
export interface HrLaunchViewProps {
  /** null while working. */
  problem: HrLaunchProblem | null;
  /** Past 8 seconds: "Still working…" under the label. */
  stillWorking: boolean;
  /** The school's slug, for the links back (null: links to sign-in instead). */
  slug: string | null;
  /** window.close() didn't work (a tab not opened by a script): a link back instead of "Close tab". */
  cantClose: boolean;
  onRetry: () => void;
  onClose: () => void;
  titleRef?: Ref<HTMLHeadingElement>;
}

export const HR_LAUNCH_LABEL = "Opening Figbloom HR";

export function HrLaunchView({ problem, stillWorking, slug, cantClose, onRetry, onClose, titleRef }: HrLaunchViewProps) {
  if (!problem) {
    return (
      <div className="hrl-screen">
        <div className="hrl-loader hrl-animated" role="status" aria-live="polite" aria-label={HR_LAUNCH_LABEL}>
          <FigbloomMark size={120} />
          <div className="hrl-label">
            <div>
              {HR_LAUNCH_LABEL}
              <span className="hrl-dot">.</span>
              <span className="hrl-dot">.</span>
              <span className="hrl-dot">.</span>
            </div>
            {stillWorking && <div className="hrl-still">Still working…</div>}
          </div>
        </div>
      </div>
    );
  }

  const shown = HR_LAUNCH_PROBLEMS[problem];
  return (
    <div className="hrl-screen">
      <div className="hrl-error" role="alert">
        <FigbloomMark size={64} />
        <h1 ref={titleRef} tabIndex={-1} className="hrl-title">{shown.title}</h1>
        <p className="hrl-message">{shown.message}</p>
        <div className="hrl-actions">
          {problem === "session" ? (
            <a href="/signin" className="hrl-primary">Sign in</a>
          ) : (
            <>
              {problem === "not_enabled" && slug && (
                <a href={hrPagePath(slug)} className="hrl-primary">Request Figbloom HR</a>
              )}
              <button type="button" onClick={onRetry} className={problem === "not_enabled" && slug ? "hrl-secondary" : "hrl-primary"}>
                Try again
              </button>
            </>
          )}
          {cantClose ? (
            <a href={slug ? `/s/${slug}/admin` : "/signin"} className="hrl-link">Back to Figbloom Schools</a>
          ) : (
            <button type="button" onClick={onClose} className="hrl-secondary">Close tab</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Figbloom HR orbit logo (bloomHR FigbloomLoader). It moves only inside .hrl-animated (the loading screen). */
function FigbloomMark({ size }: { size: number }) {
  return (
    <svg className="hrl-logo" viewBox="8 5 48 48" aria-hidden="true" width={size} height={size}>
      <circle className="hrl-arc" cx="32" cy="29" r="19" pathLength="360" fill="none" strokeWidth="5.5" strokeLinecap="round" />
      <circle className="hrl-bowl" cx="32" cy="29" r="9" fill="none" strokeWidth="6.5" />
      <path className="hrl-leaf" d="M33 14.5 C33 8.5 38 5.5 43 5.5 C43 11.5 39 14.5 33 14.5 Z" />
    </svg>
  );
}
