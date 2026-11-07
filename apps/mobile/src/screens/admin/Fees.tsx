import { useCallback, useState } from "react";
import { Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import {
  PAYMENT_SMS_FLAG_LABEL, REJECT_REASONS, balanceStanding, feeFigures, fetchFeesCollection, formatMoney, formatShortDate, privateDocumentUrl, proofFlags, proofToConfirm,
  rejectPaymentProof, rejectionReason, type PayableInvoice, type PendingProof, type ProofToConfirm,
} from "@figbloom/shared";
import { Section, Stat } from "../../components/AdminCards";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { takeRecordedPayment } from "../../lib/recordedPayment";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

/** What the form to record a payment opens with: the term, and the invoice (and the proof being confirmed) when there is one. */
export interface RecordPaymentParams { termId: string; invoice?: PayableInvoice; proof?: ProofToConfirm }

/** What the last thing done here did, said at the top until the next one. */
type Outcome = { kind: "done" | "failed"; text: string };

/**
 * The bursar's fees away from the desk: how the term is going, the balances that matter most with a way to record a
 * payment against each, money received outside the M-Pesa prompt, and the proof families upload (confirm it by
 * recording the payment it shows, or reject it with the reason the family will read). Setting the fee items, billing the
 * term and signing invoices are on the web console. The database checks every payment again (record_payment).
 */
export function Fees({ session, onRecord }: { session: StaffSession; onRecord: (params: RecordPaymentParams) => void }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => fetchFeesCollection(session.tenantId), session.tenantId);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Proofs rejected from this screen, left out of the list until the next read has them gone. */
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const country = session.country;

  // Back from recording a payment: say so, and read the term again (the balance moved, a confirmed proof is gone).
  useFocusEffect(useCallback(() => {
    const note = takeRecordedPayment();
    if (!note) return;
    setOutcome({ kind: "done", text: note });
    void refresh();
  }, [refresh]));

  const figures = feeFigures(data?.invoices ?? []);
  const termId = data?.term?.id ?? null;
  const proofs = (data?.pendingProofs ?? []).filter((p) => !reviewed.has(p.id));

  async function reject(proof: PendingProof) {
    setBusyId(proof.id);
    setOutcome(null);
    try {
      await rejectPaymentProof({ proofId: proof.id, reviewerId: session.profileId, reason });
      setReviewed((r) => new Set(r).add(proof.id));
      setRejecting(null);
      setReason("");
      setOutcome({ kind: "done", text: `Payment proof rejected. ${proof.studentName}'s family will see the reason.` });
      void refresh();
    } catch (err) {
      setOutcome({ kind: "failed", text: `Could not update: ${err instanceof Error ? err.message : "try again."}` });
    } finally {
      setBusyId(null);
    }
  }

  async function openProof(path: string) {
    try {
      await Linking.openURL(await privateDocumentUrl(path));
    } catch (err) {
      setOutcome({ kind: "failed", text: err instanceof Error ? err.message : "Could not open that file." });
    }
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Fees" sub={data?.term ? data.term.name : "Collection and payments"} color={a.deep} back />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {outcome && (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{
              borderWidth: 1, borderRadius: t.radius.lg, padding: 12, marginBottom: 14,
              borderColor: outcome.kind === "done" ? t.status.okDot : t.status.badLine,
              backgroundColor: outcome.kind === "done" ? t.status.okBg : t.status.badBg,
            }}
          >
            <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: outcome.kind === "done" ? t.status.okInk : t.status.badInk }}>{outcome.text}</Text>
          </View>
        )}

        {error && !data ? (
          <ErrorState title="Couldn't load fees" body={error} onRetry={retry} />
        ) : loading || !data ? (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[s.card, { flexBasis: "47%", flexGrow: 1, padding: 14, gap: 8 }]}>
                  <Skeleton width="50%" height={11} />
                  <Skeleton width="40%" height={22} />
                </View>
              ))}
            </View>
          </View>
        ) : !data.term || !termId ? (
          <EmptyState title="No term is open" body="Fees follow the term. Once a term is current, what is billed and collected shows here." />
        ) : (
          <>
            {!!error && <Text style={[s.faint, { marginBottom: 8 }]}>Couldn't refresh: {error}</Text>}
            {data.invoices.length === 0 && (
              <View style={[s.card, { marginBottom: 12 }]}>
                <Text style={s.small}>No invoices yet for {data.term.name}. Parents see nothing owing until learners are billed, which is done on the web console.</Text>
              </View>
            )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <Stat label="Billed this term" value={formatMoney(figures.billed, country)} sub={`${data.invoices.length.toLocaleString()} learners`} />
              <Stat label="Collected" value={formatMoney(figures.collected, country)} sub={`${figures.collectedPct}% of billed`} />
              <Stat label="Outstanding" value={formatMoney(figures.outstandingTotal, country)} sub={`${figures.owingCount.toLocaleString()} learners owe a balance`} />
              <Stat label="Fully paid" value={`${figures.fullyPaidPct}%`} sub={`${figures.fullyPaidCount.toLocaleString()} invoices cleared`} />
            </View>

            <Button label="Record a payment" onPress={() => onRecord({ termId })} style={{ marginTop: 14 }} />

            <Section title="Largest outstanding balances">
              {data.outstanding.length === 0 ? (
                <EmptyState title="Every balance is cleared" body="Nothing outstanding this term." />
              ) : data.outstanding.map((r) => (
                <View key={r.id} style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{r.name}</Text>
                      <Text style={s.faint}>{r.cls}</Text>
                    </View>
                    <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: t.status.warnInk }}>{formatMoney(r.billed - r.paid, country)}</Text>
                  </View>
                  <Text style={[s.faint, { marginTop: 2 }]}>
                    Billed {formatMoney(r.billed, country)}{r.charges > 0 ? ` (incl. ${formatMoney(r.charges, country)} charges)` : ""} · Paid {formatMoney(r.paid, country)} · {balanceStanding(r)}
                  </Text>
                  <Button
                    variant="secondary" label="Record payment" accessibilityHint={`Records a payment for ${r.name}`}
                    onPress={() => onRecord({ termId, invoice: { id: r.id, studentName: r.name, cls: r.cls, balanceCents: r.billed - r.paid } })}
                    style={{ marginTop: 8, alignSelf: "flex-start" }}
                  />
                </View>
              ))}
            </Section>

            <Section title="Payment proof awaiting review">
              {proofs.length === 0 ? (
                <EmptyState title="Nothing to review" body="Bank slips, pasted M-Pesa messages and other payment evidence parents send will appear here for confirmation." />
              ) : proofs.map((p) => {
                const flags = proofFlags(p, data.school);
                const path = p.file_path;
                const open = rejecting === p.id;
                return (
                  <View key={p.id} accessibilityLabel={`Payment proof from ${p.studentName}`} style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{p.studentName}</Text>
                        <Text style={s.faint}>{p.cls}</Text>
                      </View>
                      <Text style={s.faint}>{formatShortDate(p.uploaded_at.slice(0, 10))}</Text>
                    </View>
                    {!!p.txn_code && (
                      <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink, marginTop: 6 }}>
                        {p.txn_code}{p.txn_amount_cents !== null ? ` · ${formatMoney(p.txn_amount_cents, country)}` : ""}
                      </Text>
                    )}
                    {!!p.sms_text && <Text style={[s.faint, { marginTop: 4 }]}>{p.sms_text}</Text>}
                    {flags.length > 0 && (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                        {flags.map((f) => (
                          <View key={f} style={[s.pill, { backgroundColor: t.brand.orangeSoft }]}>
                            <Text style={[s.pillLabel, { color: t.brand.orangeInk }]}>{PAYMENT_SMS_FLAG_LABEL[f]}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                    {!!path && <Button variant="quiet" label={`View ${p.file_name ?? "the file"}`} onPress={() => void openProof(path)} style={{ alignSelf: "flex-start", marginTop: 4 }} />}
                    {!!p.note && <Text style={[s.faint, { marginTop: 4 }]}>Note: {p.note}</Text>}

                    {open ? (
                      <View style={{ marginTop: 10, gap: 8 }}>
                        <Text style={s.small}>{p.studentName}'s family will see this reason, and can send the proof again if it was a mistake.</Text>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          {REJECT_REASONS.map((r) => (
                            <Tap
                              key={r} accessibilityRole="button" onPress={() => setReason(r)}
                              style={{ borderRadius: 999, borderWidth: 1, borderColor: t.appSurface.line, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: reason === r ? t.appSurface.lineSoft : "transparent" }}
                            >
                              <Text style={{ fontSize: fontSize.small, color: t.appSurface.ink }}>{r}</Text>
                            </Tap>
                          ))}
                        </View>
                        <Field label="Reason" value={reason} onChangeText={setReason} maxLength={300} accessibilityLabel={`Reason for rejecting ${p.studentName}'s proof`} />
                        <View style={{ flexDirection: "row", gap: 10 }}>
                          <Button variant="secondary" label="Cancel" disabled={busyId !== null} onPress={() => { setRejecting(null); setReason(""); }} style={{ flex: 1 }} />
                          <Button label="Reject proof" loading={busyId === p.id} disabled={busyId !== null || rejectionReason(reason) === null} onPress={() => void reject(p)} style={{ flex: 1 }} />
                        </View>
                      </View>
                    ) : (
                      <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                        <Button variant="secondary" label="Reject" disabled={busyId !== null} onPress={() => { setRejecting(p.id); setReason(""); }} style={{ flex: 1 }} />
                        <Button
                          label="Confirm" disabled={!p.invoice || busyId !== null} accessibilityHint="Opens the payment form with what the proof shows"
                          onPress={() => p.invoice && onRecord({ termId, invoice: p.invoice, proof: proofToConfirm(p) })} style={{ flex: 1 }}
                        />
                      </View>
                    )}
                  </View>
                );
              })}
            </Section>

            {data.overpaid.length > 0 && (
              <Section title="Paid more than was owed">
                {data.overpaid.map((r) => (
                  <View key={r.id} style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{r.students?.full_name ?? "Unknown learner"}</Text>
                        <Text style={s.faint}>{r.students?.classes?.name ?? "—"} · {r.terms?.name ?? "—"}</Text>
                      </View>
                      <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: t.status.warnInk }}>{formatMoney(r.overpaid_cents, country)}</Text>
                    </View>
                    <Text style={[s.faint, { marginTop: 2 }]}>Billed {formatMoney(r.total_cents, country)} · Paid {formatMoney(r.paid_cents, country)} · owed back</Text>
                  </View>
                ))}
                <Text style={[s.faint, { padding: 14 }]}>
                  Two payments crossed (cash at the desk while an M-Pesa prompt was waiting), or a charge was cancelled after the invoice was paid. Refund the family or agree to carry it forward.
                </Text>
              </Section>
            )}

            <Text style={[s.faint, { marginTop: 16 }]}>Fee items, billing the term and signing invoices are on the web console, with the same login.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
