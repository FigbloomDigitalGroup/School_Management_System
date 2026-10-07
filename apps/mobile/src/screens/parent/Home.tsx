import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatMoney, gradeFor, gradingSchemeFor } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useChildren, useMessages } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";

/**
 * The screen a parent opens. Balance first, because that is what they came for;
 * an unexplained absence second, because that is what they would want to know.
 */
export function ParentHome() {
  const nav = useNavigation<any>();
  const { child, index, setIndex, accent, country } = useChild();
  const kids = useChildren();
  const messages = useMessages();
  const a = accentFor(accent);
  /** First child takes the deep shade, second the accent itself. */
  const tint = index === 0 ? a.deep : a.hex;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>{child.first}</Text>
            <Text style={s.headerSub}>{child.cls} · ADM {child.adm}</Text>
          </View>
          <ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
        <View style={[s.card, { marginTop: -10 }]}>
          <Text style={s.eyebrow}>FEE BALANCE · TERM 3</Text>
          <Text style={{ fontSize: 30, fontWeight: "700", marginTop: 6, color: child.balance > 0 ? tint : t.status.okInk }}>
            {child.balance > 0 ? formatMoney(child.balance, country) : "Cleared"}
          </Text>
          <Text style={[s.small, { marginTop: 6 }]}>
            {child.balance > 0
              ? `Of ${formatMoney(child.billed, country)} billed. Part payment is fine — many families pay across the term.`
              : `All ${formatMoney(child.billed, country)} paid. Nothing due until Term 1.`}
          </Text>
          {child.balance > 0 && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => nav.navigate("Pay", { childId: child.id })}
              style={[s.primary, { backgroundColor: tint, marginTop: 12 }]}
            >
              <Text style={s.primaryLabel}>Pay with M-Pesa</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={[s.row, { marginTop: 16, gap: 10 }]}>
          {[
            { label: "ATTENDANCE", value: `${child.attendance}%`, note: "this term" },
            { label: "MEAN GRADE", value: gradeFor(child.mean, gradingSchemeFor(country, child.classLevel)), note: `${child.mean} marks, Mock 1` },
          ].map((k) => (
            <View key={k.label} style={[s.card, { flex: 1, padding: 14 }]}>
              <Text style={s.eyebrow}>{k.label}</Text>
              <Text style={{ fontSize: 24, fontWeight: "600", marginTop: 4 }}>{k.value}</Text>
              <Text style={s.faint}>{k.note}</Text>
            </View>
          ))}
        </View>

        {child.attendance < 90 && (
          <View style={[s.banner, { marginTop: 16 }]}>
            <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>!</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.bannerText, { fontWeight: "600", fontSize: 13.5 }]}>
                {child.first} missed two days this term
              </Text>
              <Text style={[s.bannerText, { marginTop: 4 }]}>
                28 and 29 August, both unexplained. Telling the class teacher clears it from the record.
              </Text>
            </View>
          </View>
        )}

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>From the school</Text>
        {messages.slice(0, 2).map((m) => (
          <TouchableOpacity
            key={m.id}
            onPress={() => nav.navigate("Inbox", { id: m.id })}
            style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12 }]}
          >
            <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: m.who === "school" ? tint : "#F1EDEC", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: m.who === "school" ? "#fff" : "#6B605F", fontSize: 13 }}>
                {m.who === "school" ? "\u25C8" : "\u270E"}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: m.unread ? "700" : "500" }}>{m.subject}</Text>
              <Text numberOfLines={2} style={[s.small, { marginTop: 4 }]}>{m.body.split("\n")[0]}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}
