import { View } from "react-native";
import { HrLeave } from "../../components/HrLeave";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor } from "../../theme";
import { useTheme } from "../../ui/ThemeContext";

/**
 * The staff member's own leave, applied for through Figbloom HR: the same screen a teacher has, for other staff at
 * a school whose leave runs there (they have a Leave page on the web console, and had nothing like it here). It is
 * listed under More only when HR says the school's leave is HR's (see adminScreens.ts).
 */
export function MyLeave({ session }: { session: StaffSession }) {
  const { s } = useTheme();
  const a = accentFor(session.accent);
  return (
    <View style={s.screen}>
      <ScreenHeader title="My leave" sub="Through Figbloom HR" color={a.deep} back />
      <HrLeave accent={session.accent} />
    </View>
  );
}
