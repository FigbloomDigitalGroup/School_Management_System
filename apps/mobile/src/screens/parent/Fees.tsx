import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatMoney, formatShortDate, itemsForStudent } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useFeeItems, useParentProfileId, useTenantId, useTermLabel } from "../../data";
import { PaymentMethodsCard, usePaymentMethods } from "../../components/PaymentMethods";
import { PaymentProofCard } from "../../components/PaymentProofCard";
import { InvoiceSignature } from "../../components/PendingSignatures";
import { ReceiptSignature } from "../../components/SignatureMark";
import { useReceiptSignatures } from "../../lib/useReceiptSignatures";
import { Tap } from "../../ui/Tap";

export function ParentFees() {
  const nav = useNavigation<any>();
  const { child, index, accent, country } = useChild();
  const feeItems = useFeeItems();
  const termLabel = useTermLabel();
  const tenantId = useTenantId();
  const profileId = useParentProfileId();
  const methods = usePaymentMethods(tenantId);
  const items = itemsForStudent(feeItems as never, { boarding: child.boarding }, child.formLevel, child.classLevel);
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const receiptSigs = useReceiptSignatures(child.receipts.map((r) => r.id));
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

        {!!child.invoiceId && <InvoiceSignature invoiceId={child.invoiceId} />}

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
          {child.charges.length > 0 && (
            <View style={{ borderTopWidth: items.length ? 1 : 0, borderTopColor: t.appSurface.line, marginTop: items.length ? 4 : 0 }}>
              <Text style={[s.eyebrow, { paddingTop: 12, paddingBottom: 2 }]}>CHARGES ADDED THIS TERM</Text>
              {child.charges.map((c, idx) => (
                <View key={c.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12, paddingVertical: 10, borderBottomWidth: idx === child.charges.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
                  <Text style={{ flex: 1, fontSize: 13 }}>
                    {c.reason}
                    <Text style={s.faint}>{"  "}{formatShortDate(c.createdAt.slice(0, 10))}</Text>
                  </Text>
                  <Text style={s.mono}>{formatMoney(c.amountCents, country)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Receipts</Text>
        <View style={s.card}>
          {child.receipts.length === 0 ? (
            <Text style={[s.faint, { paddingVertical: 10 }]}>Payments appear here once the school has confirmed them.</Text>
          ) : (
            child.receipts.map((r, i) => (
              <View key={r.id} style={{ paddingVertical: 11, borderBottomWidth: i === child.receipts.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View>
                    <Text style={{ fontSize: 13, fontWeight: "500" }}>{formatMoney(r.amount, country)}</Text>
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

        {!!methods && child.balance > 0 && (
          <>
            <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>How to pay</Text>
            <PaymentMethodsCard methods={methods} />
          </>
        )}

        {!!child.invoiceId && (
          <PaymentProofCard
            tenantId={tenantId}
            invoiceId={child.invoiceId}
            uploadedBy={profileId}
            balanceCents={child.balance}
            country={country}
            school={{ paybill: methods?.paybill ?? null, till: methods?.till ?? null }}
            tint={tint}
            canSend={child.balance > 0}
          />
        )}

        {child.balance > 0 && (
          <Tap onPress={() => nav.navigate("Pay")} style={[s.primary, { backgroundColor: tint, marginTop: 20 }]}>
            <Text style={s.primaryLabel}>Pay {formatMoney(child.balance, country)}</Text>
          </Tap>
        )}
      </ScrollView>
    </View>
  );
}
