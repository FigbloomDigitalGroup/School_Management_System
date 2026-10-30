import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import {
  formatFileSize, formatMoney, listPaymentProofs, parsePaymentSms, PAYMENT_PROOF_LABEL, PAYMENT_SMS_MAX, PAYMENT_SMS_SOURCE_LABEL,
  paymentSmsFlags, sendPaymentProof, uploadProblem, type PaymentProof, type PaymentSmsFlag,
} from "@figbloom/shared";
import { pickFile, readPickedFile, type FileSource, type PickedFile } from "../lib/pickFile";
import { s, t } from "../theme";
import { AttachChoices } from "./AttachChoices";
import { Tap } from "../ui/Tap";

// What a family is told about a flag: gentler than the office's label, and
// never a refusal -- a part payment is still a payment.
const FAMILY_FLAG: Partial<Record<PaymentSmsFlag, string>> = {
  amount_differs: "This is not the full balance. That's fine for a part payment.",
  wrong_payee_number: "This doesn't look like it went to the school's paybill or till. Check you pasted the right message.",
  future_date: "The date on this message is in the future. Check you pasted the right message.",
};

const PROOF_TONE: Record<PaymentProof["status"], { bg: string; ink: string }> = {
  pending: { bg: t.status.mutedBg, ink: t.status.mutedInk },
  confirmed: { bg: t.status.okBg, ink: t.status.okInk },
  rejected: { bg: t.status.warnBg, ink: t.status.warnInk },
};

const formatPaidAt = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * "Payment proof": the confirmation SMS pasted as text, which is how most
 * families pay (M-Pesa) and what they already have in their phone. What we
 * read from the message is shown before it is sent, so a family can see we
 * got the code and amount right; the bursar still checks it against the
 * school's statement. A photo of the slip (taken now or from the gallery), a
 * screenshot or a PDF can be added, with or without the message.
 */
export function PaymentProofCard({ tenantId, invoiceId, uploadedBy, balanceCents, country, school, tint, canSend }: {
  tenantId: string;
  invoiceId: string;
  uploadedBy: string;
  balanceCents: number | null;
  country: string;
  school: { paybill: string | null; till: string | null };
  tint: string;
  /** False once the invoice is paid: nothing left to prove, but earlier proofs still list. */
  canSend: boolean;
}) {
  const [proofs, setProofs] = useState<PaymentProof[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sms, setSms] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setProofs(null);
    listPaymentProofs(invoiceId)
      .then((p) => { if (alive) setProofs(p); })
      .catch(() => { if (alive) setProofs([]); });
    return () => { alive = false; };
  }, [invoiceId, reloadKey]);

  const parsed = useMemo(() => (sms.trim() ? parsePaymentSms(sms) : null), [sms]);
  const flags = parsed ? paymentSmsFlags(parsed, { balanceCents, ...school }) : [];
  // A pasted message is only worth sending with its code: the code is what the bursar looks up.
  const usable = !!parsed?.code;
  // A photo or PDF on its own is enough; a pasted message that has no code is not (it would only be a note).
  const ready = (file !== null || usable) && (!sms.trim() || usable);

  async function chooseFile(source: FileSource) {
    setMessage(null);
    try {
      const picked = await pickFile(source);
      if (!picked) return;
      const problem = uploadProblem(picked);
      if (problem) { setMessage({ text: problem, bad: true }); return; }
      setFile(picked);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Could not add that file.", bad: true });
    }
  }

  async function send() {
    if (!ready || sending) return;
    setSending(true);
    setMessage(null);
    try {
      await sendPaymentProof({
        tenantId, invoiceId, uploadedBy, note: note.trim() || undefined,
        sms: parsed && usable ? { text: sms, parsed } : undefined,
        file: file ? await readPickedFile(file) : undefined,
      });
      setSms("");
      setFile(null);
      setNote("");
      setMessage({ text: "Payment proof sent. The bursar will review it.", bad: false });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setMessage({ text: err instanceof Error ? `Could not send proof: ${err.message}` : "Could not send proof.", bad: true });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Payment proof</Text>
      <View style={s.card}>
        {canSend && (
          <View style={{ gap: 10, paddingBottom: proofs?.length ? 12 : 0 }}>
            <Text style={{ fontSize: 12, fontWeight: "600" }}>Paid already? Paste the confirmation message</Text>
            <TextInput
              value={sms}
              onChangeText={(v) => setSms(v.slice(0, PAYMENT_SMS_MAX))}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              editable={!sending}
              placeholder="e.g. SJQ4ABC12D Confirmed. Ksh15,000.00 sent to … for account … on 26/10/26 at 10:15 AM …"
              placeholderTextColor={t.appSurface.inkFaint}
              style={{ minHeight: 88, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, padding: 10, fontFamily: "monospace", fontSize: 12, color: t.appSurface.ink }}
            />
            <Text style={s.faint}>The M-Pesa, Airtel Money or bank SMS, copied whole. No screenshot needed; a photo or PDF can go with it or instead.</Text>

            {parsed && (
              <View style={{ borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, backgroundColor: t.appSurface.page, padding: 12, gap: 6 }} accessibilityLiveRegion="polite">
                {usable ? (
                  <>
                    <Text style={{ fontSize: 12, fontWeight: "600" }}>What we read from it. Check before sending:</Text>
                    <Row label={`${PAYMENT_SMS_SOURCE_LABEL[parsed.source]} code`} value={parsed.code} mono />
                    <Row label="Amount" value={parsed.amountCents !== null ? formatMoney(parsed.amountCents, country) : null} mono />
                    <Row label="Paid on" value={parsed.paidAt ? formatPaidAt(parsed.paidAt) : null} />
                    <Row label="Paid to" value={[parsed.payee, parsed.payeeNumber].filter(Boolean).join(" · ") || null} />
                    {!!parsed.account && <Row label="Account" value={parsed.account} mono />}
                    {flags.map((f) => !!FAMILY_FLAG[f] && <Text key={f} style={{ fontSize: 12, color: t.status.warnInk }}>{FAMILY_FLAG[f]}</Text>)}
                  </>
                ) : (
                  <Text style={{ fontSize: 12, color: t.status.warnInk }}>
                    We couldn't find a transaction code in that message. Paste the whole confirmation SMS, starting with the code (e.g. SJQ4ABC12D Confirmed…).
                  </Text>
                )}
              </View>
            )}

            {file ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={[s.small, { flex: 1, color: t.appSurface.ink }]}>📎 {file.name}{file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ""}</Text>
                <Tap accessibilityRole="button" disabled={sending} onPress={() => setFile(null)} style={{ minHeight: 40, justifyContent: "center" }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: t.status.warnInk }}>Remove</Text>
                </Tap>
              </View>
            ) : (
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 12, fontWeight: "600" }}>Add a photo or PDF of the slip (optional)</Text>
                <AttachChoices disabled={sending} onChoose={(source) => void chooseFile(source)} />
              </View>
            )}

            <TextInput
              value={note}
              onChangeText={setNote}
              editable={!sending}
              placeholder="Note (optional), e.g. paid at the school office"
              placeholderTextColor={t.appSurface.inkFaint}
              style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13.5, color: t.appSurface.ink }}
            />
            <Tap
              accessibilityRole="button"
              disabled={!ready || sending}
              onPress={() => void send()}
              style={[s.primary, { backgroundColor: tint, opacity: !ready || sending ? 0.5 : 1 }]}
            >
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Send proof</Text>}
            </Tap>
          </View>
        )}
        {!!message && <Text style={{ fontSize: 12.5, color: message.bad ? t.status.warnInk : t.status.okInk, paddingTop: canSend ? 4 : 0, paddingBottom: proofs?.length ? 8 : 0 }}>{message.text}</Text>}

        {proofs === null ? (
          <ActivityIndicator color={tint} style={{ paddingVertical: 8 }} />
        ) : proofs.length === 0 ? (
          !canSend && <Text style={[s.faint, { paddingVertical: 6 }]}>No payment proof sent for this invoice.</Text>
        ) : (
          proofs.map((p, i) => (
            <View key={p.id} style={{ paddingVertical: 10, borderTopWidth: canSend || i > 0 ? 1 : 0, borderTopColor: t.appSurface.lineSoft }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: "500" }}>
                    {p.txn_amount_cents != null ? formatMoney(p.txn_amount_cents, country) : p.file_name ?? "Proof"}
                  </Text>
                  <Text style={[s.mono, { color: t.appSurface.inkFaint, marginTop: 2 }]}>
                    {[p.txn_code, new Date(p.uploaded_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })].filter(Boolean).join(" · ")}
                  </Text>
                </View>
                <View style={[s.pill, { backgroundColor: PROOF_TONE[p.status].bg }]}>
                  <Text style={[s.pillLabel, { color: PROOF_TONE[p.status].ink }]}>{PAYMENT_PROOF_LABEL[p.status]}</Text>
                </View>
              </View>
              {p.status === "rejected" && !!p.rejection_reason && <Text style={{ fontSize: 12, color: t.status.warnInk, marginTop: 4 }}>{p.rejection_reason}</Text>}
            </View>
          ))
        )}
      </View>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={s.faint}>{label}</Text>
      <Text style={[mono ? s.mono : { fontSize: 12.5 }, { flexShrink: 1, textAlign: "right", color: value ? t.appSurface.ink : t.appSurface.inkFaint }]}>{value ?? "not found"}</Text>
    </View>
  );
}
