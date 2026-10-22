import { Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { HIT, s } from "../theme";

/** The colored header band every screen uses, with an optional back chevron
 *  for screens pushed onto the "More" stack rather than sitting on a tab. */
export function ScreenHeader({ title, sub, color, back }: { title: string; sub?: string; color: string; back?: boolean }) {
  const navigation = useNavigation();
  return (
    <View style={[s.header, { backgroundColor: color, flexDirection: "row", alignItems: "center", gap: 10 }]}>
      {back && (
        <TouchableOpacity accessibilityRole="button" onPress={() => navigation.goBack()} style={HIT}>
          <Text style={{ color: "#fff", fontSize: 20 }}>‹</Text>
        </TouchableOpacity>
      )}
      <View>
        <Text style={s.headerTitle}>{title}</Text>
        {!!sub && <Text style={s.headerSub}>{sub}</Text>}
      </View>
    </View>
  );
}
