import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatMoney, PAYMENT_FAILURES, normaliseMsisdn, parseShillings, payableSuggestions, payWithMpesa, wholeShillings, type PaymentFailure } from "@figbloom/shared";
import { PaymentMethodsCard, usePaymentMethods } from "./PaymentMethods";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Tap } from "../ui/Tap";
import { Check, CircleAlert } from "lucide-react-native";
import { useTheme } from "../ui/ThemeContext";

type Screen = "form" | "sending" | "prompting" | "success" | "failed" | "unconfirmed" | "unavailable";

/** Who is paying for what: everything the flow needs from whoever opened it (a parent for a child, a learner for themself). */
export interface PayTarget {
  /** Whose fees: shown on the card and on the receipt. */
  name: string;
  /** Under the name: usually the class. */
  context: string;
  /** Whose balance changes, as it reads mid-sentence: "Faith's", "your". */
  possessive: string;
  /** Still owed, charges included. */
  balance: number;
  /** This term's invoice; null until the school has billed. */
  invoiceId: string | null;
  country: string;
  tint: string;
  tenantId: string;
  /** Called when a payment is confirmed, or may still be on its way, so the caller can read the balance again. */
  onSettled: () => void;
}

/**
 * The payment flow, and the one place the copy matters most.
 *
 * A payer's real fear is that money left the account and the school did not
 * see it. So nothing here ever decides a payment worked: payWithMpesa asks the
 * server for the prompt and then reads the payment row until Safaricom's
 * confirmed answer is on it. "Received" means the database says so; every
 * failure states plainly whether money moved; and when we stop waiting
 * without an answer we say so rather than guess.
 */
export function PayFlow({ target }: { target: PayTarget }) {
  const { t, s, accentInk } = useTheme();
  const nav = useNavigation<any>();
  const { balance, invoiceId, country, tint, tenantId } = target;
  // "Faith's" starts a sentence as it is; "your" needs its capital.
  const Possessive = target.possessive.charAt(0).toUpperCase() + target.possessive.slice(1);

  const [screen, setScreen] = useState<Screen>("form");
  // what was typed, kept as typed: a decimal point is refused with a reason, never dropped (FIG-1334)
  const [amountText, setAmountText] = useState(balance > 0 ? String(wholeShillings(balance) / 100) : "");
  const parsed = parseShillings(amountText);
  const amount = parsed.ok ? parsed.cents : 0;
  // No stand-in number: a prefilled demo MSISDN would send a real prompt to a stranger's phone.
  const [phone, setPhone] = useState("");
  /** Where a problem shows: under the field it is about, or (form) by the button when it is about neither. */
  const [errors, setErrors] = useState<{ amount?: string; phone?: string; form?: string }>({});
  const [failure, setFailure] = useState<PaymentFailure>("timeout");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [balanceBefore, setBalanceBefore] = useState(balance);
  const abort = useRef<AbortController | null>(null);
  const methods = usePaymentMethods(tenantId);

  // Leaving the screen stops us watching; the payment itself carries on and is credited by Safaricom's callback.
  useEffect(() => () => abort.current?.abort(), []);

  async function send() {
    const p = normaliseMsisdn(phone);
    if (!p.ok) { setErrors({ phone: p.message }); return; }
    if (!parsed.ok) { setErrors({ amount: parsed.message }); return; }
    if (amount <= 0) { setErrors({ amount: "Enter how much you are paying." }); return; }
    if (amount > wholeShillings(balance)) { setErrors({ amount: `That is more than the ${formatMoney(balance, country)} still owed.` }); return; }
    if (!invoiceId) { setErrors({ form: "The school hasn't billed this term yet, so there is nothing to pay online." }); return; }

    setErrors({});
    setBalanceBefore(balance);
    setScreen("sending");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await payWithMpesa(
        { invoiceId, amountCents: amount, msisdn: p.msisdn },
        { signal: controller.signal, onPrompted: () => setScreen("prompting") },
      );
      switch (result.kind) {
        case "success": setReceipt(result.receipt); setScreen("success"); target.onSettled(); break;
        case "failed": setFailure(result.reason); setScreen("failed"); break;
        case "unconfirmed": setScreen("unconfirmed"); target.onSettled(); break;
        case "unavailable": setScreen("unavailable"); break;
        case "rejected": setErrors({ form: result.message }); setScreen("form"); break;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setErrors({ form: "Something went wrong. Nothing was charged. Try again." });
      setScreen("form");
    }
  }

  if (screen === "sending" || screen === "prompting") {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center", padding: 32 }]}>
        <ActivityIndicator size="large" color={accentInk(tint)} />
        <Text style={{ color: t.appSurface.ink, fontSize: 17, fontWeight: "600", marginTop: 20 }}>{screen === "sending" ? "Contacting M-Pesa…" : "Check your phone"}</Text>
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
          <Check size={28} color={t.status.okInk} strokeWidth={2.5} />
        </View>
        <Text style={{ color: t.appSurface.ink, fontSize: 19, fontWeight: "600", marginTop: 16 }}>{formatMoney(amount, country)} received</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 300 }]}>
          M-Pesa confirmed it. {Possessive} balance is now {formatMoney(Math.max(balanceBefore - amount, 0), country)}.
        </Text>

        <View style={[s.card, { marginTop: 20, width: "100%" }]}>
          {[["Paid", formatMoney(amount, country)], ["For", target.name], ["Method", "M-Pesa " + phone], ...(receipt ? [["Receipt", receipt]] : [])].map(([k, v]) => (
            <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
              <Text style={s.small}>{k}</Text>
              <Text style={{ color: t.appSurface.ink, fontSize: 12.5, fontWeight: "500" }}>{v}</Text>
            </View>
          ))}
        </View>

        <Button label="Done" tint={tint} onPress={() => nav.goBack()} style={{ marginTop: 20, width: "100%" }} />
      </ScrollView>
    );
  }

  if (screen === "unconfirmed") {
    return (
      <View style={[s.screen, { padding: 24, alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.status.warnBg, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 24, color: t.status.warnInk }}>…</Text>
        </View>
        <Text style={{ color: t.appSurface.ink, fontSize: 19, fontWeight: "600", marginTop: 16, textAlign: "center" }}>We haven't heard back from M-Pesa yet</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 320, lineHeight: 19 }]}>
          If you entered your PIN, the payment may still come through, and your balance will update when it does. Check Receipts in a few minutes
          before paying again, so you don't pay twice.
        </Text>
        <Button label="Back to fees" tint={tint} onPress={() => nav.goBack()} style={{ marginTop: 20, width: "100%" }} />
      </View>
    );
  }

  if (screen === "unavailable") {
    return (
      <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }}>
        <Text style={{ color: t.appSurface.ink, fontSize: 19, fontWeight: "600", marginTop: 8 }}>Pay using the school's details</Text>
        <Text style={[s.small, { marginTop: 8, marginBottom: 16, lineHeight: 19 }]}>
          Online M-Pesa isn't available for your school right now. Nothing was sent to your phone and nothing was charged.
        </Text>
        {methods ? (
          <PaymentMethodsCard methods={methods} />
        ) : methods === null ? (
          <View style={s.card}><Text style={s.small}>Ask the school office how to pay.</Text></View>
        ) : (
          <ActivityIndicator color={accentInk(tint)} />
        )}
        <Text style={[s.faint, { marginTop: 14, lineHeight: 18 }]}>
          After you pay, the school records it and {target.possessive} balance updates. Keep your receipt or SMS until it does.
        </Text>
        <Button label="Back to fees" tint={tint} onPress={() => nav.goBack()} style={{ marginTop: 20 }} />
      </ScrollView>
    );
  }

  if (screen === "failed") {
    return (
      <View style={[s.screen, { padding: 24, alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.status.warnBg, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 24, color: t.status.warnInk }}>!</Text>
        </View>
        <Text style={{ color: t.appSurface.ink, fontSize: 19, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
          The payment did not go through
        </Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8, maxWidth: 300 }]}>
          {PAYMENT_FAILURES[failure]}
        </Text>
        <Button label="Try again" tint={tint} onPress={() => setScreen("form")} style={{ marginTop: 20, width: "100%" }} />
        <Button variant="secondary" label="Pay at the school office instead" onPress={() => nav.goBack()} style={{ marginTop: 8, width: "100%" }} />
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <Text style={s.eyebrow}>PAYING FOR</Text>
        <Text style={{ color: t.appSurface.ink, fontSize: 16, fontWeight: "600", marginTop: 4 }}>{target.name}</Text>
        <Text style={s.small}>{target.context} · balance {formatMoney(balance, country)}</Text>
      </View>

      <Text style={[s.h2, { marginTop: 16, marginBottom: 8 }]}>How much?</Text>
      {payableSuggestions(balance).map((sug) => {
        const on = sug.cents > 0 && amount === sug.cents;
        return (
          <Tap
            key={sug.label}
            onPress={() => setAmountText(sug.cents > 0 ? String(sug.cents / 100) : "")}
            style={[s.card, { marginBottom: 8, padding: 14, borderWidth: 1.5, borderColor: on ? accentInk(tint) : t.appSurface.line, flexDirection: "row", justifyContent: "space-between" }]}
          >
            <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "500" }}>{sug.label}</Text>
            {sug.cents > 0 && <Text style={[s.mono, { color: t.appSurface.ink }]}>{formatMoney(sug.cents, country)}</Text>}
          </Tap>
        );
      })}

      <Field
        label="Amount"
        keyboardType="number-pad"
        value={amountText}
        onChangeText={(v) => { setAmountText(v); setErrors({}); }}
        error={errors.amount ?? (parsed.ok ? undefined : parsed.message)}
        style={{ marginTop: 8 }}
      />

      <Field
        label="M-Pesa number"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={(v) => { setPhone(v); setErrors({}); }}
        placeholder="e.g. 0712 345 678"
        autoComplete="tel"
        error={errors.phone}
        style={{ marginTop: 14 }}
      />

      {!!errors.form && (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 14 }}>
          <CircleAlert size={14} color={t.status.warnInk} style={{ marginTop: 2 }} />
          <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: t.status.warnInk }}>{errors.form}</Text>
        </View>
      )}

      <Button label="Send M-Pesa prompt" tint={tint} onPress={() => void send()} style={{ marginTop: 20 }} />
      <Text style={[s.faint, { textAlign: "center", marginTop: 12, lineHeight: 18 }]}>
        You will get a prompt on {phone || "that number"}. Nothing leaves your account until you enter your PIN.
      </Text>
    </ScrollView>
  );
}
