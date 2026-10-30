import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  MATERIAL_KIND_LABEL, deleteMaterial, fetchMaterials, fetchMyTeachingPairs, fetchTeacherClasses, formatShortDate, localIsoDate, setMaterialPublished,
  type MaterialRow,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { MediaRow } from "../../components/MediaLinks";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";
import { Button } from "../../ui/Button";
import { EmptyState, ErrorState } from "../../ui/StateView";

type State =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; materials: MaterialRow[]; hasClasses: boolean };

/**
 * What this teacher has shared with the classes they teach: notes,
 * worksheets, pictures, recordings, videos and links. A material is a draft,
 * seen only by staff, until it is published; then the class's learners and
 * their parents find it under Learning materials. Adding and changing one is
 * its own screen. Read again whenever this comes back into view.
 */
export function TeacherMaterials({ session }: { session: TeacherSession }) {
  const nav = useNavigation<any>();
  const a = accentFor(session.accent);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const read = useCallback(() => {
    let alive = true;
    Promise.all([fetchMaterials(session.tenantId), fetchMyTeachingPairs(session.profileId), fetchTeacherClasses(session.profileId)])
      .then(([all, pairs, classes]) => {
        if (alive) setState({ kind: "ready", materials: all.filter((m) => pairs.has(`${m.classId}:${m.subjectId}`)), hasClasses: classes.length > 0 });
      })
      // A failed re-read must not blank what is already on screen.
      .catch(() => { if (alive) setState((cur) => (cur.kind === "ready" ? cur : { kind: "failed" })); });
    return () => { alive = false; };
  }, [session.tenantId, session.profileId]);
  // A message about an earlier action is stale once the screen is left and come back to.
  useFocusEffect(useCallback(() => { setStatus(null); return read(); }, [read]));

  async function run(m: MaterialRow, work: () => Promise<void>, done: string) {
    setBusyId(m.id);
    setStatus(null);
    try {
      await work();
      setStatus(done);
      read();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "That didn't work. Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  function togglePublish(m: MaterialRow) {
    const go = () => void run(m, () => setMaterialPublished(m.id, !m.publishedAt), m.publishedAt ? "Unpublished. Only staff can see it now." : `Published. ${m.className} can see it now.`);
    if (!m.publishedAt) { go(); return; }
    Alert.alert("Unpublish this?", `"${m.title}": ${m.className} won't see it any more.`, [
      { text: "Keep it published", style: "cancel" },
      { text: "Unpublish", onPress: go },
    ]);
  }

  function remove(m: MaterialRow) {
    Alert.alert("Delete this?", `"${m.title}" for ${m.className}.${m.filePath ? " The file is deleted too." : ""}`, [
      { text: "Keep it", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void run(m, () => deleteMaterial(m), "Deleted.") },
    ]);
  }

  const ready = state.kind === "ready" ? state : null;

  return (
    <View style={s.screen}>
      <ScreenHeader title="Learning materials" sub="Share with a class you teach" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {state.kind === "loading" ? (
          <ActivityIndicator color={a.deep} style={{ marginTop: 24 }} />
        ) : state.kind === "failed" ? (
          <ErrorState title="Couldn't load your materials" onRetry={() => { setState({ kind: "loading" }); read(); }} />
        ) : !ready!.hasClasses ? (
          <EmptyState title="No classes yet" body="You aren't assigned to any classes yet. Ask the school admin to add you to a class." />
        ) : (
          <>
            <Button label="Add material" tint={a.deep} onPress={() => nav.navigate("MaterialEditor")} />
            {!!status && <Text accessibilityLiveRegion="polite" style={s.small}>{status}</Text>}

            {ready!.materials.length === 0 ? (
              <EmptyState
                title="Nothing shared yet"
                body="Upload notes, a worksheet or a lesson video, or paste a YouTube link. It stays a draft until you publish it."
              />
            ) : (
              ready!.materials.map((m) => {
                const published = !!m.publishedAt;
                const busy = busyId === m.id;
                return (
                  <View key={m.id} style={[s.card, { gap: 4 }]}>
                    <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start", gap: 8 }]}>
                      <Text style={[s.eyebrow, { flex: 1 }]}>{MATERIAL_KIND_LABEL[m.kind].toUpperCase()} · {m.className} · {m.subjectName}</Text>
                      <View style={[s.pill, { backgroundColor: published ? t.status.okBg : t.status.mutedBg }]}>
                        <Text style={[s.pillLabel, { color: published ? t.status.okInk : t.status.mutedInk }]}>{published ? "Published" : "Draft"}</Text>
                      </View>
                    </View>
                    <MediaRow item={m} tint={a.deep} />
                    {!!m.description && <Text numberOfLines={2} style={s.small}>{m.description}</Text>}
                    <Text style={s.faint}>Added {formatShortDate(localIsoDate(new Date(m.createdAt)))}</Text>
                    <View style={[s.row, { flexWrap: "wrap", gap: 4, marginTop: 4 }]}>
                      <Button variant="quiet" tint={a.deep} label="Edit" disabled={busy} onPress={() => nav.navigate("MaterialEditor", { material: m })} style={{ paddingHorizontal: 10 }} />
                      <Button variant="quiet" tint={a.deep} label={published ? "Unpublish" : "Publish"} loading={busy} onPress={() => togglePublish(m)} style={{ paddingHorizontal: 10 }} />
                      <Button variant="quiet" tint={t.status.warnInk} label="Delete" disabled={busy} onPress={() => remove(m)} style={{ paddingHorizontal: 10 }} />
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
