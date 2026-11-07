import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import {
  PAYMENT_METHODS, PAYMENT_METHOD_SHORT, formatMoney, learnerNameOf, paymentFormStart, readPaymentEntry, recordPayment, searchPayableInvoices,
  type PayableInvoice, type PaymentMethodValue,
} from "@figbloom/shared";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { StaffSession } from "../../lib/staffSession";
import { useSearch } from "../../lib/useSearch";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";
import type { RecordPaymentParams } from "./Fees";

/**
 * The one way the office credits an invoice outside the M-Pesa prompt: cash at the bursar's window, a bank slip, a
 * cheque, or M-Pesa paid straight to the school's paybill. Find the learner (unless the balance it was opened from
 * names them), enter what was received and how, and the database writes a real payment that moves the balance. When it
 * was opened from a family's proof, recording confirms the proof too. A payment cannot be undone from here, so it asks first.
 */
export function RecordPayment({ session, params, onRecorded }: { session: StaffSession; params: RecordPaymentParams; onRecorded: (text: string) => void }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { termId, invoice: preset, proof } = params;
  const country = session.country;
  const [invoice, setInvoice] = useState<PayableInvoice | undefined>(preset);
  const [query, setQuery] = useState("");
  // A pasted SMS fills the form in; never more than the balance, which record_payment would refuse anyway.
  const start = paymentFormStart(proof, preset?.balanceCents);
  const [amount, setAmount] = useState(start.amount);
  const [method, setMethod] = useState<PaymentMethodValue>(start.method);
  const [reference, setReference] = useState(start.reference);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Look the learner up as they are typed (until one is chosen).
  const { results, searching, error: searchFailed, enough } = useSearch(query, (q) => searchPayableInvoices(termId, q), { paused: !!invoice });

  const chosen = PAYMENT_METHODS.find((m) => m.value === method)!;

  async function save(cents: number) {
    if (!invoice) return;
    setSaving(true);
    try {
      await recordPayment({ invoiceId: invoice.id, cents, method, reference, proofId: proof?.id });
      onRecorded(`${formatMoney(cents, country)} recorded for ${learnerNameOf(invoice.studentName)}`);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not record the payment.");
      setSaving(false);
    }
  }

  function confirm() {
    if (!invoice) return;
    setProblem(null);
    const entry = readPaymentEntry({ amount, method, reference, balanceCents: invoice.balanceCents, country });
    if (!entry.ok) { setProblem(entry.message); return; }
    const name = learnerNameOf(invoice.studentName);
    const ref = reference.trim();
    Alert.alert(
      `Record ${formatMoney(entry.cents, country)} for ${name}?`,
      `${PAYMENT_METHOD_SHORT[method]}${ref ? `, ref ${ref}` : ""}. It goes on the invoice at once and cannot be undone from the phone.${proof ? " The family's proof is confirmed with it." : ""}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Record payment", onPress: () => void save(entry.cents) },
      ],
    );
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title={proof ? "Confirm payment proof" : "Record a payment"} sub={proof ? "Then the balance moves" : "Money received outside the M-Pesa prompt"} color={a.deep} back />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}>
        {proof && (
          <Text style={s.small}>
            {proof.smsText
              ? "Find this code on the school's M-Pesa or bank statement before confirming. The balance only moves once the payment is recorded."
              : `Check ${proof.fileName ?? "the proof"} and enter what it shows. The balance only moves once the payment is recorded.`}
          </Text>
        )}

        {invoice ? (
          <View style={[s.card, { flexDirection: "row", justifyContent: "space-between", gap: 10 }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{invoice.studentName}</Text>
              <Text style={s.faint}>{invoice.cls}</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={s.faint}>Balance</Text>
              <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: t.appSurface.ink }}>{formatMoney(invoice.balanceCents, country)}</Text>
              {!preset && <Button variant="quiet" label="Change" onPress={() => { setInvoice(undefined); setQuery(""); setAmount(""); }} />}
            </View>
          </View>
        ) : (
          <View>
            <Field
              label="Learner" placeholder="Name or admission number" value={query} onChangeText={setQuery} autoCapitalize="words" autoCorrect={false}
              hint={searching ? "Searching…" : searchFailed ?? (enough && results.length === 0 ? "No invoice this term matches." : undefined)}
            />
            {results.length > 0 && (
              <View style={[s.card, { padding: 0, overflow: "hidden", marginTop: 8 }]}>
                {results.map((r) => (
                  <Tap
                    key={r.id} accessibilityLabel={`${r.studentName}, ${r.cls}, balance ${formatMoney(r.balanceCents, country)}`} onPress={() => setInvoice(r)}
                    style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: fontSize.body, fontWeight: "500", color: t.appSurface.ink }}>{r.studentName}</Text>
                      <Text style={s.faint}>{r.cls}</Text>
                    </View>
                    <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink }}>{formatMoney(r.balanceCents, country)}</Text>
                  </Tap>
                ))}
              </View>
            )}
          </View>
        )}

        {!!proof?.smsText && (
          <View style={[s.card, { gap: 4 }]}>
            <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink }}>Message the parent pasted</Text>
            <Text style={s.small}>{proof.smsText}</Text>
          </View>
        )}
        {!!proof?.note && <Text style={s.small}>Parent's note: {proof.note}</Text>}

        {invoice && (
          <>
            <Field label="Amount received" placeholder="e.g. 15000" keyboardType="number-pad" value={amount} onChangeText={setAmount} editable={!saving} />
            <View>
              <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }}>How it was paid</Text>
              <PillPicker
                items={PAYMENT_METHODS.map((m) => ({ id: m.value, name: PAYMENT_METHOD_SHORT[m.value] }))}
                selectedId={method} onPick={(id) => setMethod(id as PaymentMethodValue)} accent={session.accent}
              />
              <Text style={s.faint}>{chosen.label}</Text>
            </View>
            <Field
              label={chosen.refLabel} value={reference} onChangeText={setReference} editable={!saving} autoCapitalize="characters" autoCorrect={false}
              hint={problem ? undefined : chosen.refHint} error={problem ?? undefined}
            />
            <Button label={proof ? "Confirm and record" : "Record payment"} loading={saving} onPress={confirm} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
