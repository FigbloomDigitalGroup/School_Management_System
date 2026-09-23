import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import {
  fetchTeacherClasses, fetchTeacherClassTimetable,
  type ClassGroup, type TeacherTimetableRow, type Weekday,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";

const DAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_LABEL: Record<Weekday, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
const TODAY: Weekday = DAYS[(new Date().getDay() + 6) % 7] ?? "Mon";

/**
 * A teacher's weekly schedule for one class at a time — their own periods
 * only, unless they're that class's class teacher, in which case the whole
 * week shows (with whose subject each period is, since a class teacher
 * isn't the one teaching every period on their own homeroom's timetable).
 */
export function TeacherTimetable({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [byDay, setByDay] = useState<Record<Weekday, TeacherTimetableRow[]> | null>(null);
  const [isClassTeacher, setIsClassTeacher] = useState(false);
  const [day, setDay] = useState<Weekday>(TODAY);

  useEffect(() => {
    let alive = true;
    fetchTeacherClasses(session.profileId)
      .then((cls) => { if (alive) { setClasses(cls); if (cls.length) setClassId((id) => id ?? cls[0]!.id); } })
      .catch(() => { if (alive) setClasses([]); });
    return () => { alive = false; };
  }, [session.profileId]);

  useEffect(() => {
    if (!classId) return;
    let alive = true;
    setByDay(null);
    fetchTeacherClassTimetable(classId, session.profileId)
      .then((r) => { if (alive) { setByDay(r.byDay); setIsClassTeacher(r.isClassTeacher); } })
      .catch(() => { if (alive) { setByDay({ Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] }); setIsClassTeacher(false); } });
    return () => { alive = false; };
  }, [classId, session.profileId]);

  if (!classes) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  if (classes.length === 0) {
    return (
      <View style={s.screen}>
        <ScreenHeader title="Timetable" color={a.deep} back />
        <View style={{ padding: 16 }}>
          <View style={s.card}><Text style={s.small}>No classes assigned yet. Contact the school office.</Text></View>
        </View>
      </View>
    );
  }

  const rows = byDay?.[day] ?? [];

  return (
    <View style={s.screen}>
      <ScreenHeader
        title="Timetable"
        sub={isClassTeacher ? "Whole week — you're the class teacher" : "Your periods only"}
        color={a.deep}
        back
      />

      {classes.length > 1 && (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
        </View>
      )}

      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingTop: 14 }}>
        {DAYS.map((d) => {
          const on = d === day;
          return (
            <TouchableOpacity
              key={d}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setDay(d)}
              style={{
                ...HIT, flex: 1, borderRadius: 10, alignItems: "center", justifyContent: "center",
                backgroundColor: on ? a.deep : t.appSurface.lineSoft,
              }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>{d}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {!byDay ? (
          <ActivityIndicator color={a.deep} />
        ) : rows.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>No periods set for {DAY_LABEL[day]} yet.</Text>
          </View>
        ) : (
          rows.map((row, i) => (
            <View key={`${row.time}-${i}`} style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <Text style={[s.mono, { width: 44, color: t.appSurface.inkMuted }]}>{row.time.slice(0, 5)}</Text>
              <View style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: row.mine ? t.brand.orange : t.appSurface.line }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "500" }}>{row.label}</Text>
                {!!row.room && <Text style={s.faint}>{row.room}</Text>}
              </View>
              {!row.mine && !!row.teacherName && (
                <Text style={[s.faint, { maxWidth: 100, textAlign: "right" }]} numberOfLines={1}>{row.teacherName}</Text>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
