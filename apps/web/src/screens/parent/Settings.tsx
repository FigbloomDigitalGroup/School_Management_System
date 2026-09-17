import { PageHead } from "../../components/ConsoleShell";
import { MyAccountFields } from "../../components/MyAccountFields";
import { Skeleton } from "../../components/ui/Skeleton";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";

const CHANNELS: { label: string; note: string; on: boolean }[] = [
  { label: "Fee reminders", note: "SMS and in the app", on: true },
  { label: "Absence on the day", note: "SMS at 09:00", on: true },
  { label: "Results published", note: "In the app only", on: true },
  { label: "General school notices", note: "In the app only", on: false },
];

/**
 * Account details plus "how we reach you". The channel toggles are visual
 * only — there is no notification-preferences table behind them yet, exactly
 * as in the phone preview.
 */
export function ParentSettings() {
  const { tenant } = useTenantSession();
  const { loading, error, children } = useParentData();

  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb={`Signed in as a parent at ${tenant.name}.`} />

      <div className="px-7 py-6">
        <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
          <div>
            <MyAccountFields />
            {error ? (
              <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-warn-ink">
                <span aria-hidden>✕</span>Could not load your children: {error.message}
              </p>
            ) : loading ? (
              <Skeleton className="mt-3 h-3 w-2/3" />
            ) : (
              <p className="mt-3 max-w-[480px] text-[12.5px] leading-relaxed text-ink-muted">
                {children.length} {children.length === 1 ? "child" : "children"} at {tenant.name}. To add or remove a
                child, the school office has to do it — that is deliberate.
              </p>
            )}
          </div>

          <section className="overflow-hidden rounded-lg border border-line bg-white">
            <header className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">How we reach you</h2>
            </header>
            <div className="px-4">
              {CHANNELS.map((c) => (
                <div key={c.label} className="flex items-center gap-3 border-b border-line-soft py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{c.label}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-faint">{c.note}</div>
                  </div>
                  <div
                    className="flex h-6 w-11 shrink-0 items-center rounded-full p-0.5"
                    style={{ background: c.on ? "var(--accent-deep)" : "#DAD5D4", justifyContent: c.on ? "flex-end" : "flex-start" }}
                  >
                    <div className="h-5 w-5 rounded-full bg-white" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <p className="mt-4 max-w-[620px] text-[12px] leading-relaxed text-ink-faint">
          Fee reminders and same-day absences always go by SMS as well, because they are the two things a parent
          cannot afford to miss.
        </p>
      </div>
    </>
  );
}
