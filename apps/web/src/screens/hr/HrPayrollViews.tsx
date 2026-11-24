import { hrCardState, type HrCardState, type HrStatus } from "@figbloom/shared";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";

/**
 * The Figbloom HR & Payroll card (HR_CONNECT_SPEC.md), showing only what it's given (no calls), so the tests can
 * render it: connected (or not checkable) with Open, setting up with Check again, not connected with Request,
 * requested with the date.
 */

export interface HrPayrollCardProps {
  schoolName: string;
  /** open-hr's answer, or null until it's in. */
  status: HrStatus | null;
  /** The status question failed. */
  failed: boolean;
  requesting: boolean;
  checking: boolean;
  /** The request's own failure, said under the card. */
  error: string | null;
  onOpen: () => void;
  onRequest: () => void;
  onCheckAgain: () => void;
}

const PILLS: Record<HrCardState, { text: string; tone: Tone }> = {
  connected: { text: "Connected", tone: "ok" },
  setting_up: { text: "Setting up", tone: "warn" },
  not_connected: { text: "Not connected", tone: "muted" },
  requested: { text: "Requested", tone: "info" },
};

export const HR_PITCH = [
  "Run payroll and payslips",
  "Leave and attendance",
  "Staff from Figbloom Schools added automatically",
  "Billed separately as an add-on",
];

export function formatRequestDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const CARD = "max-w-xl rounded-lg border border-line bg-white p-6";

export function HrPayrollCard(p: HrPayrollCardProps) {
  if (!p.status && !p.failed) {
    return (
      <div className={CARD} aria-busy="true" aria-label="Loading HR & Payroll">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
        <Skeleton className="mt-5 h-9 w-44" />
      </div>
    );
  }

  if (!p.status) {
    return (
      <div className={CARD}>
        <CardHeader />
        <p role="alert" className="mt-3 text-[13px] text-warn-ink">Couldn't check HR &amp; Payroll for your school. Try again in a moment.</p>
        <Button className="mt-5" onClick={p.onCheckAgain} disabled={p.checking}>{p.checking ? "Checking…" : "Try again"}</Button>
      </div>
    );
  }

  if (!p.status.enabled) {
    return (
      <div className={CARD}>
        <CardHeader />
        <p className="mt-3 text-[13px] text-ink-muted">HR &amp; Payroll isn&apos;t available for your account.</p>
      </div>
    );
  }

  const state = hrCardState(p.status);
  return (
    <div className={CARD}>
      {/* couldn't be checked: offered like connected, without claiming it is */}
      <CardHeader state={p.status.connection === "unknown" ? undefined : state} />

      {state === "connected" && (
        <>
          <p className="mt-3 text-[13px] text-ink-muted">Payroll, payslips, leave and attendance for your team.</p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={p.onOpen}>
              Open Figbloom HR <span aria-hidden>↗</span>
            </Button>
            <span className="text-[12px] text-ink-faint">Opens in a new tab</span>
          </div>
        </>
      )}

      {state === "setting_up" && (
        <>
          <p className="mt-3 text-[13px] text-ink-muted">
            Figbloom HR is being set up for {p.schoolName}. The school&apos;s admins will receive an email invitation.
          </p>
          <Button className="mt-5" onClick={p.onCheckAgain} disabled={p.checking} aria-busy={p.checking || undefined}>
            {p.checking ? "Checking…" : "Check again"}
          </Button>
        </>
      )}

      {(state === "not_connected" || state === "requested") && (
        <>
          <p className="mt-3 text-[13px] text-ink-muted">Run your school&apos;s HR and payroll in Figbloom HR, connected to Figbloom Schools.</p>
          <ul className="mt-3 grid gap-1.5 text-[13px]">
            {HR_PITCH.map((point) => (
              <li key={point} className="flex items-start gap-2">
                <span aria-hidden className="text-forest">✓</span>
                {point}
              </li>
            ))}
          </ul>
          {state === "requested" ? (
            <>
              <p className="mt-4 text-[13px] text-ink-muted">
                Requested on {formatRequestDate(p.status.requestedAt!)}. Our team will contact you to set it up.
              </p>
              <Button variant="primary" className="mt-4" disabled>
                <span aria-hidden>✓</span> Request sent
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              className="mt-5 inline-flex items-center gap-2"
              onClick={p.onRequest}
              disabled={p.requesting || !p.status.canRequestHr}
              aria-busy={p.requesting || undefined}
            >
              {p.requesting && <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
              {p.requesting ? "Sending request…" : "Request Figbloom HR"}
            </Button>
          )}
        </>
      )}

      {p.error && <p role="alert" className="mt-3 text-[13px] text-warn-ink">{p.error}</p>}
    </div>
  );
}

function CardHeader({ state }: { state?: HrCardState }) {
  const pill = state ? PILLS[state] : null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span aria-hidden className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-page text-[16px] text-forest">◎</span>
      <h2 className="text-[15px] font-semibold">Figbloom HR &amp; Payroll</h2>
      {pill && (
        <Badge tone={pill.tone}>
          <span className="sr-only">Status: </span>
          {pill.text}
        </Badge>
      )}
    </div>
  );
}
