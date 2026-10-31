import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { BackLink } from "../ui/BackLink";
import { useTheme } from "../ui/ThemeContext";

/** A screen opened from a home card: tinted header with a way back, then the content in a scroll. */
export function SubScreen({ tint, title, sub, headerRight, children }: {
  tint: string;
  title: string;
  sub: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const { s } = useTheme();
  const nav = useNavigation<any>();
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
      <ScrollView contentContainerStyle={{ padding: 16 }}>{children}</ScrollView>
    </View>
  );
}
