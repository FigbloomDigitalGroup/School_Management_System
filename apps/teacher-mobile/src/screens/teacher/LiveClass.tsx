import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Switch, Text, TouchableOpacity, View } from "react-native";
import { fetchTeacherClasses, liveClassTitle, supabase, type ClassGroup } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useCalls } from "../../calls/CallProvider";
import { useRunningLiveClasses } from "../../calls/useRunningLiveClasses";
import type { TeacherSession } from "../../navigation";

interface Assignment { class_id: string; subject_id: string; subjects: { name: string } | null }

/**
 * A teacher's "Go live", as on the website's dashboard: pick the class (and
 * subject), choose whether learners may speak from the start, and open the room.
 * A class already running live shows Rejoin instead, for a dropped connection.
 * Learners and their parents see "Live now" on their home screen and join there.
 */
export function TeacherLiveClass({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const { goLive, joinClass, busy } = useCalls();
  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  /** "" is the whole class. */
  const [subjectId, setSubjectId] = useState("");
  const [learnersMayPublish, setLearnersMayPublish] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [cls, { data, error: err }] = await Promise.all([
        fetchTeacherClasses(session.profileId),
        supabase().from("teaching_assignments").select("class_id, subject_id, subjects(name)").eq("teacher_id", session.profileId).returns<Assignment[]>(),
      ]);
      if (err) throw new Error(err.message);
      if (!alive) return;
      const sorted = [...cls].sort((x, y) => x.name.localeCompare(y.name));
      setClasses(sorted);
      setAssignments(data ?? []);
      setClassId((cur) => cur ?? sorted[0]?.id ?? null);
    })().catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load your classes."); });
    return () => { alive = false; };
  }, [session.profileId]);

  const classIds = useMemo(() => (classes ?? []).map((c) => c.id), [classes]);
  const running = useRunningLiveClasses(session.tenantId, classIds);
  const cls = classes?.find((c) => c.id === classId) ?? null;
  const subjects = assignments.filter((x) => x.class_id === classId);
  const subject = subjects.find((x) => x.subject_id === subjectId);
  const runningHere = running.find((r) => r.class_id === classId);

  async function start() {
    if (!cls) return;
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
    <View style={s.screen}>
      <ScreenHeader title="Live class" sub="Teach a class from your phone" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {error ? (
          <View style={s.card}><Text style={[s.small, { color: t.status.warnInk }]}>{error}</Text></View>
        ) : !classes ? (
          <ActivityIndicator color={a.deep} style={{ marginTop: 32 }} />
        ) : classes.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={[s.h2, { marginBottom: 4 }]}>No class of yours</Text>
            <Text style={[s.small, { textAlign: "center" }]}>You can go live for a class you teach. The school office assigns your classes.</Text>
          </View>
        ) : (
          <>
            <View>
              <Text style={[s.eyebrow, { marginBottom: 6 }]}>CLASS</Text>
              <PillPicker items={classes.map((c) => ({ id: c.id, name: c.name }))} selectedId={classId} onPick={(id) => { setClassId(id); setSubjectId(""); }} accent={session.accent} />
            </View>
            <View>
              <Text style={[s.eyebrow, { marginBottom: 6 }]}>SUBJECT</Text>
              <PillPicker items={[{ id: "", name: "Whole class" }, ...subjects.map((x) => ({ id: x.subject_id, name: x.subjects?.name ?? "Subject" }))]} selectedId={subjectId} onPick={setSubjectId} accent={session.accent} />
            </View>
            <View style={[s.card, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <Text style={{ flex: 1, fontSize: 14, color: t.appSurface.ink }}>Learners may speak and use their cameras</Text>
              <Switch value={learnersMayPublish} onValueChange={setLearnersMayPublish} accessibilityLabel="Learners may speak and use their cameras" trackColor={{ true: a.deep }} />
            </View>

            {runningHere ? (
              <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => void joinClass(runningHere.id)} style={[s.primary, { backgroundColor: a.deep, opacity: busy ? 0.6 : 1 }]}>
                <Text style={s.primaryLabel}>Rejoin {runningHere.title}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity accessibilityRole="button" disabled={busy || starting || !cls} onPress={() => void start()} style={[s.primary, { backgroundColor: a.deep, opacity: busy || starting || !cls ? 0.6 : 1 }]}>
                <Text style={s.primaryLabel}>{starting ? "Starting…" : "Go live"}</Text>
              </TouchableOpacity>
            )}

            <Text style={s.faint}>
              Learners and their parents see "Live now" on their Figbloom home and join from there. Live video uses a lot of mobile data: use Wi-Fi if you can.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
