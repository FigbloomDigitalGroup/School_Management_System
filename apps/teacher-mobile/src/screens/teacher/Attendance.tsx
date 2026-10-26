import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import {
  fetchClassRoster, fetchCurrentTerm, fetchTeacherClasses, fetchTodayAttendanceMarks, isRetryable, writeAttendance,
  fetchHealthForStudents, healthFlags, type HealthFlags,
  MARK_LABEL, MARK_SHORT, MARK_STYLE, newRegister, nextMark, submitWarning, tally, toRecords,
  type AttendanceMark, type ClassGroup, type Register, type Student,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { queue } from "../../storage";
import { PillPicker } from "../../components/PillPicker";
import { QueueNotice } from "../../components/QueueNotice";
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
  /** The classes/term fetch itself failed — not the same as "no classes" or "no term". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [roster, setRoster] = useState<Student[] | null>(null);
  const [reg, setReg] = useState<Register | null>(null);
  const [submitted, setSubmitted] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Allergies and conditions by learner, shown as a chip while marking. A failed read just shows none. */
  const [health, setHealth] = useState<Map<string, HealthFlags>>(new Map());

  useEffect(() => {
    if (!roster?.length) { setHealth(new Map()); return; }
    let alive = true;
    fetchHealthForStudents(roster.map((r) => r.id))
      .then((records) => {
        if (!alive) return;
        const m = new Map<string, HealthFlags>();
        for (const [id, h] of records) { const f = healthFlags(h); if (f) m.set(id, f); }
        setHealth(m);
      })
      .catch(() => { if (alive) setHealth(new Map()); });
    return () => { alive = false; };
  }, [roster]);
  /** The server refused the register (not a connection problem): shown instead of pretending it was saved. */
  const [saveError, setSaveError] = useState<string | null>(null);
  // Registers saved on this phone that haven't gone out yet. Re-read on a timer so it
  // drops to zero by itself once they have, rather than staying at what it was at submit.
  const [held, setHeld] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => { void queue.pending().then((p) => { if (alive) setHeld(p.length); }).catch(() => {}); };
    void queue.flush().then(load).catch(() => {});
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
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
      .catch(() => { if (alive) { setLoadFailed(true); setClasses([]); } });
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
    setSaveError(null);
    setBusy(true);
    try {
      await writeAttendance(reg, session.tenantId, session.profileId);
      setSubmitted(true);
    } catch (err) {
      if (!isRetryable(err)) {
        // The server looked at it and said no. Holding it would only park it in the queue
        // for good, so keep the roster open and say why.
        setSaveError(`The register was not saved: ${err instanceof Error ? err.message : "something went wrong"}.`);
        return;
      }
      // No signal, or the server isn't answering: hold it on this phone.
      try {
        await queue.enqueue("attendance", toRecords(reg, session.tenantId, session.profileId));
        setHeld((await queue.pending()).length);
        setSubmitted(true);
      } catch {
        setSaveError("The register could not be saved on this phone either. Check your storage and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const cls = classes?.find((c) => c.id === classId);

  // Checked before the spinner: with no class or no open term the register
  // never loads, so the spinner would otherwise turn forever.
  if (classes && loadFailed) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Attendance</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>Could not load your classes — check your connection and open this tab again.</Text></View>
        </View>
      </View>
    );
  }

  if (classes && classes.length === 0) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Attendance</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>You aren't assigned to any classes yet.</Text></View>
        </View>
      </View>
    );
  }

  if (classes && !termId) {
    return (
      <View style={s.screen}>
        <View style={[s.header, { backgroundColor: a.deep }]}>
          <Text style={s.headerTitle}>Attendance</Text>
        </View>
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>No term is open yet. Ask the school admin to set up this term.</Text></View>
        </View>
      </View>
    );
  }

  if (!classes || !cls || submitted === null) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
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
          <QueueNotice />
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
        <QueueNotice />
        {(roster ?? []).map((student) => {
          const mark = reg?.marks[student.id] ?? "present";
          return (
            <View key={student.id} style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 }]}>
              <TouchableOpacity accessibilityRole="button" onPress={() => cycle(student.id)} style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "500" }}>{student.full_name}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={s.faint}>ADM {student.admission_no}</Text>
                  <HealthChip flags={health.get(student.id)} name={student.full_name} />
                </View>
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
        {!!saveError && <Text style={[s.small, { marginBottom: 10, color: t.status.warnInk }]} accessibilityRole="alert">{saveError}</Text>}
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

/** Red "Allergy" (amber "Medical") on a learner's row; tap for the details. */
function HealthChip({ flags, name }: { flags: HealthFlags | undefined; name: string }) {
  if (!flags) return null;
  const allergy = flags.allergy;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${name}: ${flags.summary}`}
      onPress={() => Alert.alert(name, flags.summary.replace(/ · /g, "\n"))}
      hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
      style={{ borderRadius: 999, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1,
        backgroundColor: allergy ? "#FBE9E6" : "#FDF3E1", borderColor: allergy ? "#F1C7BF" : "#F0DDB8" }}
    >
      <Text style={{ fontSize: 10, fontWeight: "700", letterSpacing: 0.4, color: allergy ? "#9B2C1C" : "#8A5A0B" }}>
        {allergy ? "ALLERGY" : flags.medical ? "MEDICAL" : "DIET"}
      </Text>
    </TouchableOpacity>
  );
}
