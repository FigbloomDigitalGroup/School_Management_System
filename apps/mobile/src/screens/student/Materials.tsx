import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { fetchClassMaterials, groupBySubject, type MaterialRow } from "@figbloom/shared";
import { accentFor, s } from "../../theme";
import { useStudentData } from "../../studentData";
import { MediaRow } from "../../components/MediaLinks";
import { BackLink } from "../../ui/BackLink";

/**
 * A class's published learning materials, by subject. Read-only: a tap
 * opens the file or link in the phone's own viewer (the browser, YouTube,
 * a PDF reader). Teachers add materials on the web. Used by the student
 * screen below and the parent's (parent/Materials.tsx).
 */
export function MaterialsScreen({ classId, tint, title, sub, emptyText, headerRight }: {
  classId: string | null;
  tint: string;
  title: string;
  sub: string;
  emptyText: string;
  headerRight?: ReactNode;
}) {
  const nav = useNavigation<any>();
  const [items, setItems] = useState<MaterialRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setFailed(false);
    if (!classId) { setItems([]); return; }
    fetchClassMaterials(classId)
      .then((rows) => { if (alive) setItems(rows); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [classId]);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <BackLink onPress={() => nav.goBack()} />
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>{title}</Text>
            <Text style={s.headerSub}>{sub}</Text>
          </View>
          {headerRight}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {items === null ? (
          failed ? (
            <View style={s.card}><Text style={s.small}>Could not load learning materials. Check your connection and try again.</Text></View>
          ) : (
            <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
          )
        ) : items.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={[s.small, { textAlign: "center" }]}>{emptyText}</Text>
          </View>
        ) : (
          groupBySubject(items).map(({ subject, items: list }) => (
            <View key={subject} style={{ marginBottom: 12 }}>
              <Text style={[s.eyebrow, { marginBottom: 8 }]}>{subject.toUpperCase()} · {list.length}</Text>
              {list.map((m) => (
                <View key={m.id} style={[s.card, { marginBottom: 8, paddingVertical: 8 }]}>
                  <MediaRow item={m} tint={tint} />
                  {!!m.description && <Text style={[s.small, { marginTop: 2, marginBottom: 4 }]}>{m.description}</Text>}
                </View>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

export function StudentMaterials() {
  const { data, accent } = useStudentData();
  return (
    <MaterialsScreen
      classId={data.classId}
      tint={accentFor(accent).deep}
      title="Learning materials"
      sub="Notes, worksheets and videos from your teachers"
      emptyText="When your teachers share notes, worksheets or videos with your class, they'll be here."
    />
  );
}
