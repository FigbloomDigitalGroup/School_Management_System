import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { formatMoney, formatShortDate, type FeeCharge, type FeeItem, type Receipt } from "@figbloom/shared";
import { useReceiptSignatures } from "../lib/useReceiptSignatures";
import { Button } from "../ui/Button";
import { PaymentMethodsCard, usePaymentMethods } from "./PaymentMethods";
import { PaymentProofCard } from "./PaymentProofCard";
import { ReceiptSignature } from "./SignatureMark";
import { useTheme } from "../ui/ThemeContext";

/**
 * One term's fees as the family or the learner sees them: what is owed, what
 * the term covers, receipts (with the bursar's signature), how to pay, the
 * payment-proof form and the pay button. The parent's Fees tab and a
 * learner's own Fees screen both show exactly this; each supplies the data and
 * what pressing Pay does. `afterBalance` is for what only one of them has (a
 * guardian's invoice signature).
 */
export function FeesView({ tint, country, tenantId, uploadedBy, balance, billed, dueOn, items, charges, receipts, invoiceId, afterBalance, onPay }: {
  tint: string;
  country: string;
  tenantId: string;
  /** Whose profile a payment proof is filed under. */
  uploadedBy: string;
  /** Still owed, charges included. */
  balance: number;
  /** The invoice total. */
  billed: number;
  dueOn: string | null;
  items: FeeItem[];
  charges: FeeCharge[];
  receipts: Receipt[];
  /** This term's invoice; null until the school has billed. */
  invoiceId: string | null;
  afterBalance?: ReactNode;
  onPay: () => void;
}) {
  const { t, s, accentInk } = useTheme();
  const methods = usePaymentMethods(tenantId);
  const receiptSigs = useReceiptSignatures(receipts.map((r) => r.id));
  const paid = billed - balance;
  const paidPct = billed > 0 ? (paid / billed) * 100 : 0;

  return (
    <>
      <View style={s.card}>
        <Text style={s.eyebrow}>BALANCE</Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
          <Text style={{ color: t.appSurface.ink, fontSize: 26, fontWeight: "700" }}>{formatMoney(balance, country)}</Text>
          <Text style={s.small}>{dueOn ? `due ${formatShortDate(dueOn)}` : "nothing due"}</Text>
        </View>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: t.appSurface.lineSoft, marginTop: 12, overflow: "hidden" }}>
          <View style={{ height: 8, borderRadius: 4, width: `${paidPct}%`, backgroundColor: accentInk(tint) }} />
        </View>
        <Text style={[s.faint, { marginTop: 8 }]}>{formatMoney(paid, country)} paid of {formatMoney(billed, country)}</Text>
      </View>

      {afterBalance}

      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>What this term covers</Text>
      <View style={s.card}>
        {items.length === 0 ? (
          <Text style={[s.faint, { paddingVertical: 10 }]}>Fee structure not published yet.</Text>
        ) : (
          items.map((i, idx) => (
            <View key={i.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: idx === items.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
              <Text style={{ color: t.appSurface.ink, fontSize: 13 }}>{i.name}</Text>
              <Text style={[s.mono, { color: t.appSurface.ink }]}>{formatMoney(i.amount_cents, country)}</Text>
            </View>
          ))
        )}
        {charges.length > 0 && (
          <View style={{ borderTopWidth: items.length ? 1 : 0, borderTopColor: t.appSurface.line, marginTop: items.length ? 4 : 0 }}>
            <Text style={[s.eyebrow, { paddingTop: 12, paddingBottom: 2 }]}>CHARGES ADDED THIS TERM</Text>
            {charges.map((c, idx) => (
              <View key={c.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12, paddingVertical: 10, borderBottomWidth: idx === charges.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
                <Text style={{ color: t.appSurface.ink, flex: 1, fontSize: 13 }}>
                  {c.reason}
                  <Text style={s.faint}>{"  "}{formatShortDate(c.createdAt.slice(0, 10))}</Text>
                </Text>
                <Text style={[s.mono, { color: t.appSurface.ink }]}>{formatMoney(c.amountCents, country)}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Receipts</Text>
      <View style={s.card}>
        {receipts.length === 0 ? (
          <Text style={[s.faint, { paddingVertical: 10 }]}>Payments appear here once the school has confirmed them.</Text>
        ) : (
          receipts.map((r, i) => (
            <View key={r.id} style={{ paddingVertical: 11, borderBottomWidth: i === receipts.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View>
                  <Text style={{ color: t.appSurface.ink, fontSize: 13, fontWeight: "500" }}>{formatMoney(r.amount, country)}</Text>
                  <Text style={[s.mono, { color: t.appSurface.inkFaint, marginTop: 2 }]}>{r.when} · {r.ref}</Text>
                </View>
                <View style={[s.pill, { backgroundColor: t.status.okBg }]}>
                  <Text style={[s.pillLabel, { color: t.status.okInk }]}>Received</Text>
                </View>
              </View>
              {receiptSigs && <ReceiptSignature signature={receiptSigs.get(r.id)} />}
            </View>
          ))
        )}
      </View>

      {!!methods && balance > 0 && (
        <>
          <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>How to pay</Text>
          <PaymentMethodsCard methods={methods} />
        </>
      )}

      {!!invoiceId && (
        <PaymentProofCard
          tenantId={tenantId}
          invoiceId={invoiceId}
          uploadedBy={uploadedBy}
          balanceCents={balance}
          country={country}
          school={{ paybill: methods?.paybill ?? null, till: methods?.till ?? null }}
          tint={tint}
          canSend={balance > 0}
        />
      )}

      {balance > 0 && <Button label={`Pay ${formatMoney(balance, country)}`} tint={tint} onPress={onPay} style={{ marginTop: 20 }} />}
    </>
  );
}
