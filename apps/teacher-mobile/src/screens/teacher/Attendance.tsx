import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import {
  fetchClassRoster, fetchCurrentTerm, fetchTeacherClasses, fetchTodayAttendanceMarks, writeAttendance,
  MARK_LABEL, MARK_SHORT, MARK_STYLE, newRegister, nextMark, submitWarning, tally, toRecords,
  type AttendanceMark, type ClassGroup, type Register, type Student,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { queue } from "../../storage";
import { PillPicker } from "../../components/PillPicker";
import type { TeacherSession } from "../../navigation";

const todayLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

/**
 * The 60-second screen, mobile version — same shape as the web console's:
 * everyone starts present, tap only the exceptions, submit once. A failed
 * online write falls back to the offline queue rather than losing the
 * register (attendance taken at 08:00 in a dead spot must not be lost) —
 * the first real caller of packages/shared's WriteQueue on mobile.
 */
export function TeacherAttendance({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [roster, setRoster] = useState<Student[] | null>(null);
  const [reg, setReg] = useState<Register | null>(null);
  const [submitted, setSubmitted] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(0);

  useEffect(() => {
    void queue.flush().then((r) => setHeld(r.remaining));
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchTeacherClasses(session.profileId), fetchCurrentTerm()])
      .then(([cls, term]) => {
        if (!alive) return;
        setClasses(cls);
        setTermId(term?.id ?? null);
        if (cls.length) setClassId((id) => id ?? cls[0]!.id);
      })
      .catch(() => { if (alive) setClasses([]); });
    return () => { alive = false; };
  }, [session.profileId]);

  useEffect(() => {
    if (!classId || !termId) return;
    let alive = true;
    setSubmitted(null);
    setReg(null);
    Promise.all([fetchClassRoster(classId), fetchTodayAttendanceMarks(classId)])
      .then(([r, marks]) => {
        if (!alive) return;
        setRoster(r);
        const base = newRegister(classId, termId, r.map((s) => s.id));
        for (const m of marks) if (m.student_id in base.marks) base.marks[m.student_id] = m.mark;
        setReg(base);
        setSubmitted(marks.length > 0);
      })
      .catch(() => { if (alive) { setRoster([]); setSubmitted(false); } });
    return () => { alive = false; };
  }, [classId, termId]);

  const counts = useMemo(
    () => (reg ? tally(reg) : { present: 0, absent: 0, late: 0, excused: 0, total: 0 }),
    [reg],
  );

  function cycle(studentId: string) {
    setReg((r) => (r ? { ...r, marks: { ...r.marks, [studentId]: nextMark(r.marks[studentId] ?? "present") } } : r));
  }

  function setMark(studentId: string, mark: AttendanceMark) {
    setReg((r) => (r ? { ...r, marks: { ...r.marks, [studentId]: mark } } : r));
  }

  async function submit() {
    if (!reg) return;
    const warning = submitWarning(reg);
    if (warning && !confirming) { setConfirming(warning); return; }
    setConfirming(null);
    setBusy(true);
    try {
      await writeAttendance(reg, session.tenantId, session.profileId);
      setSubmitted(true);
    } catch {
      await queue.enqueue("attendance", toRecords(reg, session.tenantId, session.profileId));
      const pending = await queue.pending();
      setHeld(pending.length);
      setSubmitted(true);
    } finally {
      setBusy(false);
    }
  }

  const cls = classes?.find((c) => c.id === classId);

  if (!classes || !cls || submitted === null) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  if (classes.length === 0) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Attendance</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>No classes assigned yet. Contact the school office.</Text></View>
        </View>
      </View>
    );
  }

  if (submitted) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>{cls.name} register is in</Text>
          <Text style={s.headerSub}>
            {counts.present} present · {counts.absent} absent · {counts.late} late
            {held > 0 ? ` · ${held} saved on this phone, sending when you have signal` : ""}
          </Text>
        </View>
        <View style={{ padding: 16 }}>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setSubmitted(false)}
            style={[s.primary, { ...HIT, backgroundColor: t.brand.orange }]}
          >
            <Text style={s.primaryLabel}>Correct a mark</Text>
          </TouchableOpacity>

          {classes.length > 1 && (
            <View style={{ marginTop: 20 }}>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 8 }]}>Switch class</Text>
              <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.eyebrow}>ATTENDANCE · {todayLabel.toUpperCase()}</Text>
        <Text style={s.headerTitle}>{cls.name}</Text>
        <Text style={s.headerSub}>{roster?.length ?? 0} learners</Text>
      </View>

      {classes.length > 1 && (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
        </View>
      )}

      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
        {(["present", "absent", "late"] as AttendanceMark[]).map((k) => (
          <View key={k} style={[s.pill, { backgroundColor: MARK_STYLE[k].bg }]}>
            <Text style={[s.pillLabel, { color: MARK_STYLE[k].ink }]}>{counts[k]} {MARK_LABEL[k].toLowerCase()}</Text>
          </View>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8 }}>
        {(roster ?? []).map((student) => {
          const mark = reg?.marks[student.id] ?? "present";
          return (
            <View key={student.id} style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 }]}>
              <TouchableOpacity accessibilityRole="button" onPress={() => cycle(student.id)} style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "500" }}>{student.full_name}</Text>
                <Text style={s.faint}>ADM {student.admission_no}</Text>
              </TouchableOpacity>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {(["present", "absent", "late"] as AttendanceMark[]).map((k) => {
                  const on = mark === k;
                  return (
                    <TouchableOpacity
                      key={k}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => setMark(student.id, k)}
                      style={{
                        ...HIT, borderRadius: 10, alignItems: "center", justifyContent: "center",
                        backgroundColor: on ? MARK_STYLE[k].bg : t.appSurface.lineSoft,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: "700", color: on ? MARK_STYLE[k].ink : t.appSurface.inkMuted }}>
                        {MARK_SHORT[k]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>

      <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: t.appSurface.card }}>
        {confirming ? (
          <>
            <Text style={[s.small, { marginBottom: 10 }]}>{confirming}</Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TouchableOpacity accessibilityRole="button" onPress={() => setConfirming(null)} style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.appSurface.lineSoft }]}>
                <Text style={[s.primaryLabel, { color: t.appSurface.ink }]}>Go back</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" onPress={submit} style={[s.primary, { ...HIT, flex: 1, backgroundColor: t.brand.orange }]}>
                <Text style={s.primaryLabel}>Yes, submit</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy}
            onPress={submit}
            style={[s.primary, { ...HIT, backgroundColor: t.brand.orange, opacity: busy ? 0.6 : 1 }]}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Submit register</Text>}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
