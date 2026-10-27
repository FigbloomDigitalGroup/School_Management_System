import type { ReactNode } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { s } from "../theme";

/** A screen opened from a home card: tinted header with a way back, then the content in a scroll. */
export function SubScreen({ tint, title, sub, headerRight, children }: {
  tint: string;
  title: string;
  sub: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const nav = useNavigation<any>();
  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <TouchableOpacity accessibilityRole="button" onPress={() => nav.goBack()} style={{ paddingVertical: 6, marginBottom: 4 }}>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 13.5, fontWeight: "600" }}>‹ Back</Text>
        </TouchableOpacity>
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
