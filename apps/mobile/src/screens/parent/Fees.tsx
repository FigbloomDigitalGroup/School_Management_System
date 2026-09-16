import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatMoney, formatShortDate, itemsForStudent } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useFeeItems, useTermLabel } from "../../data";

export function ParentFees() {
  const nav = useNavigation<any>();
  const { child, index, accent, country } = useChild();
  const feeItems = useFeeItems();
  const termLabel = useTermLabel();
  const items = itemsForStudent(feeItems as never, { boarding: child.boarding }, child.formLevel);
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const paid = child.billed - child.balance;
  const paidPct = child.billed > 0 ? (paid / child.billed) * 100 : 0;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>Fees</Text>
        <Text style={s.headerSub}>{child.name}{termLabel ? ` · ${termLabel}` : ""}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.card}>
          <Text style={s.eyebrow}>BALANCE</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
            <Text style={{ fontSize: 26, fontWeight: "700" }}>{formatMoney(child.balance, country)}</Text>
            <Text style={s.small}>{child.dueOn ? `due ${formatShortDate(child.dueOn)}` : "nothing due"}</Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.appSurface.lineSoft, marginTop: 12, overflow: "hidden" }}>
            <View style={{ height: 8, borderRadius: 4, width: `${paidPct}%`, backgroundColor: tint }} />
          </View>
          <Text style={[s.faint, { marginTop: 8 }]}>{formatMoney(paid, country)} paid of {formatMoney(child.billed, country)}</Text>
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>What this term covers</Text>
        <View style={s.card}>
          {items.length === 0 ? (
            <Text style={[s.faint, { paddingVertical: 10 }]}>Fee structure not published yet.</Text>
          ) : (
            items.map((i, idx) => (
              <View key={i.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: idx === items.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
                <Text style={{ fontSize: 13 }}>{i.name}</Text>
                <Text style={s.mono}>{formatMoney(i.amount_cents, country)}</Text>
              </View>
            ))
          )}
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Receipts</Text>
        <View style={s.card}>
          {child.receipts.length === 0 ? (
            <Text style={[s.faint, { paddingVertical: 10 }]}>Payments made through M-Pesa appear here once confirmed.</Text>
          ) : (
            child.receipts.map((r, i) => (
              <View key={r.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 11, borderBottomWidth: i === child.receipts.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: "500" }}>{formatMoney(r.amount, country)}</Text>
                  <Text style={[s.mono, { color: t.appSurface.inkFaint, marginTop: 2 }]}>{r.when} · {r.ref}</Text>
                </View>
                <View style={[s.pill, { backgroundColor: t.status.okBg }]}>
                  <Text style={[s.pillLabel, { color: t.status.okInk }]}>Received</Text>
                </View>
              </View>
            ))
          )}
        </View>

        {child.balance > 0 && (
          <TouchableOpacity onPress={() => nav.navigate("Pay")} style={[s.primary, { backgroundColor: tint, marginTop: 20 }]}>
            <Text style={s.primaryLabel}>Pay {formatMoney(child.balance, country)}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}
