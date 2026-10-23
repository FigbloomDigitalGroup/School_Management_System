import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  createHomework, deleteHomework, fetchClassSizes, fetchMyHomework, fetchTeacherClasses, fetchTeacherSubjectsForClass,
  formatShortDate, HAND_IN_OPTIONS, handedInLabel, updateHomework, validateHomework,
  type ClassGroup, type HandIn, type HomeworkRow, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";

/** Today as YYYY-MM-DD in the teacher's own timezone (toISOString alone is UTC, a day behind after midnight in Nairobi). */
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/**
 * Homework for a class and subject the teacher teaches. Learners in the class
 * see it on their Work tab and mark it handed in; the list shows how many have.
 * Dates are plain YYYY-MM-DD text fields, like Leave: no native date picker yet.
 */
export function TeacherHomework({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [handIn, setHandIn] = useState<HandIn>("paper");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [work, setWork] = useState<{ rows: HomeworkRow[]; sizes: Record<string, number> } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTeacherClasses(session.profileId)
      .then((c) => { if (alive) { setClasses(c); setClassId((id) => id ?? c[0]?.id ?? null); } })
      .catch(() => { if (alive) setClasses([]); });
    return () => { alive = false; };
  }, [session.profileId]);

  // Subjects are per class: only the ones this teacher is assigned in it.
  useEffect(() => {
    if (!classId) { setSubjects([]); return; }
    let alive = true;
    setSubjects(null);
    fetchTeacherSubjectsForClass(session.profileId, classId)
      .then((list) => {
        if (!alive) return;
        setSubjects(list);
        setSubjectId((cur) => (list.some((x) => x.id === cur) ? cur : list[0]?.id ?? null));
      })
      .catch(() => { if (alive) setSubjects([]); });
    return () => { alive = false; };
  }, [classId, session.profileId]);

  useEffect(() => {
    let alive = true;
    fetchMyHomework(session.profileId)
      .then(async (rows) => {
        const sizes = await fetchClassSizes([...new Set(rows.map((r) => r.classId))]).catch(() => ({} as Record<string, number>));
        if (alive) setWork({ rows, sizes });
      })
      .catch(() => { if (alive) setWork({ rows: [], sizes: {} }); });
    return () => { alive = false; };
  }, [session.profileId, reloadKey]);

  function reset() {
    setEditingId(null);
    setTitle("");
    setBody("");
    setDueOn("");
    setHandIn("paper");
  }

  function startEdit(w: HomeworkRow) {
    setEditingId(w.id);
    setClassId(w.classId);
    setSubjectId(w.subjectId);
    setTitle(w.title);
    setBody(w.body);
    setDueOn(w.dueOn);
    setHandIn(w.handIn);
    setStatus(null);
  }

  async function save() {
    const checked = validateHomework(
      { classId: classId ?? "", subjectId: subjectId ?? "", title, body, dueOn, handIn },
      localToday(),
      { allowPast: !!editingId },
    );
    if (!checked.ok) { setStatus(checked.message); return; }
    setSaving(true);
    setStatus(null);
    try {
      if (editingId) await updateHomework(editingId, checked.value);
      else await createHomework(session.tenantId, session.profileId, checked.value);
      setStatus(editingId ? "Homework updated." : "Homework set. Learners in the class can see it now.");
      reset();
      setReloadKey((k) => k + 1);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  function remove(w: HomeworkRow) {
    const extra = w.handedIn > 0 ? ` ${w.handedIn} learner${w.handedIn === 1 ? " has" : "s have"} marked it handed in; that goes with it.` : "";
    Alert.alert("Delete this homework?", `"${w.title}" for ${w.className}.${extra}`, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteHomework(w.id)
            .then(() => { if (editingId === w.id) reset(); setReloadKey((k) => k + 1); })
            .catch((err) => setStatus(err instanceof Error ? err.message : "Could not delete. Check your connection and try again."));
        },
      },
    ]);
  }

  const noSubjects = subjects !== null && subjects.length === 0;
  const today = localToday();

  return (
    <View style={s.screen}>
      <ScreenHeader title="Homework" sub="Set work for your classes" color={a.deep} back />

      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        {classes !== null && classes.length === 0 ? (
          <View style={s.card}><Text style={s.small}>You aren't assigned to any classes yet. Ask the school admin to add you to a class.</Text></View>
        ) : (
          <View style={[s.card, { gap: 10 }]}>
            <Text style={s.eyebrow}>{editingId ? "EDIT HOMEWORK" : "NEW HOMEWORK"}</Text>

            <Text style={[s.small, { fontWeight: "600" }]}>Class</Text>
            {classes === null ? <ActivityIndicator color={a.deep} /> : (
              <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
            )}

            <Text style={[s.small, { fontWeight: "600" }]}>Subject</Text>
            {subjects === null ? <ActivityIndicator color={a.deep} /> : noSubjects ? (
              <Text style={s.faint}>You aren't assigned a subject in this class. Ask the school admin.</Text>
            ) : (
              <PillPicker items={subjects} selectedId={subjectId} onPick={setSubjectId} accent={session.accent} />
            )}

            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Title</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Exercise 4.2, page 61"
                style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 }}
              />
            </View>

            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Instructions (optional)</Text>
              <TextInput
                value={body}
                onChangeText={setBody}
                placeholder="Anything learners need to know"
                multiline
                numberOfLines={3}
                style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, padding: 12, fontSize: 14, minHeight: 72, textAlignVertical: "top" }}
              />
            </View>

            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Due date</Text>
              <TextInput
                value={dueOn}
                onChangeText={setDueOn}
                placeholder="YYYY-MM-DD"
                style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14, fontFamily: "monospace" }}
              />
            </View>

            <Text style={[s.small, { fontWeight: "600" }]}>How to hand in</Text>
            <PillPicker
              items={HAND_IN_OPTIONS.map((o) => ({ id: o.value, name: o.label }))}
              selectedId={handIn}
              onPick={(id) => setHandIn(id as HandIn)}
              accent={session.accent}
            />

            <TouchableOpacity
              accessibilityRole="button"
              disabled={saving || noSubjects}
              onPress={() => void save()}
              style={[s.primary, { ...HIT, backgroundColor: t.brand.orange, opacity: saving || noSubjects ? 0.6 : 1 }]}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>{editingId ? "Save changes" : "Set homework"}</Text>}
            </TouchableOpacity>
            {!!editingId && (
              <TouchableOpacity accessibilityRole="button" onPress={() => { reset(); setStatus(null); }} style={{ ...HIT, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.appSurface.inkMuted }}>Cancel editing</Text>
              </TouchableOpacity>
            )}
            {!!status && <Text style={s.small}>{status}</Text>}
          </View>
        )}

        <Text style={[s.eyebrow, { marginTop: 20, marginBottom: 8 }]}>HOMEWORK YOU'VE SET</Text>
        {work === null ? (
          <ActivityIndicator color={a.deep} />
        ) : work.rows.length === 0 ? (
          <Text style={s.faint}>Nothing set yet.</Text>
        ) : (
          work.rows.map((w) => (
            <View key={w.id} style={[s.card, { marginBottom: 8, padding: 12 }]}>
              <Text style={{ fontSize: 14, fontWeight: "600" }}>{w.title}</Text>
              <Text style={[s.faint, { marginTop: 2 }]}>
                {w.className} · {w.subjectName} · due {formatShortDate(w.dueOn)}{w.dueOn < today ? " (past due)" : w.dueOn === today ? " (today)" : ""}
              </Text>
              <Text style={[s.small, { marginTop: 4 }]}>{handedInLabel(w.handedIn, work.sizes[w.classId])} handed in</Text>
              <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
                <TouchableOpacity accessibilityRole="button" onPress={() => startEdit(w)} style={{ ...HIT, justifyContent: "center" }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: t.brand.orange }}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" onPress={() => remove(w)} style={{ ...HIT, justifyContent: "center" }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: t.status.warnInk }}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
