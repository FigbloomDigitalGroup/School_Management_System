import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  addNeed, createHomework, defaultGuide, deleteHomework, EMPTY_GUIDE, fetchClassSizes, fetchMyHomework, fetchTeacherClasses,
  fetchTeacherSubjectsForClass, formatShortDate, GUIDE_PLACEHOLDERS, guideToneFor, HAND_IN_OPTIONS, handedInLabel, isGuideEmpty,
  minutesWords, NEED_CHIPS, notifyHomeworkParents, removeNeed, retoneGuide, updateHomework, validateHomework,
  type ClassGroup, type HandIn, type HomeworkRow, type ParentGuide, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import { MediaLinks, useAttachments } from "../../components/MediaLinks";
import type { TeacherSession } from "../../navigation";

/** Today as YYYY-MM-DD in the teacher's own timezone (toISOString alone is UTC, a day behind after midnight in Nairobi). */
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/**
 * Homework for a class and subject the teacher teaches. Learners in the class
 * see it on their Work tab and mark it handed in; the list shows how many have.
 * Dates are plain YYYY-MM-DD text fields, like Leave: no native date picker yet.
 * "For parents" is the same guide as on web, folded away until the teacher
 * opens it; new work can be announced to the class's parents as it's set.
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
  const [guide, setGuide] = useState<ParentGuide>({ ...EMPTY_GUIDE, needs: [] });
  const [guideOpen, setGuideOpen] = useState(false);
  const [customNeed, setCustomNeed] = useState("");
  const [tellParents, setTellParents] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [work, setWork] = useState<{ rows: HomeworkRow[]; sizes: Record<string, number> } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const files = useAttachments("homework", (work?.rows ?? []).map((w) => w.id));

  useEffect(() => {
    let alive = true;
    fetchTeacherClasses(session.profileId)
      .then((c) => {
        if (!alive) return;
        setClasses(c);
        setClassId((id) => id ?? c[0]?.id ?? null);
        // The guide starts toned for the first class's age, as on web.
        setGuide((g) => (isGuideEmpty(g) ? defaultGuide(c[0]?.level, c[0]?.form_level ?? 0) : g));
      })
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

  const cls = classes?.find((c) => c.id === classId);
  const tone = guideToneFor(cls?.level, cls?.form_level ?? 0);

  function pickClass(id: string) {
    const next = classes?.find((c) => c.id === id);
    // Only help/avoid/time still holding the old class's wording change; anything typed stays.
    setGuide((g) => retoneGuide(g, tone, guideToneFor(next?.level, next?.form_level ?? 0)));
    setClassId(id);
  }

  function reset() {
    setEditingId(null);
    setTitle("");
    setBody("");
    setDueOn("");
    setHandIn("paper");
    setGuide(defaultGuide(cls?.level, cls?.form_level ?? 0));
    setGuideOpen(false);
    setCustomNeed("");
    setTellParents(true);
  }

  function startEdit(w: HomeworkRow) {
    setEditingId(w.id);
    setClassId(w.classId);
    setSubjectId(w.subjectId);
    setTitle(w.title);
    setBody(w.body);
    setDueOn(w.dueOn);
    setHandIn(w.handIn);
    setGuide(w.guide ? { ...w.guide, needs: [...w.guide.needs] } : { ...EMPTY_GUIDE, needs: [] });
    setGuideOpen(!isGuideEmpty(w.guide));
    setStatus(null);
  }

  async function save() {
    const checked = validateHomework(
      { classId: classId ?? "", subjectId: subjectId ?? "", title, body, dueOn, handIn, guide },
      localToday(),
      { allowPast: !!editingId },
    );
    if (!checked.ok) { setStatus(checked.message); return; }
    setSaving(true);
    setStatus(null);
    try {
      let message = "Homework updated.";
      if (editingId) await updateHomework(editingId, checked.value);
      else {
        await createHomework(session.tenantId, session.profileId, checked.value);
        message = "Homework set. Learners in the class can see it now.";
        if (tellParents) {
          // Saved either way; a note that didn't send is said, not treated as a failed save.
          const subjectName = subjects?.find((x) => x.id === subjectId)?.name ?? "";
          message = await notifyHomeworkParents(session.tenantId, session.profileId, checked.value, subjectName, cls?.name ?? "")
            .then(() => "Homework set. Learners can see it and parents have been told.", () => "Homework set, but the note to parents didn't send.");
        }
      }
      setStatus(message);
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
              <PillPicker items={classes} selectedId={classId} onPick={pickClass} accent={session.accent} />
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
              <Text style={[s.faint, { marginTop: 6 }]}>To attach a worksheet, video or link, edit this homework on the web.</Text>
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
              accessibilityState={{ expanded: guideOpen }}
              onPress={() => setGuideOpen((o) => !o)}
              style={{ ...HIT, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
            >
              <Text style={[s.small, { fontWeight: "600" }]}>For parents{isGuideEmpty(guide) ? "" : " ✓"}</Text>
              <Text style={{ fontSize: 13, fontWeight: "600", color: t.brand.orange }}>{guideOpen ? "Hide" : "Show"}</Text>
            </TouchableOpacity>
            {guideOpen && (
              <View style={{ gap: 10 }}>
                <Text style={s.faint}>
                  {tone === "sit_with"
                    ? "Parents of young learners usually sit with them, so say how to help without doing it for them."
                    : "Older learners work on their own. A line on what it's about and how long it takes is plenty."}
                  {" "}Anything left blank just won't show.
                </Text>
                <GuideInput label="What it's about" value={guide.about} placeholder={GUIDE_PLACEHOLDERS[tone].about} onChange={(about) => setGuide((g) => ({ ...g, about }))} />

                <Text style={[s.small, { fontWeight: "600" }]}>Your child will need</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[...NEED_CHIPS, ...guide.needs.filter((n) => !NEED_CHIPS.some((c) => c.toLowerCase() === n.toLowerCase()))].map((n) => {
                    const on = guide.needs.some((x) => x.toLowerCase() === n.toLowerCase());
                    return (
                      <TouchableOpacity
                        key={n}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        onPress={() => setGuide((g) => ({ ...g, needs: on ? removeNeed(g.needs, n) : addNeed(g.needs, n) }))}
                        style={{ borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: on ? a.deep : t.appSurface.lineSoft }}
                      >
                        <Text style={{ fontSize: 12.5, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>{on ? "✓ " : ""}{n}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    value={customNeed}
                    onChangeText={setCustomNeed}
                    placeholder="Something else"
                    onSubmitEditing={() => { setGuide((g) => ({ ...g, needs: addNeed(g.needs, customNeed) })); setCustomNeed(""); }}
                    style={{ ...HIT, flex: 1, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 }}
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={!customNeed.trim()}
                    onPress={() => { setGuide((g) => ({ ...g, needs: addNeed(g.needs, customNeed) })); setCustomNeed(""); }}
                    style={{ ...HIT, justifyContent: "center", paddingHorizontal: 8, opacity: customNeed.trim() ? 1 : 0.4 }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "600", color: t.brand.orange }}>Add</Text>
                  </TouchableOpacity>
                </View>

                <GuideInput label="How you can help" value={guide.help} placeholder={GUIDE_PLACEHOLDERS[tone].help} onChange={(help) => setGuide((g) => ({ ...g, help }))} />
                <GuideInput label="Please avoid" value={guide.avoid} placeholder={GUIDE_PLACEHOLDERS[tone].avoid} onChange={(avoid) => setGuide((g) => ({ ...g, avoid }))} />

                <View>
                  <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Time it should take (minutes)</Text>
                  <TextInput
                    value={guide.minutes === null ? "" : String(guide.minutes)}
                    onChangeText={(v) => setGuide((g) => ({ ...g, minutes: v.trim() === "" ? null : Number(v.replace(/[^0-9]/g, "")) || null }))}
                    keyboardType="number-pad"
                    placeholder="Optional"
                    style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 }}
                  />
                  {!!minutesWords(guide.minutes) && <Text style={[s.faint, { marginTop: 4 }]}>{minutesWords(guide.minutes)}</Text>}
                </View>
              </View>
            )}

            {!editingId && (
              <TouchableOpacity
                accessibilityRole="checkbox"
                accessibilityState={{ checked: tellParents }}
                onPress={() => setTellParents((v) => !v)}
                style={{ ...HIT, flexDirection: "row", alignItems: "center", gap: 10 }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: a.deep, backgroundColor: tellParents ? a.deep : "transparent", alignItems: "center", justifyContent: "center" }}>
                  {tellParents && <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>✓</Text>}
                </View>
                <Text style={[s.small, { flex: 1 }]}>Tell parents: send the class's parents a message with the due date and this guide.</Text>
              </TouchableOpacity>
            )}

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
                {isGuideEmpty(w.guide) ? "" : " · parent guide"}
              </Text>
              <Text style={[s.small, { marginTop: 4 }]}>{handedInLabel(w.handedIn, work.sizes[w.classId])} handed in</Text>
              <MediaLinks items={files.get(w.id) ?? []} tint={a.deep} />
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

/** One multi-line field of the "For parents" section. */
function GuideInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <View>
      <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        multiline
        style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, padding: 12, fontSize: 14, minHeight: 60, textAlignVertical: "top" }}
      />
    </View>
  );
}
