import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatMoney, PAYMENT_FAILURES, normaliseMsisdn, payableSuggestions } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild } from "../../data";

type State = "form" | "prompting" | "failed" | "done";

/**
 * The payment flow, and the one place the copy matters most.
 *
 * A parent's real fear is that money left the account and the school did not
 * see it. So every failure states plainly whether money moved, and the waiting
 * screen tells them to expect a prompt on the handset rather than spinning
 * silently.
 */
export function ParentPay() {
  const nav = useNavigation<any>();
  const { child, index, accent, country } = useChild();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;

  const [state, setState] = useState<State>("form");
  const [amount, setAmount] = useState(child.balance);
  const [phone, setPhone] = useState("0722 118 004");
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<keyof typeof PAYMENT_FAILURES>("timeout");

  function send() {
    const p = normaliseMsisdn(phone);
    if (!p.ok) { setError(p.message); return; }
    if (amount <= 0) { setError("Enter how much you are paying."); return; }
    setError("");
    setState("prompting");
    // POST to the mpesa-stk-push function; the callback flips the payment row.
    setTimeout(() => {
      if (amount > child.balance) { setFailure("insufficient"); setState("failed"); }
      else setState("done");
    }, 1800);
  }

  if (state === "prompting") {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center", padding: 32 }]}>
        <ActivityIndicator size="large" color={tint} />
        <Text style={{ fontSize: 17, fontWeight: "600", marginTop: 20 }}>Check your phone</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 280 }]}>
          An M-Pesa prompt has been sent to {phone}. Enter your PIN when it appears. Do not close this screen.
        </Text>
      </View>
    );
  }

  if (state === "done") {
    return (
      <ScrollView contentContainerStyle={{ padding: 24, alignItems: "center" }} style={s.screen}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.status.okBg, alignItems: "center", justifyContent: "center", marginTop: 24 }}>
          <Text style={{ fontSize: 24, color: t.status.okInk }}>✓</Text>
        </View>
        <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 16 }}>{formatMoney(amount, country)} received</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 300 }]}>
          Receipt SJ91MX441. {child.first}'s balance is now {formatMoney(Math.max(child.balance - amount, 0), country)}.
        </Text>

        <View style={[s.card, { marginTop: 20, width: "100%" }]}>
          {[["Paid", formatMoney(amount, country)], ["For", child.name], ["Method", "M-Pesa " + phone], ["Reference", "SJ91MX441"]].map(([k, v]) => (
            <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
              <Text style={s.small}>{k}</Text>
              <Text style={{ fontSize: 12.5, fontWeight: "500" }}>{v}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity onPress={() => nav.goBack()} style={[s.primary, { backgroundColor: tint, marginTop: 20, width: "100%" }]}>
          <Text style={s.primaryLabel}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (state === "failed") {
    return (
      <View style={[s.screen, { padding: 24, alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.status.warnBg, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 24, color: t.status.warnInk }}>!</Text>
        </View>
        <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
          The payment did not go through
        </Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 300 }]}>
          {PAYMENT_FAILURES[failure]}
        </Text>
        <TouchableOpacity onPress={() => setState("form")} style={[s.primary, { backgroundColor: tint, marginTop: 20, width: "100%" }]}>
          <Text style={s.primaryLabel}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => nav.goBack()} style={[s.primary, { marginTop: 8, width: "100%", borderWidth: 1, borderColor: t.appSurface.line }]}>
          <Text style={{ fontSize: 15, fontWeight: "600" }}>Pay at the school office instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }}>
      <View style={s.card}>
        <Text style={s.eyebrow}>PAYING FOR</Text>
        <Text style={{ fontSize: 16, fontWeight: "600", marginTop: 4 }}>{child.name}</Text>
        <Text style={s.small}>{child.cls} · balance {formatMoney(child.balance, country)}</Text>
      </View>

      <Text style={[s.h2, { marginTop: 16, marginBottom: 8 }]}>How much?</Text>
      {payableSuggestions(child.balance).map((sug) => {
        const on = sug.cents > 0 && amount === sug.cents;
        return (
          <TouchableOpacity
            key={sug.label}
            onPress={() => setAmount(sug.cents)}
            style={[s.card, { marginBottom: 8, padding: 14, borderWidth: 1.5, borderColor: on ? tint : t.appSurface.line, flexDirection: "row", justifyContent: "space-between" }]}
          >
            <Text style={{ fontSize: 13.5, fontWeight: "500" }}>{sug.label}</Text>
            {sug.cents > 0 && <Text style={s.mono}>{formatMoney(sug.cents, country)}</Text>}
          </TouchableOpacity>
        );
      })}

      <Text style={[s.small, { fontWeight: "600", marginTop: 8, marginBottom: 6 }]}>Amount</Text>
      <TextInput
        keyboardType="number-pad"
        value={amount ? String(amount / 100) : ""}
        onChangeText={(v) => setAmount(Number(v.replace(/[^0-9]/g, "")) * 100)}
        style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, fontFamily: "monospace" }}
      />

      <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>M-Pesa number</Text>
      <TextInput
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
        style={{ borderWidth: 1, borderColor: error ? t.status.warnInk : t.appSurface.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, fontFamily: "monospace" }}
      />
      {!!error && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 6 }}>{error}</Text>}

      <TouchableOpacity onPress={send} style={[s.primary, { backgroundColor: tint, marginTop: 20 }]}>
        <Text style={s.primaryLabel}>Send M-Pesa prompt</Text>
      </TouchableOpacity>
      <Text style={[s.faint, { textAlign: "center", marginTop: 12, lineHeight: 18 }]}>
        You will get a prompt on {phone}. Nothing leaves your account until you enter your PIN.
      </Text>
    </ScrollView>
  );
}
