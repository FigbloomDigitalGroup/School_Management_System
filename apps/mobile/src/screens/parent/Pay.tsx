import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatMoney, PAYMENT_FAILURES, normaliseMsisdn, parseShillings, payableSuggestions, payWithMpesa, wholeShillings, type PaymentFailure } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useReloadParentData, useTenantId } from "../../data";
import { PaymentMethodsCard, usePaymentMethods } from "../../components/PaymentMethods";

type Screen = "form" | "sending" | "prompting" | "success" | "failed" | "unconfirmed" | "unavailable";

/**
 * The payment flow, and the one place the copy matters most.
 *
 * A parent's real fear is that money left the account and the school did not
 * see it. So nothing here ever decides a payment worked: payWithMpesa asks the
 * server for the prompt and then reads the payment row until Safaricom's
 * confirmed answer is on it. "Received" means the database says so; every
 * failure states plainly whether money moved; and when we stop waiting
 * without an answer we say so rather than guess.
 */
export function ParentPay() {
  const nav = useNavigation<any>();
  const { child, index, accent, country } = useChild();
  const reload = useReloadParentData();
  const tenantId = useTenantId();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;

  const [screen, setScreen] = useState<Screen>("form");
  // what was typed, kept as typed: a decimal point is refused with a reason, never dropped (FIG-1334)
  const [amountText, setAmountText] = useState(child.balance > 0 ? String(wholeShillings(child.balance) / 100) : "");
  const parsed = parseShillings(amountText);
  const amount = parsed.ok ? parsed.cents : 0;
  // No stand-in number: a prefilled demo MSISDN would send a real prompt to a stranger's phone.
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<PaymentFailure>("timeout");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [balanceBefore, setBalanceBefore] = useState(child.balance);
  const abort = useRef<AbortController | null>(null);
  const methods = usePaymentMethods(tenantId);

  // Leaving the screen stops us watching; the payment itself carries on and is credited by Safaricom's callback.
  useEffect(() => () => abort.current?.abort(), []);

  async function send() {
    const p = normaliseMsisdn(phone);
    if (!p.ok) { setError(p.message); return; }
    if (!parsed.ok) { setError(parsed.message); return; }
    if (amount <= 0) { setError("Enter how much you are paying."); return; }
    if (amount > wholeShillings(child.balance)) { setError(`That is more than the ${formatMoney(child.balance, country)} still owed.`); return; }
    if (!child.invoiceId) { setError("The school hasn't billed this term yet, so there is nothing to pay online."); return; }

    setError("");
    setBalanceBefore(child.balance);
    setScreen("sending");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await payWithMpesa(
        { invoiceId: child.invoiceId, amountCents: amount, msisdn: p.msisdn },
        { signal: controller.signal, onPrompted: () => setScreen("prompting") },
      );
      switch (result.kind) {
        case "success": setReceipt(result.receipt); setScreen("success"); reload(); break;
        case "failed": setFailure(result.reason); setScreen("failed"); break;
        case "unconfirmed": setScreen("unconfirmed"); reload(); break;
        case "unavailable": setScreen("unavailable"); break;
        case "rejected": setError(result.message); setScreen("form"); break;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError("Something went wrong. Nothing was charged. Try again.");
      setScreen("form");
    }
  }

  if (screen === "sending" || screen === "prompting") {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center", padding: 32 }]}>
        <ActivityIndicator size="large" color={tint} />
        <Text style={{ fontSize: 17, fontWeight: "600", marginTop: 20 }}>{screen === "sending" ? "Contacting M-Pesa…" : "Check your phone"}</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 300 }]}>
          {screen === "sending"
            ? "Sending the request. This takes a few seconds."
            : `An M-Pesa prompt has been sent to ${phone}. Enter your PIN when it appears. This screen updates when M-Pesa confirms; if you leave it, your balance still updates once the payment arrives.`}
        </Text>
      </View>
    );
  }

  if (screen === "success") {
    return (
      <ScrollView contentContainerStyle={{ padding: 24, alignItems: "center" }} style={s.screen}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.status.okBg, alignItems: "center", justifyContent: "center", marginTop: 24 }}>
          <Text style={{ fontSize: 24, color: t.status.okInk }}>✓</Text>
        </View>
        <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 16 }}>{formatMoney(amount, country)} received</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 300 }]}>
          M-Pesa confirmed it. {child.first}'s balance is now {formatMoney(Math.max(balanceBefore - amount, 0), country)}.
        </Text>

        <View style={[s.card, { marginTop: 20, width: "100%" }]}>
          {[["Paid", formatMoney(amount, country)], ["For", child.name], ["Method", "M-Pesa " + phone], ...(receipt ? [["Receipt", receipt]] : [])].map(([k, v]) => (
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

  if (screen === "unconfirmed") {
    return (
      <View style={[s.screen, { padding: 24, alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.status.warnBg, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 24, color: t.status.warnInk }}>…</Text>
        </View>
        <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 16, textAlign: "center" }}>We haven't heard back from M-Pesa yet</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 320, lineHeight: 19 }]}>
          If you entered your PIN, the payment may still come through, and your balance will update when it does. Check Receipts in a few minutes
          before paying again, so you don't pay twice.
        </Text>
        <TouchableOpacity onPress={() => nav.goBack()} style={[s.primary, { backgroundColor: tint, marginTop: 20, width: "100%" }]}>
          <Text style={s.primaryLabel}>Back to fees</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (screen === "unavailable") {
    return (
      <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }}>
        <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 8 }}>Pay using the school's details</Text>
        <Text style={[s.small, { marginTop: 8, marginBottom: 16, lineHeight: 19 }]}>
          Online M-Pesa isn't available for your school right now. Nothing was sent to your phone and nothing was charged.
        </Text>
        {methods ? (
          <PaymentMethodsCard methods={methods} />
        ) : methods === null ? (
          <View style={s.card}><Text style={s.small}>Ask the school office how to pay.</Text></View>
        ) : (
          <ActivityIndicator color={tint} />
        )}
        <Text style={[s.faint, { marginTop: 14, lineHeight: 18 }]}>
          After you pay, the school records it and {child.first}'s balance updates. Keep your receipt or SMS until it does.
        </Text>
        <TouchableOpacity onPress={() => nav.goBack()} style={[s.primary, { backgroundColor: tint, marginTop: 20 }]}>
          <Text style={s.primaryLabel}>Back to fees</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (screen === "failed") {
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
        <TouchableOpacity onPress={() => setScreen("form")} style={[s.primary, { backgroundColor: tint, marginTop: 20, width: "100%" }]}>
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
            onPress={() => setAmountText(sug.cents > 0 ? String(sug.cents / 100) : "")}
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
        value={amountText}
        onChangeText={setAmountText}
        style={{ borderWidth: 1, borderColor: parsed.ok ? t.appSurface.line : t.status.warnInk, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, fontFamily: "monospace" }}
      />
      {!parsed.ok && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 6 }}>{parsed.message}</Text>}

      <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>M-Pesa number</Text>
      <TextInput
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
        placeholder="e.g. 0712 345 678"
        style={{ borderWidth: 1, borderColor: error ? t.status.warnInk : t.appSurface.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, fontFamily: "monospace" }}
      />
      {!!error && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 6 }}>{error}</Text>}

      <TouchableOpacity onPress={() => void send()} style={[s.primary, { backgroundColor: tint, marginTop: 20 }]}>
        <Text style={s.primaryLabel}>Send M-Pesa prompt</Text>
      </TouchableOpacity>
      <Text style={[s.faint, { textAlign: "center", marginTop: 12, lineHeight: 18 }]}>
        You will get a prompt on {phone || "that number"}. Nothing leaves your account until you enter your PIN.
      </Text>
    </ScrollView>
  );
}
