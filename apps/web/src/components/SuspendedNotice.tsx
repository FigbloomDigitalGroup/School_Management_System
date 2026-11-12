import { SUSPENDED_SCHOOL_BODY, SUSPENDED_SCHOOL_CONTACT, SUSPENDED_SCHOOL_TITLE } from "@figbloom/shared";

/**
 * "Your school's account is suspended." Shown on sign-in when Auth refuses a
 * banned account or the school picked is suspended, and in place of the
 * console when an open session's school has just been suspended. Never the
 * reason (suspended.ts).
 */
export function SuspendedNotice({ className = "" }: { className?: string }) {
  return (
    <div role="alert" data-testid="suspended-notice" className={`rounded-lg border border-orange-line bg-warn-bg px-4 py-3 text-body text-warn-ink ${className}`}>
      <p className="font-semibold">{SUSPENDED_SCHOOL_TITLE}</p>
      <p className="mt-1">{SUSPENDED_SCHOOL_BODY}</p>
      <p className="mt-1">
        Figbloom support: <a className="font-medium underline" href={`mailto:${SUSPENDED_SCHOOL_CONTACT}`}>{SUSPENDED_SCHOOL_CONTACT}</a>
      </p>
    </div>
  );
}
