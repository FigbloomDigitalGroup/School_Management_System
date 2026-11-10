import { Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { BackLink } from "../ui/BackLink";
import { useTheme } from "../ui/ThemeContext";

/** The colored header band every screen uses, with an optional way back for
 *  screens pushed onto the "More" stack rather than sitting on a tab. */
export function ScreenHeader({ title, sub, color, back }: { title: string; sub?: string; color: string; back?: boolean }) {
  const { s } = useTheme();
  const navigation = useNavigation();
  return (
    <View style={[s.header, { backgroundColor: color }]}>
      {back && <BackLink onPress={() => navigation.goBack()} />}
      <Text style={s.headerTitle}>{title}</Text>
      {!!sub && <Text style={s.headerSub}>{sub}</Text>}
    </View>
  );
}
