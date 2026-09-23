import { useNavigate, useParams } from "react-router-dom";
import { formatMoney, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState } from "../../components/ui/DataTable";
import { Button } from "../../components/ui/Button";
import { formatShortDate } from "@figbloom/shared";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { ChildSwitcher } from "./ChildSwitcher";

/**
 * Desktop dashboard for the selected child: the fee balance, how they are
 * doing (attendance and mean grade), an absence callout when it matters, and
 * the freshest word from the school. Everything here also lives on a
 * dedicated screen (Fees, Results, Inbox) — this page is the "at a glance"
 * summary that links onward.
 */
export function ParentHome() {
  const navigate = useNavigate();
  const { slug } = useParams();
  const { tenant } = useTenantSession();
  const { data, loading, error, child } = useParentData();

  const statCards = child
    ? [
        {
          label: "Attendance",
          value: child.attendancePct === null ? "—" : `${child.attendancePct}%`,
          sub: child.attendancePct === null ? "No attendance recorded yet" : "this term",
        },
        {
          label: "Mean grade",
          value: child.mean === null ? "—" : gradeFor(child.mean, gradingSchemeFor(tenant.country, child.classLevel)),
          sub: child.mean === null ? "Not published yet" : `${child.mean} marks${child.examName ? `, ${child.examName}` : ""}`,
        },
      ]
    : [];

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Home"}
        title={child ? child.first : "Home"}
        blurb={data?.termLabel ? `${data.termLabel} at a glance.` : undefined}
        actions={<ChildSwitcher />}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the dashboard: {error.message}
          </p>
        ) : loading || !data ? (
          <>
            <Skeleton className="h-28 rounded-lg" />
            <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="mt-2 h-6 w-16" />
                  <Skeleton className="mt-1.5 h-2.5 w-24" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-5 h-4 w-32" />
            <div className="mt-2 grid gap-2">
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
            </div>
          </>
        ) : !child ? (
          <EmptyState
            title="No child linked"
            body="This account is not yet linked to a learner. Contact the school office."
          />
        ) : (
          <>
            <section className="rounded-lg border border-line bg-white p-5">
              <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">
                FEE BALANCE{data.termLabel ? ` · ${data.termLabel.toUpperCase()}` : ""}
              </div>
              <div
                className="mt-1.5 text-[32px] font-bold tracking-tight"
                style={{ color: child.balance > 0 ? "var(--accent-deep)" : "#1B4D2E" }}
              >
                {child.balance > 0 ? formatMoney(child.balance, tenant.country) : "Cleared"}
              </div>
              <p className="mt-1.5 max-w-[560px] text-[13px] leading-relaxed text-ink-muted">
                {child.balance > 0
                  ? `Of ${formatMoney(child.billed, tenant.country)} billed. Part payment is fine — many families pay across the term.`
                  : `All ${formatMoney(child.billed, tenant.country)} paid. Nothing due until the next term.`}
              </p>
              {child.balance > 0 && (
                <Button variant="accent" className="mt-3.5" onClick={() => navigate(`/s/${slug}/parent/fees?pay=1`)}>
                  Pay with M-Pesa
                </Button>
              )}
            </section>

            <div className="mt-4">
              <StatRow stats={statCards} />
            </div>

            {child.attendancePct !== null && child.attendancePct < 90 && (
              <div className="mt-4 flex gap-3 rounded-lg border border-orange-line bg-orange-soft p-4">
                <div className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-orange text-[13px] font-bold text-white">!</div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-orange-ink">
                    {child.absentDates.length > 0
                      ? `${child.first} missed ${child.absentDates.length} day${child.absentDates.length === 1 ? "" : "s"} this term`
                      : `${child.first}'s attendance is below 90% this term`}
                  </div>
                  <p className="mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-orange-ink">
                    {child.absentDates.length > 0
                      ? `${child.absentDates.slice(-2).map(formatShortDate).join(" and ")}, unexplained. If there was a reason, telling the class teacher clears it from the record.`
                      : "Mostly lateness rather than full absence. Worth a word with the class teacher if there is a reason."}
                  </p>
                </div>
              </div>
            )}

            <section className="mt-5 overflow-hidden rounded-lg border border-line bg-white">
              <header className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">From the school</h2>
                <button
                  onClick={() => navigate(`/s/${slug}/parent/inbox`)}
                  className="text-[12.5px] font-semibold"
                  style={{ color: "var(--accent-deep)" }}
                >
                  Open inbox →
                </button>
              </header>
              <div>
                {data.messages.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">Nothing from the school yet.</div>
                ) : (
                  data.messages.slice(0, 3).map((m) => (
                    <button
                      key={m.id}
                      onClick={() => navigate(`/s/${slug}/parent/inbox`)}
                      className="flex w-full items-start gap-3 border-b border-line-soft px-4 py-3 text-left last:border-0 hover:bg-page"
                    >
                      <div
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[12px]"
                        style={{ background: m.who === "school" ? "var(--accent-deep)" : "#EEF1EE", color: m.who === "school" ? "#fff" : "#5F6B62" }}
                      >
                        {m.who === "school" ? "◈" : "✎"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-medium">{m.subject}</span>
                          <span className="shrink-0 text-[11px] text-ink-faint">{m.when}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-muted">{m.body.split("\n")[0]}</p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
