import { useEffect, useMemo, useState } from "react";
import {
  fetchRunningLiveClasses, fetchTeacherClasses, liveClassTitle, subscribeLiveClasses, supabase, type LiveClass,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { SelectField } from "../ui/Field";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { useCalls } from "./CallHost";

/** Live classes running now in these classes (all of the school's when omitted), kept current over Realtime. */
function useRunningLiveClasses(classIds?: string[]): LiveClass[] {
  const { tenant } = useTenantSession();
  const [running, setRunning] = useState<LiveClass[]>([]);
  const key = classIds?.join(",") ?? "*";
  useEffect(() => {
    let alive = true;
    const ids = key === "*" ? undefined : key ? key.split(",") : [];
    const load = () => { fetchRunningLiveClasses(ids).then((r) => { if (alive) setRunning(r); }).catch(() => {}); };
    load();
    const unsubscribe = subscribeLiveClasses(tenant.id, load);
    return () => { alive = false; unsubscribe(); };
  }, [key, tenant.id]);
  return running;
}

/**
 * "Live now" for a learner or a parent: one card per live class running in
 * their (children's) classes, with Join. Renders nothing when none is.
 */
export function LiveClassBanner({ classIds }: { classIds: string[] }) {
  const running = useRunningLiveClasses(classIds);
  const { joinClass, busy } = useCalls();
  if (running.length === 0) return null;
  return (
    <div className="mb-4 grid gap-2">
      {running.map((lc) => (
        <div key={lc.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-forest/30 bg-forest/5 px-4 py-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-ink px-2 py-0.5 text-[11px] font-bold tracking-wide text-white">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white" />LIVE
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{lc.title}</div>
            <div className="text-[12px] text-ink-muted">Live class in Figbloom. No other app needed.</div>
          </div>
          <Button variant="primary" disabled={busy} onClick={() => void joinClass(lc.id)}>Join</Button>
        </div>
      ))}
    </div>
  );
}

/**
 * A teacher's "Go live": pick the class (and subject), choose whether
 * learners may speak from the start, and open the room. A class they're
 * already teaching live shows Rejoin instead, e.g. after a dropped connection.
 */
export function LiveClassPanel() {
  const { profile } = useTenantSession();
  const { goLive, joinClass, busy } = useCalls();
  const { data: classes } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const { data: assignments } = useAsync(async () => {
    const { data, error } = await supabase()
      .from("teaching_assignments").select("class_id, subject_id, subjects(name)").eq("teacher_id", profile.id)
      .returns<{ class_id: string; subject_id: string; subjects: { name: string } | null }[]>();
    if (error) throw new Error(error.message);
    return data ?? [];
  }, [profile.id]);

  const classIds = useMemo(() => (classes ?? []).map((c) => c.id), [classes]);
  const running = useRunningLiveClasses(classIds);

  const [classId, setClassId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [learnersMayPublish, setLearnersMayPublish] = useState(false);
  const [starting, setStarting] = useState(false);

  const effectiveClassId = classId || classes?.[0]?.id || "";
  const subjects = (assignments ?? []).filter((a) => a.class_id === effectiveClassId);
  const runningHere = running.find((r) => r.class_id === effectiveClassId);

  if (classes && classes.length === 0) return null;

  async function start() {
    const cls = classes?.find((c) => c.id === effectiveClassId);
    if (!cls) return;
    const subject = subjects.find((s) => s.subject_id === subjectId);
    setStarting(true);
    try {
      await goLive({
        classId: cls.id, subjectId: subject?.subject_id ?? null,
        title: liveClassTitle(cls.name, subject?.subjects?.name), learnersMayPublish,
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="mb-5 rounded-lg border border-line bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-body font-semibold">Live class</h2>
        <span className="text-[12px] text-ink-faint">Learners and their parents see “Live now” and join from their Figbloom home.</span>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-[200px]">
          <SelectField id="live-class-class" label="Class" value={effectiveClassId} onChange={(e) => { setClassId(e.target.value); setSubjectId(""); }}
            options={(classes ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        </div>
        <div className="w-[200px]">
          <SelectField id="live-class-subject" label="Subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}
            options={[{ value: "", label: "Whole class" }, ...subjects.map((s) => ({ value: s.subject_id, label: s.subjects?.name ?? "Subject" }))]} />
        </div>
        <label className="flex items-center gap-2 pb-2 text-[12.5px]">
          <input type="checkbox" checked={learnersMayPublish} onChange={(e) => setLearnersMayPublish(e.target.checked)} />
          Learners may speak and use cameras
        </label>
        {runningHere ? (
          <Button variant="primary" disabled={busy} onClick={() => void joinClass(runningHere.id)}>Rejoin {runningHere.title}</Button>
        ) : (
          <Button variant="primary" disabled={busy || starting || !effectiveClassId} onClick={() => void start()}>
            {starting ? "Starting…" : "Go live"}
          </Button>
        )}
      </div>
    </section>
  );
}
