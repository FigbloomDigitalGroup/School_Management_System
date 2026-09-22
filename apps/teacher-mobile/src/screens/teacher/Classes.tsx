import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { fetchMyClasses, type MyClassRow } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";

/** "My classes" — every class this teacher is assigned to, whether as class
 *  teacher or a subject teacher. Browsing only; Attendance and Gradebook
 *  have their own class pickers for actually doing something with one. */
export function TeacherClasses({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [rows, setRows] = useState<MyClassRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyClasses(session.profileId)
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [session.profileId]);

  if (!rows) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="My classes" sub={`${rows.length} class${rows.length === 1 ? "" : "es"} you teach or lead`} color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {rows.length === 0 ? (
          <View style={s.card}>
            <Text style={s.small}>No classes assigned yet. Ask the school office to assign you as a class teacher or to a subject.</Text>
          </View>
        ) : (
          rows.map((c) => {
            const isClassTeacher = c.class_teacher_id === session.profileId;
            return (
              <View key={c.id} style={[s.card, { marginBottom: 8, padding: 14 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: "600" }}>{c.name}</Text>
                    {!!c.stream && <Text style={s.faint}>{c.stream}</Text>}
                  </View>
                  <View style={[s.pill, { backgroundColor: isClassTeacher ? t.status.okBg : t.appSurface.lineSoft }]}>
                    <Text style={[s.pillLabel, { color: isClassTeacher ? t.status.okInk : t.appSurface.inkMuted }]}>
                      {isClassTeacher ? "Class teacher" : "Subject teacher"}
                    </Text>
                  </View>
                </View>
                <Text style={[s.small, { marginTop: 8 }]}>
                  {c.subjects.length ? c.subjects.join(", ") : "No subjects assigned"}
                </Text>
                <Text style={[s.faint, { marginTop: 4 }]}>{c.learnerCount} learner{c.learnerCount === 1 ? "" : "s"}</Text>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
