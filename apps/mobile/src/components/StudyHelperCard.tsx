import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { fetchAiHelperStatus } from "@figbloom/shared";
import { Tap } from "../ui/Tap";
import { OpenLabel } from "../ui/OpenLabel";
import { useTheme } from "../ui/ThemeContext";

/**
 * The way into the study helper from a learner's Today screen. Shown only where
 * the school has turned the helper on (as the website's menu does); whether this
 * learner may use it yet, and why not, is the screen's to say. Nothing at all
 * when the school hasn't, or when that can't be checked.
 */
export function StudyHelperCard({ tint }: { tint: string }) {
  const { s } = useTheme();
  const nav = useNavigation<any>();
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAiHelperStatus(null)
      .then((r) => { if (alive) setOn(!!r?.schoolOn); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!on) return null;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel="Ask Bloom, your study helper"
      onPress={() => nav.navigate("StudyHelper")}
      style={[s.card, { marginTop: 10, padding: 14 }]}
    >
      <Text style={s.eyebrow}>ASK BLOOM</Text>
      <Text style={[s.small, { marginTop: 4 }]}>An AI tutor for your schoolwork. It explains, and asks you questions back.</Text>
      <View style={{ marginTop: 6, alignSelf: "flex-start" }}>
        <OpenLabel tint={tint} />
      </View>
    </Tap>
  );
}
