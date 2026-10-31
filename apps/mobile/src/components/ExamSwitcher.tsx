import { ScrollView, Text } from "react-native";
import type { PublishedExam } from "@figbloom/shared";
import { HIT } from "../theme";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

/**
 * Moves between the exams a learner has results for. Teachers publish a class
 * and subject at a time, so the newest exam can be only partly out: each pill
 * says how many subjects, and the earlier complete exam is one tap away.
 * Nothing to switch between with fewer than two.
 */
export function ExamSwitcher({ exams, value, onPick, tint }: {
  exams: PublishedExam[];
  value: string | null;
  onPick: (examId: string) => void;
  tint: string;
}) {
  const { t } = useTheme();
  if (exams.length < 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
      {exams.map((e) => {
        const on = e.id === value;
        return (
          <Tap
            key={e.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(e.id)}
            style={{ ...HIT, borderRadius: 999, paddingHorizontal: 14, justifyContent: "center", backgroundColor: on ? tint : t.appSurface.lineSoft }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>
              {e.name} · {e.subjectCount} subject{e.subjectCount === 1 ? "" : "s"}
            </Text>
          </Tap>
        );
      })}
    </ScrollView>
  );
}
