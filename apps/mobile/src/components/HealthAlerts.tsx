import { Text, View } from "react-native";
import type { StudentHealth } from "@figbloom/shared";
import { fontSize } from "../theme";
import { useTheme } from "../ui/ThemeContext";

/**
 * Allergies and chronic conditions, loud: the first thing to see on a learner, before giving them anything. When
 * there are none on file it says so quietly, so "nothing shown" never reads as "no allergies".
 */
export function HealthAlerts({ health }: { health: StudentHealth | null }) {
  const { t, s } = useTheme();
  const allergies = health?.allergies ?? [];
  const conditions = health?.medical_conditions ?? [];
  const takes = health?.medications?.trim();
  const diet = health?.dietary_needs?.trim();
  const needs = health?.special_needs?.trim();

  if (!allergies.length && !conditions.length && !takes && !diet && !needs) {
    return (
      <View style={s.card}>
        <Text style={s.small}>No allergies or conditions on file. Ask the learner, and tell the office if the record is missing something.</Text>
      </View>
    );
  }
  return (
    <View
      accessibilityRole="alert"
      style={{ borderWidth: 2, borderRadius: t.radius.lg, padding: 14, gap: 6, borderColor: t.status.warnInk, backgroundColor: t.status.warnBg }}
    >
      {allergies.length > 0 && <Text style={{ fontSize: fontSize.lead, fontWeight: "800", color: t.status.warnInk }}>Allergies: {allergies.join(", ")}</Text>}
      {conditions.length > 0 && <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: t.status.warnInk }}>Conditions: {conditions.join(", ")}</Text>}
      {!!takes && <Text style={{ fontSize: fontSize.small, color: t.status.warnInk }}>Takes: {takes}</Text>}
      {!!diet && <Text style={{ fontSize: fontSize.small, color: t.status.warnInk }}>Diet: {diet}</Text>}
      {!!needs && <Text style={{ fontSize: fontSize.small, color: t.status.warnInk }}>Needs: {needs}</Text>}
    </View>
  );
}
