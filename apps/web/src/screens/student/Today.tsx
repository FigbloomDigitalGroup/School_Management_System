import { timetable } from "../../lib/mock";
import { daysUntil, formatDueLabel } from "../../lib/studentData";
import { useStudentData } from "../../lib/studentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState } from "../../components/ui/DataTable";

/**
 * Desktop dashboard for a student. Mirrors the phone app's "Today" screen —
 * same NOW=2 hardcoded period (the mock timetable has no real "current
 * period" concept, and Tuesday is the day StudentApp.tsx has always shown)
 * — but laid out as a console page instead of a scrolling phone card stack.
 */
const NOW = 2;
const DAY = "Tue";

export function StudentToday() {
  const { profile } = useTenantSession();
  const { data, loading, error } = useStudentData();
  const firstName = profile.full_name.split(" ")[0];

  if (error) {
    return (
      <>
        <PageHead eyebrow="Today" title="Today" />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load today: {error.message}
          </p>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHead eyebrow="Today" title="Loading…" />
        <div className="px-7 py-6">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="mt-5 h-32 rounded-lg" />
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHead eyebrow="Today" title="Today" />
        <div className="px-7 py-6">
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        </div>
      </>
    );
  }

  const work = data.work;
  const open = work.filter((w) => w.state !== "done").slice().sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const overdue = work.filter((w) => w.state === "late");

  const todayRows = timetable[DAY] ?? [];
  const nowP = todayRows[NOW];
  const nextP = todayRows[NOW + 1];
  const restOfDay = todayRows.slice(NOW + 1);
  const dueNext = open.slice(0, 3);

  return (
    <>
      <PageHead
        eyebrow={data.className || "Today"}
        title={`Good morning, ${firstName}`}
        blurb={
          overdue.length > 0
            ? `${overdue.length} piece${overdue.length === 1 ? "" : "s"} of work ${overdue.length === 1 ? "is" : "are"} overdue. Everything else is on track.`
            : open.length > 0
              ? `${open.length} piece${open.length === 1 ? "" : "s"} of work still to hand in this week.`
              : "Nothing due this week. A quiet one."
        }
      />

      <div className="px-7 py-6">
        <StatRow
          stats={[
            { label: "Now", value: nowP ? nowP[1] : "—", sub: nowP ? nowP[2] : "No lesson recorded" },
            { label: "To hand in", value: String(open.length), sub: "across all subjects" },
            { label: "Overdue", value: String(overdue.length), sub: overdue.length ? "needs handing in" : "all clear", alarming: overdue.length > 0 },
          ]}
        />

        {overdue.length > 0 && (
          <div className="mt-5 rounded-lg border border-orange-line bg-orange-soft p-4">
            <div className="text-body font-semibold text-orange-ink">
              {overdue.length === 1 ? `${overdue[0]!.subject} work is late` : `${overdue.length} pieces of work are late`}
            </div>
            <p className="mt-1.5 text-small leading-relaxed text-orange-ink">
              {overdue.length === 1
                ? `${overdue[0]!.title} — hand it in at the next lesson. Late work is still marked.`
                : `${overdue.map((w) => w.subject).join(", ")} — hand these in at the next lesson. Late work is still marked.`}
            </p>
          </div>
        )}

        <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
          <section className="overflow-hidden rounded-lg border border-line">
            <header className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Rest of today</h2>
            </header>
            <div>
              {restOfDay.length === 0 ? (
                <p className="px-4 py-6 text-center text-small text-ink-faint">That's it for today.</p>
              ) : (
                restOfDay.map(([time, subject, room]) => (
                  <div key={time} className="flex items-center gap-3.5 border-b border-line-soft px-4 py-2.5 last:border-0">
                    <span className="w-12 shrink-0 font-mono text-[12px] text-ink-muted">{time}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{subject}</span>
                    <span className="shrink-0 text-[12px] text-ink-faint">{room}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-line">
            <header className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Due soon</h2>
            </header>
            <div>
              {dueNext.length === 0 ? (
                <p className="px-4 py-6 text-center text-small text-ink-faint">Nothing due this week.</p>
              ) : (
                dueNext.map((w) => (
                  <div key={w.id} className="flex items-center gap-3.5 border-b border-line-soft px-4 py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{w.title}</div>
                      <div className="mt-0.5 truncate text-[11.5px] text-ink-faint">{w.subject}</div>
                    </div>
                    <span
                      className="shrink-0 text-[12px] font-semibold"
                      style={{ color: w.state === "late" ? "#B8460A" : daysUntil(w.dueOn) <= 0 ? "#8A3D08" : "#5F6B62" }}
                    >
                      {w.state === "late" ? "Overdue" : formatDueLabel(w.dueOn, false)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {nextP && (
          <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
            Next up: {nextP[1]} · {nextP[0]} · {nextP[2]}.
          </p>
        )}
      </div>
    </>
  );
}
