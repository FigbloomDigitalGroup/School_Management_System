import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { CircleAlert, FileText } from "lucide-react-native";
import {
  MATERIAL_KIND_LABEL, PHONE_UPLOAD_LIMIT_BYTES, createFileMaterial, createMaterial, fetchTeacherClasses, fetchTeacherSubjectsForClass, fileProblem,
  formatFileSize, kindForLink, kindForMime, mediaSummary, mimeForFile, setMaterialPublished, updateMaterial, validateLink, validateMaterial,
  type ClassGroup, type MaterialRow, type Subject,
} from "@figbloom/shared";
import { accentFor, HIT } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ANY_FILE, pickFile, readPickedFile, type PickedFile } from "../../lib/pickFile";
import type { TeacherSession } from "../../navigation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

type Source = "file" | "link";

/**
 * Adding a material (a file from the phone, or a link) or changing one's class,
 * subject, title and description. A new one is saved as a draft or published
 * straight away; the file is uploaded in one go, so the screen says so and
 * asks before it is left mid-way. If the upload fails nothing is left behind.
 * To use a different file or link, add a new material and delete the old one.
 */
export function TeacherMaterialEditor({ session, route }: { session: TeacherSession; route: { params?: { material?: MaterialRow } } }) {
  const { t, s, fieldLine, accentInk } = useTheme();
  const nav = useNavigation<any>();
  const a = accentFor(session.accent);
  const material = route.params?.material;

  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(material?.classId ?? null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(material?.subjectId ?? null);
  const [source, setSource] = useState<Source>("file");
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [link, setLink] = useState("");
  const [title, setTitle] = useState(material?.title ?? "");
  const [description, setDescription] = useState(material?.description ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"draft" | "publish" | null>(null);
  const saving = pending !== null;
  const savingRef = useRef(false);
  savingRef.current = saving;

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

  // Leaving while a file is going up may lose it, so ask first; but never trap, since a stalled upload has to be abandonable.
  useEffect(() => nav.addListener("beforeRemove", (e: { preventDefault: () => void; data: { action: unknown } }) => {
    if (!savingRef.current) return;
    e.preventDefault();
    Alert.alert("Still saving", "This hasn't finished. If you leave now, it may not be saved.", [
      { text: "Keep waiting", style: "cancel" },
      { text: "Leave anyway", style: "destructive", onPress: () => nav.dispatch(e.data.action) },
    ]);
  }), [nav]);

  async function choose() {
    setError("");
    try {
      const f = await pickFile("document", ANY_FILE);
      if (!f) return;
      // The phone sometimes doesn't know the size; it is measured again once the file is read.
      const problem = fileProblem({ name: f.name, size: f.sizeBytes ?? 1, type: f.mimeType }, PHONE_UPLOAD_LIMIT_BYTES);
      if (problem) { setError(problem); return; }
      setPicked(f);
      // A file named "Photosynthesis notes.pdf" is usually titled just that.
      if (!title.trim()) setTitle(f.name.replace(/\.[a-z0-9]+$/i, ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open your files.");
    }
  }

  async function save(publish: boolean) {
    const checked = validateMaterial({ classId: classId ?? "", subjectId: subjectId ?? "", title, description });
    if (!checked.ok) { setError(checked.message); return; }
    setError("");

    let linkUrl = "";
    if (!material && source === "link") {
      const url = validateLink(link);
      if (!url.ok) { setError(url.message); return; }
      linkUrl = url.value;
    }
    if (!material && source === "file" && !picked) { setError("Choose the file to upload."); return; }

    setPending(publish ? "publish" : "draft");
    try {
      if (material) {
        await updateMaterial(material.id, checked.value);
        if (publish && !material.publishedAt) await setMaterialPublished(material.id, true);
      } else if (source === "link") {
        const id = await createMaterial(session.tenantId, checked.value, { kind: kindForLink(linkUrl), url: linkUrl });
        if (publish) await setMaterialPublished(id, true);
      } else {
        await createFileMaterial(session.tenantId, checked.value, await readPickedFile(picked!), publish);
      }
      savingRef.current = false;
      nav.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Check your connection and try again.");
      setPending(null);
    }
  }

  const noSubjects = subjects !== null && subjects.length === 0;
  const published = !!material?.publishedAt;
  const pickedKind = picked ? MATERIAL_KIND_LABEL[kindForMime(mimeForFile({ name: picked.name, type: picked.mimeType }) ?? "")] : null;

  return (
    <View style={s.screen}>
      <ScreenHeader title={material ? "Edit material" : "Add material"} sub="Learning materials" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { gap: 14 }]}>
          {classes === null ? (
            <ActivityIndicator color={accentInk(a.deep)} />
          ) : classes.length === 0 ? (
            <Text style={s.small}>You aren't assigned to any classes yet. Ask the school admin to add you to a class.</Text>
          ) : (
            <>
              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Class</Text>
                <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
              </View>
              <View>
                <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Subject</Text>
                {subjects === null ? <ActivityIndicator color={accentInk(a.deep)} /> : noSubjects ? (
                  <Text style={s.faint}>You aren't assigned a subject in this class. Ask the school admin.</Text>
                ) : (
                  <PillPicker items={subjects} selectedId={subjectId} onPick={setSubjectId} accent={session.accent} />
                )}
              </View>

              {material ? (
                <View style={[s.row, { gap: 10, padding: 12, borderRadius: t.radius.lg, backgroundColor: t.appSurface.page }]}>
                  <FileText size={20} color={accentInk(a.deep)} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "600" }}>{material.fileName ?? material.url}</Text>
                    <Text style={s.faint}>{mediaSummary(material)}. To use a different file or link, add a new material and delete this one.</Text>
                  </View>
                </View>
              ) : (
                <>
                  <View style={{ gap: 8 }} accessibilityRole="radiogroup">
                    {([
                      ["file", "Upload a file", `Notes, a worksheet, slides, a picture, a recording, or a video up to ${formatFileSize(PHONE_UPLOAD_LIMIT_BYTES)}.`],
                      ["link", "Paste a link", "A YouTube, Vimeo or Google Drive video, or any web page. It opens in the phone's own app for it."],
                    ] as const).map(([key, label, hint]) => {
                      const on = source === key;
                      return (
                        <Tap
                          key={key}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on, disabled: saving }}
                          disabled={saving}
                          onPress={() => { setSource(key); setError(""); }}
                          style={{ ...HIT, borderRadius: t.radius.lg, padding: 12, borderWidth: on ? 2 : 1, borderColor: on ? accentInk(a.deep) : fieldLine, backgroundColor: on ? `${a.deep}14` : t.appSurface.card }}
                        >
                          <Text style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>{label}</Text>
                          <Text style={[s.faint, { marginTop: 2 }]}>{hint}</Text>
                        </Tap>
                      );
                    })}
                  </View>

                  {source === "file" ? (
                    <View style={{ gap: 8 }}>
                      <Button variant="secondary" label={picked ? "Choose a different file" : "Choose a file"} disabled={saving} onPress={() => void choose()} />
                      {picked && (
                        <Text style={s.small}>
                          {picked.name}{pickedKind ? ` · ${pickedKind}` : ""}{picked.sizeBytes ? ` · ${formatFileSize(picked.sizeBytes)}` : ""}
                        </Text>
                      )}
                    </View>
                  ) : (
                    <Field
                      label="Link"
                      value={link}
                      onChangeText={(v) => { setLink(v); setError(""); }}
                      placeholder="e.g. https://www.youtube.com/watch?v=…"
                      keyboardType="url"
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!saving}
                    />
                  )}
                </>
              )}

              <Field label="Title" value={title} onChangeText={(v) => { setTitle(v); setError(""); }} placeholder="e.g. Photosynthesis: notes and diagrams" editable={!saving} />
              <Field
                label="Description (optional)"
                value={description}
                onChangeText={setDescription}
                placeholder="e.g. Read pages 1 to 4 before Thursday's practical."
                multiline
                editable={!saving}
              />

              {!!error && (
                <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                  <CircleAlert size={14} color={t.status.warnInk} style={{ marginTop: 2 }} />
                  <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: t.status.warnInk }}>{error}</Text>
                </View>
              )}
              {saving && !material && source === "file" && (
                <Text accessibilityLiveRegion="polite" style={s.small}>Uploading {picked?.name}. Keep the app open until it finishes.</Text>
              )}

              <View style={{ gap: 8 }}>
                {!published && (
                  <Button label="Save and publish" tint={a.deep} loading={pending === "publish"} disabled={saving || noSubjects} onPress={() => void save(true)} />
                )}
                <Button
                  variant={published ? "primary" : "secondary"}
                  tint={published ? a.deep : undefined}
                  label={published ? "Save changes" : "Save draft"}
                  loading={pending === "draft"}
                  disabled={saving || noSubjects}
                  onPress={() => void save(false)}
                />
                <Button variant="quiet" tint={t.appSurface.inkMuted} label="Cancel" disabled={saving} onPress={() => nav.goBack()} />
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
