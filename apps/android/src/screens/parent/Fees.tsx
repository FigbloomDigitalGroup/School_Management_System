import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { KES } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild } from "../../data";

const ITEMS: [string, number][] = [
  ["Tuition", 1_050_000], ["Boarding and meals", 1_800_000],
  ["Activity and clubs", 150_000], ["Examination fund", 200_000],
];

const RECEIPTS: [string, string, number][] = [
  ["12 Aug", "M-Pesa · SJ48KD920", 1_000_000],
  ["04 Aug", "M-Pesa · SJ22LP771", 810_000],
];

export function ParentFees() {
  const nav = useNavigation<any>();
  const { child, index, accent } = useChild();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const paid = child.billed - child.balance;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>Fees</Text>
        <Text style={s.headerSub}>{child.name} · Term 3, 2026</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.card}>
          <Text style={s.eyebrow}>BALANCE</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
            <Text style={{ fontSize: 26, fontWeight: "700" }}>{KES(child.balance)}</Text>
            <Text style={s.small}>due 30 Sep</Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.appSurface.lineSoft, marginTop: 12, overflow: "hidden" }}>
            <View style={{ height: 8, borderRadius: 4, width: `${(paid / child.billed) * 100}%`, backgroundColor: tint }} />
          </View>
          <Text style={[s.faint, { marginTop: 8 }]}>{KES(paid)} paid of {KES(child.billed)}</Text>
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>What this term covers</Text>
        <View style={s.card}>
          {ITEMS.map(([n, c], i) => (
            <View key={n} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: i === ITEMS.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
              <Text style={{ fontSize: 13 }}>{n}</Text>
              <Text style={s.mono}>{KES(c)}</Text>
            </View>
          ))}
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Receipts</Text>
        <View style={s.card}>
          {RECEIPTS.map(([d, ref, amt], i) => (
            <View key={ref} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 11, borderBottomWidth: i === RECEIPTS.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
              <View>
                <Text style={{ fontSize: 13, fontWeight: "500" }}>{KES(amt)}</Text>
                <Text style={[s.mono, { color: t.appSurface.inkFaint, marginTop: 2 }]}>{d} · {ref}</Text>
              </View>
              <View style={[s.pill, { backgroundColor: t.status.okBg }]}>
                <Text style={[s.pillLabel, { color: t.status.okInk }]}>Received</Text>
              </View>
            </View>
          ))}
        </View>

        {child.balance > 0 && (
          <TouchableOpacity onPress={() => nav.navigate("Pay")} style={[s.primary, { backgroundColor: tint, marginTop: 20 }]}>
            <Text style={s.primaryLabel}>Pay {KES(child.balance)}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}
