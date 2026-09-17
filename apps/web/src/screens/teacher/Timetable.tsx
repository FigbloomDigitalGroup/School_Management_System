import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { currentPeriodIndex, formatShortDate, todayWeekday, type Weekday } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { fetchCurrentTerm, fetchTeacherClasses, fetchTeacherClassTimetable } from "../../lib/teacherData";
import { currentWeekDates, fetchCoverageForDate } from "../../lib/coverage";
import { WEEKDAYS } from "@figbloom/shared";

export function TeacherTimetable() {
  const { profile } = useTenantSession();
  const [params] = useSearchParams();
  const { data: classListData, loading: classesLoading } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const classesData = useMemo(() => classListData ?? [], [classListData]);
  const { data: term } = useAsync(() => fetchCurrentTerm(), []);
  const [classId, setClassId] = useState<string | null>(null);
  const nowDay = todayWeekday();
  const [day, setDay] = useState<Weekday>(nowDay ?? "Mon");
  // This week's real calendar date for whichever tab is selected — leave is
  // requested for a specific date, but the timetable itself is just a
  // recurring weekly template ("Tue" means every Tuesday), so checking leave
  // against a day tab means checking against THIS week's date for that day.
  const weekDates = useMemo(() => currentWeekDates(), []);
  const { data: dayCoverage } = useAsync(() => fetchCoverageForDate(day, weekDates[day]), [weekDates, day]);
  const coverageByClassTime = useMemo(
    () => new Map((dayCoverage ?? []).map((c) => [`${c.classId}|${c.time}`, c])),
    [dayCoverage],
  );

  useEffect(() => {
    if (classId || classesData.length === 0) return;
    const requested = params.get("class");
    setClassId(classesData.find((c) => c.id === requested)?.id ?? classesData[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, classesData]);

  const cls = classesData.find((c) => c.id === classId) ?? null;
  const { data: timetable, loading: timetableLoading } = useAsync(
    () => (classId ? fetchTeacherClassTimetable(classId, profile.id) : Promise.resolve(null)),
    [classId, profile.id],
  );

  const rows = (day && timetable?.byDay[day]) ?? [];
  const nowIdx = day === nowDay ? currentPeriodIndex(rows.map((r): [string, string, string] => [r.time, r.label, r.room])) : -1;

  return (
    <>
      <PageHead
        eyebrow={`Timetable${term ? ` · ${term.name}` : ""}`}
        title={cls ? cls.name : "Your week"}
        blurb={
          timetable?.isClassTeacher
            ? `You're the class teacher for ${cls?.name ?? "this class"} — showing the whole week, including who teaches what.`
            : "Showing only the periods you teach in this class — pick another one above to see a different class."
        }
        actions={
          classesData.length > 1 ? (
            <select
              value={classId ?? ""}
              onChange={(e) => setClassId(e.target.value)}
              aria-label="Class"
              className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
            >
              {classesData.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : undefined
        }
      />
      <div className="px-7 py-6">
        {classesLoading ? (
          <TableSkeleton rows={6} />
        ) : classesData.length === 0 ? (
          <p className="text-[13px] text-ink-muted">You aren't assigned to any classes yet.</p>
        ) : (
          <>
            <div className="mb-4 flex gap-1.5">
              {WEEKDAYS.map((d) => (
                <button key={d} onClick={() => setDay(d)} className="rounded-full px-3.5 py-2 text-small"
                  style={day === d ? { background: "var(--accent-deep)", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}>
                  {d}
                </button>
              ))}
            </div>

            {timetableLoading ? (
              <TableSkeleton rows={6} />
            ) : rows.length === 0 ? (
              <p className="text-[13px] text-ink-muted">
                {timetable?.isClassTeacher
                  ? `No timetable set for ${cls?.name ?? "this class"} yet — ask the school office to set one up under School settings.`
                  : `Nothing of yours on ${cls?.name ?? "this class"}'s timetable for this day.`}
              </p>
            ) : (
              <div className="grid max-w-[720px] gap-2">
                {rows.map((r, i) => {
                  const isNow = day === nowDay && i === nowIdx;
                  const free = r.label === "Games" || r.label === "Library";
                  const gap = cls ? coverageByClassTime.get(`${cls.id}|${r.time}`) : undefined;
                  const needsCover = !!gap && !gap.assignment;
                  const resolved = !!gap?.assignment;
                  return (
                    <div key={r.time} className="flex items-center gap-3.5 rounded-xl border px-4 py-3"
                      style={{
                        borderColor: needsCover ? "#B8460A" : resolved ? "#2E7D4F" : isNow ? "var(--accent)" : "#E2E6E2",
                        background: needsCover ? "#FDEBDF" : resolved ? "#E3EFE7" : isNow ? "#FFF8F6" : "#fff",
                        opacity: r.mine ? 1 : 0.7,
                      }}>
                      <span className="w-12 shrink-0 font-mono text-[11.5px] text-ink-muted">{r.time}</span>
                      <span className="h-8 w-[3px] shrink-0 rounded" style={{ background: isNow ? "var(--accent)" : free ? "#E7EBE8" : "#2E7D4F" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium">{r.label}</span>
                        <span className="text-[12px] text-ink-faint">
                          {r.room}{cls ? ` · ${cls.name}` : ""}{!r.mine && r.teacherName ? ` · taught by ${r.teacherName}` : ""}
                        </span>
                        {needsCover && (
                          <span className="mt-0.5 block text-[11.5px] font-semibold text-warn-ink">
                            {r.teacherName ?? "The assigned teacher"} is on approved leave {formatShortDate(weekDates[day])} — needs cover
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
                })}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
