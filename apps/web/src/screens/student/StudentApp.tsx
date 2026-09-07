import { useRef, useState } from "react";
import { againstMean, gradeFor, pointsFor, type Weekday } from "@figbloom/shared";
import { daysUntil, formatDueLabel, loadStudentData } from "../../lib/studentData";
import { uploadAssignmentSubmission } from "../../lib/uploads";
import { fetchClassTimetable } from "../../lib/timetable";
import { PhoneFrame, TabBar } from "../../components/PhoneFrame";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * The student app. Secondary students get their own login rather than a view
 * inside a parent's — they see their work and marks, never the fee balance.
 *
 * No class position anywhere. Marks are shown against the class mean instead:
 * ranking a fourteen-year-old in an app they check alone at night is a decision,
 * and this one goes the other way.
 */

const NOW = 2;

type Screen = "today" | "timetable" | "work" | "task" | "results" | "notices" | "notice";

export function StudentApp({ deep = "#4E1520" }: { accent?: string; deep?: string }) {
  const { profile, tenant } = useTenantSession();
  const { data, loading } = useAsync(() => loadStudentData(profile.id), [profile.id]);
  const { data: timetable } = useAsync(
    () => (data?.classId ? fetchClassTimetable(data.classId) : Promise.resolve(null)),
    [data?.classId],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [screen, setScreen] = useState<Screen>("today");
  const [day, setDay] = useState("Tue");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [workTab, setWorkTab] = useState<"To do" | "Done">("To do");
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [read, setRead] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [attached, setAttached] = useState<Record<string, string>>({});
  const [uploadError, setUploadError] = useState<Record<string, string>>({});

  const tint = deep;

  if (loading || !data) {
    return (
      <PhoneFrame accent={tint}>
        <header className="shrink-0 px-4 pb-4 pt-3" style={{ background: tint, color: "#fff" }}>
          <Skeleton className="h-6 w-32 bg-white/20" />
          <Skeleton className="mt-2 h-3 w-40 bg-white/10" />
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-app-page px-4 pb-6 pt-4">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="mt-5 h-4 w-32" />
          <div className="mt-2 grid gap-2">
            <Skeleton className="h-14 rounded-2xl" />
            <Skeleton className="h-14 rounded-2xl" />
            <Skeleton className="h-14 rounded-2xl" />
          </div>
        </div>
        <TabBar
          items={[
            { label: "Today", icon: "◈", active: true, onPress: () => {} },
            { label: "Timetable", icon: "▤", active: false, onPress: () => {} },
            { label: "Work", icon: "✎", active: false, onPress: () => {} },
            { label: "Results", icon: "▦", active: false, onPress: () => {} },
            { label: "Notices", icon: "◉", active: false, onPress: () => {} },
          ]}
        />
      </PhoneFrame>
    );
  }

  if (!data.studentId) {
    return (
      <PhoneFrame accent={tint}>
        <header className="shrink-0 px-4 pb-4 pt-3" style={{ background: tint, color: "#fff" }}>
          <div className="text-[21px] font-semibold tracking-tight">No learner record</div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-app-page px-4 pb-6 pt-6 text-center text-[13px] text-app-muted">
          This login is not yet linked to a learner record. Contact the school office.
        </div>
      </PhoneFrame>
    );
  }

  const work = data.work.map((w) => ({ ...w, state: done[w.id] ? ("done" as const) : w.state }));
  const open = work.filter((w) => w.state !== "done").slice().sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const overdue = work.find((w) => w.state === "late");
  const task = work.find((w) => w.id === taskId) ?? null;
  const notices = data.notices;
  const notice = notices.find((n) => n.id === noticeId) ?? notices[0] ?? null;
  const unread = notices.filter((n) => n.unread && !read[n.id]).length;

  const todayRows = timetable?.Tue ?? [];
  const nowP = todayRows[NOW];
  const nextP = todayRows[NOW + 1];

  const studentId = data.studentId;

  async function handleFileSelected(item: { id: string }, file: File | undefined) {
    if (!file) return;
    setUploading((u) => ({ ...u, [item.id]: true }));
    setUploadError((e) => ({ ...e, [item.id]: "" }));
    try {
      await uploadAssignmentSubmission({ tenantId: tenant.id, assignmentId: item.id, studentId, file });
      setAttached((a) => ({ ...a, [item.id]: file.name }));
      setDone((d) => ({ ...d, [item.id]: true }));
    } catch (err) {
      setUploadError((e) => ({ ...e, [item.id]: err instanceof Error ? err.message : "Could not upload the file." }));
    } finally {
      setUploading((u) => ({ ...u, [item.id]: false }));
    }
  }

  const meanMark = data.subjects.length ? Math.round(data.subjects.reduce((a, s) => a + s.score, 0) / data.subjects.length) : null;
  const points = data.subjects.reduce((a, s) => a + pointsFor(s.score), 0);

  const heads: Record<Screen, [string, string]> = {
    today: ["Tuesday", "2 September · week 8"],
    timetable: ["Timetable", data.className],
    work: ["Work", `${open.length} to hand in`],
    task: ["Work", task?.subject ?? ""],
    results: ["Results", data.className],
    notices: ["Notices", unread ? `${unread} unread` : "All read"],
    notice: ["Notices", notice?.from ?? ""],
  };
  const [title, sub] = heads[screen];

  return (
    <PhoneFrame accent={tint}>
      <header className="shrink-0 px-4 pb-4 pt-3" style={{ background: tint, color: "#fff" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[21px] font-semibold tracking-tight">{title}</div>
            <div className="mt-0.5 text-[12.5px] text-white/75">{sub}</div>
          </div>
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/20 text-[13px] font-bold">
            {profile.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-app-page px-4 pb-6">
        {screen === "today" && (
          <>
            <div className="-mt-2.5 rounded-2xl border border-app-line bg-white p-4 shadow-sm">
              {nowP ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9.5px] tracking-[0.12em] text-app-faint">NOW · PERIOD 3</span>
                    <span className="font-mono text-[11px]" style={{ color: tint }}>18 min left</span>
                  </div>
                  <div className="mt-2 text-[19px] font-semibold tracking-tight">{nowP[1]}</div>
                  <div className="mt-0.5 text-[12.5px] text-app-muted">{nowP[2]} · ends 10:00</div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded bg-app-line-soft">
                    <div className="h-1.5 rounded" style={{ width: "62%", background: tint }} />
                  </div>
                </>
              ) : (
                <div className="py-1 text-[13px] text-app-muted">No lesson recorded for this period.</div>
              )}
              {nextP && (
                <div className="mt-3 flex items-center gap-2.5 border-t border-app-line-soft pt-3">
                  <span className="font-mono text-[10px] tracking-[0.1em] text-app-faint">NEXT</span>
                  <span className="text-[13px] font-medium">{nextP[1]}</span>
                  <span className="ml-auto text-[12.5px] text-app-muted">{nextP[0]} · {nextP[2]}</span>
                </div>
              )}
            </div>

            {overdue && (
              <button onClick={() => setScreen("work")} className="mt-4 flex w-full gap-3 rounded-2xl border border-orange-line bg-orange-soft p-3.5 text-left">
                <div className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-orange text-[13px] font-bold text-white">!</div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-orange-ink">{overdue.subject} work is late</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-orange-ink">
                    {overdue.title} — hand it in at the next lesson. Late work is still marked.
                  </p>
                </div>
              </button>
            )}

            <div className="mb-2 mt-5 flex items-baseline justify-between">
              <h2 className="text-[15px] font-semibold">Rest of today</h2>
              <button onClick={() => setScreen("timetable")} className="text-[12.5px] font-semibold" style={{ color: tint }}>Full week</button>
            </div>
            <div className="grid gap-2">
              {todayRows.slice(NOW + 1).map(([time, subject, room]) => (
                <div key={time} className="flex items-center gap-3 rounded-2xl border border-app-line bg-white px-4 py-3">
                  <span className="w-11 shrink-0 font-mono text-[11.5px] text-app-muted">{time}</span>
                  <span className="h-7 w-[3px] shrink-0 rounded bg-app-line" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium">{subject}</span>
                    <span className="text-[12px] text-app-faint">{room}</span>
                  </span>
                </div>
              ))}
            </div>

            <div className="mb-2 mt-5 flex items-baseline justify-between">
              <h2 className="text-[15px] font-semibold">Due this week</h2>
              <button onClick={() => setScreen("work")} className="text-[12.5px] font-semibold" style={{ color: tint }}>All work</button>
            </div>
            <div className="grid gap-2">
              {open.slice(0, 3).map((w) => (
                <button key={w.id} onClick={() => { setTaskId(w.id); setScreen("task"); }}
                  className="flex items-center gap-3 rounded-2xl border border-app-line bg-white px-4 py-3 text-left">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[13px]"
                    style={{ background: w.state === "late" ? "#FDEBDF" : "#F1EDEC", color: w.state === "late" ? "#B8460A" : "#6B605F" }}>
                    {w.state === "late" ? "!" : "◷"}
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{w.title}</span>
                    <span className="text-[12px] text-app-faint">{w.subject}</span>
                  </span>
                  <span className="shrink-0 text-[12px] font-semibold" style={{ color: w.state === "late" ? "#B8460A" : daysUntil(w.dueOn) <= 0 ? "#8A3D08" : "#6B605F" }}>
                    {w.state === "late" ? "Late" : formatDueLabel(w.dueOn, false)}
                  </span>
                </button>
              ))}
              {open.length === 0 && (
                <div className="rounded-2xl border border-app-line bg-white px-4 py-5 text-center text-[12.5px] text-app-faint">
                  Nothing due this week.
                </div>
              )}
            </div>
          </>
        )}

        {screen === "timetable" && (
          <div className="pt-4">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {["Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => (
                <button key={d} onClick={() => setDay(d)} className="shrink-0 rounded-full px-3.5 py-2 text-[12.5px]"
                  style={day === d ? { background: tint, color: "#fff", fontWeight: 600 } : { background: "#F1EDEC", color: "#6B605F" }}>
                  {d}
                </button>
              ))}
            </div>
            <div className="mt-3.5 grid gap-2">
              {(timetable?.[day as Weekday] ?? []).map(([time, subject, room], i) => {
                const isNow = day === "Tue" && i === NOW;
                return (
                  <div key={time} className="flex items-center gap-3 rounded-2xl border px-4 py-3"
                    style={{ borderColor: isNow ? tint : "#EAE6E5", background: isNow ? "#FFF8F6" : "#fff" }}>
                    <span className="w-11 shrink-0 font-mono text-[11.5px] text-app-muted">{time}</span>
                    <span className="h-8 w-[3px] shrink-0 rounded" style={{ background: isNow ? tint : "#E0DAD9" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium">{subject}</span>
                      <span className="text-[12px] text-app-faint">{room}</span>
                    </span>
                    {isNow && <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold text-white" style={{ background: tint }}>NOW</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {screen === "work" && (
          <div className="pt-4">
            <div className="flex gap-1.5">
              {(["To do", "Done"] as const).map((t) => (
                <button key={t} onClick={() => setWorkTab(t)} className="rounded-full px-3.5 py-2 text-[12.5px]"
                  style={workTab === t ? { background: tint, color: "#fff", fontWeight: 600 } : { background: "#F1EDEC", color: "#6B605F" }}>
                  {t}
                </button>
              ))}
            </div>
            <div className="mt-3.5 grid gap-2.5">
              {(workTab === "Done" ? work.filter((w) => w.state === "done") : open).map((w) => (
                <button key={w.id} onClick={() => { setTaskId(w.id); setScreen("task"); }}
                  className="rounded-2xl border bg-white p-4 text-left"
                  style={{ borderColor: w.state === "late" ? "#F6DCC7" : "#EAE6E5" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[14.5px] font-semibold leading-snug">{w.title}</div>
                      <div className="mt-1 text-[12.5px] text-app-faint">{w.subject} · {w.teacher}</div>
                    </div>
                    <span className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold"
                      style={
                        w.state === "done" ? { background: "#E3EFE7", color: "#1B4D2E" }
                        : w.state === "late" ? { background: "#FDEBDF", color: "#B8460A" }
                        : daysUntil(w.dueOn) <= 0 ? { background: "#FDF1E8", color: "#8A3D08" }
                        : { background: "#F1EDEC", color: "#6B605F" }
                      }>
                      {w.state === "done" ? "Done" : w.state === "late" ? "Overdue" : formatDueLabel(w.dueOn, false)}
                    </span>
                  </div>
                  <p className="mt-2.5 text-[12.5px] leading-relaxed text-app-muted">{w.body.split("\n")[0]}</p>
                </button>
              ))}
              {(workTab === "Done" ? work.filter((w) => w.state === "done") : open).length === 0 && (
                <div className="py-14 text-center">
                  <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-ok-bg text-lg text-ok-ink">✓</div>
                  <div className="text-[15px] font-semibold">Nothing here</div>
                  <p className="mx-auto mt-1.5 max-w-[260px] text-[13px] leading-relaxed text-app-muted">
                    Handed in work moves to Done. Anything new your teachers set appears the moment they set it.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {screen === "task" && task && (
          <div className="pt-4">
            <button onClick={() => setScreen("work")} className="text-[13px] font-semibold" style={{ color: tint }}>‹ Work</button>
            <h2 className="mt-3 text-[20px] font-semibold leading-snug tracking-tight">{task.title}</h2>
            <div className="mt-1.5 text-[12.5px] text-app-faint">{task.subject} · set by {task.teacher}</div>

            <div className="mt-4 flex gap-4 rounded-2xl border border-app-line bg-white p-4">
              <div className="flex-1">
                <div className="font-mono text-[9.5px] tracking-[0.1em] text-app-faint">DUE</div>
                <div className="mt-1 text-[14px] font-semibold" style={{ color: task.state === "late" ? "#B8460A" : undefined }}>
                  {task.state === "done" ? "Handed in" : formatDueLabel(task.dueOn, task.state === "late")}
                </div>
              </div>
              <div className="flex-1">
                <div className="font-mono text-[9.5px] tracking-[0.1em] text-app-faint">HAND IN</div>
                <div className="mt-1 text-[14px] font-semibold">{task.how}</div>
              </div>
            </div>

            <p className="mt-4 whitespace-pre-line text-[14.5px] leading-relaxed">{task.body}</p>

            {task.state === "done" ? (
              <div className="mt-5 flex items-center gap-3 rounded-2xl bg-ok-bg px-4 py-3.5">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ok-ink text-[12px] text-white">✓</span>
                <span className="text-[13px] leading-relaxed text-ok-ink">Handed in. {task.teacher} has been told.</span>
              </div>
            ) : (
              <>
                <button onClick={() => setDone((d) => ({ ...d, [task.id]: true }))}
                  className="hit mt-5 w-full rounded-xl py-3.5 text-[15px] font-semibold text-white" style={{ background: tint }}>
                  Mark as handed in
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    void handleFileSelected(task, e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button onClick={() => fileInputRef.current?.click()} disabled={uploading[task.id]}
                  className="hit mt-2.5 w-full rounded-xl border py-3 text-[14px] font-semibold disabled:opacity-50"
                  style={{ borderColor: "#EAE6E5", color: tint }}>
                  {uploading[task.id]
                    ? "Uploading…"
                    : attached[task.id]
                      ? `Attached · ${attached[task.id]}`
                      : "Attach a file"}
                </button>
                {uploadError[task.id] && (
                  <p className="mt-2 text-center text-[12px] leading-relaxed text-orange-ink">{uploadError[task.id]}</p>
                )}
                <p className="mt-2.5 text-center text-[12px] leading-relaxed text-app-faint">
                  This tells {task.teacher} you have finished it. Attaching a file uploads it and marks it done too.
                </p>
              </>
            )}
          </div>
        )}

        {screen === "results" && (
          <div className="pt-4">
            {meanMark === null ? (
              <div className="py-14 text-center">
                <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-app-line-soft text-lg text-app-faint">▦</div>
                <div className="text-[15px] font-semibold">Not published yet</div>
                <p className="mx-auto mt-1.5 max-w-[260px] text-[13px] leading-relaxed text-app-muted">
                  Your results will appear here as soon as the school publishes them.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-2xl p-4 text-white" style={{ background: tint }}>
                  <div className="font-mono text-[9.5px] tracking-[0.12em] text-white/70">MEAN GRADE{data.examName ? ` · ${data.examName.toUpperCase()}` : ""}</div>
                  <div className="mt-1.5 flex items-baseline gap-3">
                    <span className="text-[38px] font-bold tracking-tight">{gradeFor(meanMark)}</span>
                    <span className="font-mono text-[14px] text-white/80">{meanMark} marks · {points} points</span>
                  </div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-white/85">
                    {data.subjects.length > 0 && (() => {
                      const sorted = [...data.subjects].sort((a, b) => b.score - a.score);
                      const strongest = sorted[0]!.name;
                      const weakest = sorted[sorted.length - 1]!.name;
                      return `${strongest} is carrying the mean; ${weakest} is the one pulling it down.`;
                    })()}
                  </p>
                </div>

                <div className="mt-4 grid gap-2">
                  {data.subjects.map((s) => (
                    <div key={s.name} className="flex items-center gap-3 rounded-2xl border border-app-line bg-white px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium">{s.name}</div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-app-line-soft">
                          <div className="h-1.5 rounded" style={{ width: `${s.score}%`, background: s.score >= 80 ? "#1B4D2E" : s.score >= 65 ? "#2E7D4F" : "#F9A05C" }} />
                        </div>
                        <div className="mt-1.5 text-[11.5px] text-app-faint">
                          {s.classMean !== null ? againstMean(s.score, s.classMean) : "Class mean not available"}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-[18px]">{s.score}</div>
                        <div className="text-[12px] font-bold" style={{ color: s.score >= 75 ? "#1B4D2E" : s.score >= 65 ? "#2E7D4F" : "#8A3D08" }}>{gradeFor(s.score)}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <p className="mt-4 text-[12px] leading-relaxed text-app-faint">
                  Class position is not shown here. Ask your class teacher if you want it — they will give it with the
                  context that goes around it.
                </p>
              </>
            )}
          </div>
        )}

        {screen === "notices" && (
          <div className="grid gap-2 pt-4">
            {notices.map((n) => {
              const isUnread = n.unread && !read[n.id];
              return (
                <button key={n.id} onClick={() => { setNoticeId(n.id); setRead((r) => ({ ...r, [n.id]: true })); setScreen("notice"); }}
                  className="flex gap-3 rounded-2xl border border-app-line bg-white p-3.5 text-left">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[14px]"
                    style={{ background: isUnread ? tint : "#F1EDEC", color: isUnread ? "#fff" : "#6B605F" }}>◈</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13.5px]" style={{ fontWeight: isUnread ? 700 : 500 }}>{n.subject}</span>
                      <span className="shrink-0 text-[11px] text-app-faint">{n.when}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-app-muted">{n.body.split("\n")[0]}</p>
                  </div>
                </button>
              );
            })}
            {notices.length === 0 && (
              <div className="rounded-2xl border border-app-line bg-white px-4 py-8 text-center text-[12.5px] text-app-faint">
                Nothing here yet.
              </div>
            )}
          </div>
        )}

        {screen === "notice" && notice && (
          <div className="pt-4">
            <button onClick={() => setScreen("notices")} className="text-[13px] font-semibold" style={{ color: tint }}>‹ Notices</button>
            <h2 className="mt-3 text-[19px] font-semibold leading-snug tracking-tight">{notice.subject}</h2>
            <div className="mt-1.5 text-[12.5px] text-app-faint">{notice.from} · {notice.when}</div>
            <p className="mt-4 whitespace-pre-line text-[14.5px] leading-relaxed">{notice.body}</p>
          </div>
        )}
      </div>

      <TabBar
        items={[
          { label: "Today", icon: "◈", active: screen === "today", onPress: () => setScreen("today") },
          { label: "Timetable", icon: "▤", active: screen === "timetable", onPress: () => setScreen("timetable") },
          { label: "Work", icon: "✎", active: screen === "work" || screen === "task", onPress: () => setScreen("work") },
          { label: "Results", icon: "▦", active: screen === "results", onPress: () => setScreen("results") },
          { label: "Notices", icon: "◉", active: screen === "notices" || screen === "notice", onPress: () => setScreen("notices") },
        ]}
      />
    </PhoneFrame>
  );
}
