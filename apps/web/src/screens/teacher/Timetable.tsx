import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { currentPeriodIndex, formatShortDate, todayWeekday, type Weekday } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { fetchCurrentTerm, fetchTeacherClasses, fetchTeacherClassTimetable, type TeacherTimetableRow } from "../../lib/teacherData";
import { currentWeekDates, fetchCoverageThisWeek } from "../../lib/coverage";
import { WEEKDAYS } from "@figbloom/shared";

const ALL = "all" as const;
const WEEK = "week" as const;
type DayFilter = Weekday | typeof WEEK;
const DAY_FILTERS: DayFilter[] = [WEEK, ...WEEKDAYS];
const DAY_LABEL: Record<DayFilter, string> = { week: "Week", Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri" };

interface DisplayRow extends TeacherTimetableRow {
  classId: string;
  className: string;
}

export function TeacherTimetable() {
  const { profile, tenant } = useTenantSession();
  const [params] = useSearchParams();
  const { data: classListData, loading: classesLoading } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const classesData = useMemo(() => classListData ?? [], [classListData]);
  const { data: term } = useAsync(() => fetchCurrentTerm(), []);
  const [classId, setClassId] = useState<string>(ALL);
  const nowDay = todayWeekday();
  // Defaults to the whole week — "week" here means "show every day's
  // section"; picking a specific day tab narrows down to just that one,
  // same rows either way, just fewer of them.
  const [day, setDay] = useState<DayFilter>(WEEK);
  // This week's real calendar date for whichever day is being rendered —
  // leave is requested for a specific date, but the timetable itself is
  // just a recurring weekly template ("Tue" means every Tuesday), so
  // checking leave against a day means checking against THIS week's date
  // for that day. Always fetched for the whole week regardless of which
  // day tab is active — cheap (bounded by who's on leave this week) and
  // means switching tabs never re-fetches.
  const weekDates = useMemo(() => currentWeekDates(), []);
  const { data: weekCoverage } = useAsync(() => fetchCoverageThisWeek(tenant.id), [tenant.id]);
  const coverageByDayClassTime = useMemo(
    () => new Map((weekCoverage ?? []).map((c) => [`${c.weekday}|${c.classId}|${c.time}`, c])),
    [weekCoverage],
  );

  // A deep link (e.g. from "My classes") asking for one specific class wins
  // over the "all classes" default, applied once the class list is in.
  useEffect(() => {
    const requested = params.get("class");
    if (!requested) return;
    if (classesData.some((c) => c.id === requested)) setClassId(requested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classesData]);

  const isAll = classId === ALL;
  const cls = isAll ? null : classesData.find((c) => c.id === classId) ?? null;
  // Surfaced separately from the class pills below — a class teacher's own
  // homeroom is the one class whose whole schedule (not just their own
  // periods) matters to them by default, not just another item in the list.
  const homeroom = classesData.find((c) => c.class_teacher_id === profile.id) ?? null;

  const { data: timetable, loading: timetableLoading } = useAsync(
    () => (!isAll && classId ? fetchTeacherClassTimetable(classId, profile.id) : Promise.resolve(null)),
    [isAll, classId, profile.id],
  );
  // "All" classes needs every class's timetable at once, so its own daily
  // schedule (across classes) can be assembled — fetched only while that
  // pill is actually selected, not on every render.
  const { data: allTimetables, loading: allLoading } = useAsync(
    () => (isAll && classesData.length
      ? Promise.all(classesData.map((c) => fetchTeacherClassTimetable(c.id, profile.id).then((t) => ({ classId: c.id, className: c.name, ...t }))))
      : Promise.resolve(null)),
    [isAll, classesData, profile.id],
  );
  const loading = isAll ? allLoading : timetableLoading;

  function rowsForDay(d: Weekday): DisplayRow[] {
    return isAll
      ? (allTimetables ?? [])
          .flatMap((t) => t.byDay[d].filter((r) => r.mine && r.subjectId).map((r) => ({ ...r, classId: t.classId, className: t.className })))
          .sort((a, b) => a.time.localeCompare(b.time))
      : (timetable?.byDay[d] ?? []).map((r) => ({ ...r, classId: cls?.id ?? "", className: cls?.name ?? "" }));
  }

  const days = day === WEEK ? WEEKDAYS : [day];
  const allEmpty = days.every((d) => rowsForDay(d).length === 0);

  function renderRow(r: DisplayRow, d: Weekday, isNow: boolean) {
    const free = r.label === "Games" || r.label === "Library";
    const gap = coverageByDayClassTime.get(`${d}|${r.classId}|${r.time}`);
    const needsCover = !!gap && !gap.assignment;
    const resolved = !!gap?.assignment;
    return (
      <div key={`${d}-${r.classId}-${r.time}`} className="flex items-center gap-3.5 rounded-xl border px-4 py-3"
        style={{
          borderColor: needsCover ? "#B8460A" : resolved ? "#2E7D4F" : isNow ? "var(--accent)" : r.mine ? "#BFE0CB" : "#E2E6E2",
          background: needsCover ? "#FDEBDF" : resolved ? "#E3EFE7" : isNow ? "#FFF8F6" : r.mine ? "#F1F8F3" : "#fff",
          opacity: r.mine ? 1 : 0.7,
        }}>
        <span className="w-12 shrink-0 font-mono text-[11.5px] text-ink-muted">{r.time}</span>
        <span className="h-8 w-[3px] shrink-0 rounded" style={{ background: isNow ? "var(--accent)" : free ? "#E7EBE8" : "#2E7D4F" }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium">{r.label}</span>
          <span className="text-[12px] text-ink-faint">
            {r.room}{r.className ? ` · ${r.className}` : ""}{!r.mine && r.teacherName ? ` · taught by ${r.teacherName}` : ""}
          </span>
          {needsCover && (
            <span className="mt-0.5 block text-[11.5px] font-semibold text-warn-ink">
              {r.teacherName ?? "The assigned teacher"} is on approved leave {formatShortDate(weekDates[d])} — needs cover
            </span>
          )}
          {resolved && (
            <span className="mt-0.5 block text-[11.5px] font-semibold text-ok-ink">
              {gap.assignment!.coveringTeacherId
                ? `Covered by ${gap.assignment!.coveringTeacherName} — ${r.teacherName ?? "the usual teacher"} is on leave`
                : `Marked as a free period — ${r.teacherName ?? "the usual teacher"} is on leave`}
            </span>
          )}
        </span>
        {isNow && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: "var(--accent)" }}>NOW</span>}
      </div>
    );
  }

  function renderDaySection(d: Weekday) {
    const dayRows = rowsForDay(d);
    const nowIdx = d === nowDay ? currentPeriodIndex(dayRows.map((r): [string, string, string] => [r.time, r.label, r.room])) : -1;
    return (
      <div key={d} className={day === WEEK ? "mb-5" : undefined}>
        {day === WEEK && (
          <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">
            {d}{d === nowDay ? " · Today" : ""}
          </h3>
        )}
        {dayRows.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">
            {day === WEEK ? "Nothing scheduled." : emptyDayMessage}
          </p>
        ) : (
          <div className="grid gap-2">
            {dayRows.map((r, i) => renderRow(r, d, d === nowDay && i === nowIdx))}
          </div>
        )}
      </div>
    );
  }

  const emptyDayMessage = isAll
    ? "You have no periods scheduled on this day, across any of your classes."
    : timetable?.isClassTeacher
      ? `No timetable set for ${cls?.name ?? "this class"} yet — ask the school office to set one up under School settings.`
      : `Nothing of yours on ${cls?.name ?? "this class"}'s timetable for this day.`;

  return (
    <>
      <PageHead
        eyebrow={`Timetable${term ? ` · ${term.name}` : ""}`}
        title={cls ? cls.name : "Your week"}
        blurb={
          isAll
            ? "Every period you teach, across all your classes."
            : timetable?.isClassTeacher
              ? `You're the class teacher for ${cls?.name ?? "this class"} — every period is shown, not just yours, so you can see who teaches what. Yours are highlighted.`
              : "Showing only the periods you teach in this class."
        }
      />
      <div className="px-7 py-6">
        {classesLoading ? (
          <TableSkeleton rows={6} />
        ) : classesData.length === 0 ? (
          <p className="text-[13px] text-ink-muted">You aren't assigned to any classes yet.</p>
        ) : (
          <>
            {homeroom && (
              <button
                onClick={() => setClassId(homeroom.id)}
                className="mb-3 flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-left"
                style={classId === homeroom.id ? { borderColor: "var(--accent)", background: "#FFF8F6" } : { borderColor: "#E2E6E2", background: "#fff" }}
              >
                <span aria-hidden className="text-[16px]">🏠</span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Your homeroom</span>
                  <span className="block text-[13.5px] font-medium">{homeroom.name} — see the whole class's timetable</span>
                </span>
              </button>
            )}

            {classesData.length > 1 && (
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {[{ id: ALL, name: "All" }, ...classesData].map((c) => (
                  <button key={c.id} onClick={() => setClassId(c.id)} className="rounded-full px-3.5 py-2 text-small"
                    style={classId === c.id ? { background: "var(--accent)", color: "#fff", fontWeight: 600 } : { background: "#F3F1EF", color: "#5F6B62" }}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}

            <div className="mb-4 flex gap-1.5">
              {DAY_FILTERS.map((d) => (
                <button key={d} onClick={() => setDay(d)} className="rounded-full px-3.5 py-2 text-small"
                  style={day === d ? { background: "var(--accent-deep)", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}>
                  {DAY_LABEL[d]}
                </button>
              ))}
            </div>

            {loading ? (
              <TableSkeleton rows={6} />
            ) : allEmpty ? (
              <p className="text-[13px] text-ink-muted">{emptyDayMessage}</p>
            ) : (
              <div className="grid max-w-[720px] gap-2">
                {days.map((d) => renderDaySection(d))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
