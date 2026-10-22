import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { fetchPaymentMethods, type PaymentMethods } from "@figbloom/shared";
import { s, t } from "../theme";

/**
 * The school's own ways to pay (paybill, till, bank), as its admin set them.
 * undefined while loading, null when the school hasn't set any.
 */
export function usePaymentMethods(tenantId: string): PaymentMethods | null | undefined {
  const [methods, setMethods] = useState<PaymentMethods | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetchPaymentMethods(tenantId)
      .then((m) => { if (alive) setMethods(m); })
      .catch(() => { if (alive) setMethods(null); });
    return () => { alive = false; };
  }, [tenantId]);
  return methods;
}

export function PaymentMethodsCard({ methods }: { methods: PaymentMethods }) {
  const rows: [string, string][] = [];
  if (methods.paybill) rows.push(["Paybill", methods.paybill]);
  if (methods.till) rows.push(["Till number", methods.till]);
  if (methods.bank) rows.push(["Bank", methods.bank]);

  return (
    <View style={s.card}>
      {rows.map(([label, value], i) => (
        <View key={label} style={{ paddingVertical: 10, borderBottomWidth: i === rows.length - 1 && !methods.notes ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
          <Text style={s.eyebrow}>{label.toUpperCase()}</Text>
          <Text style={[label === "Bank" ? { fontSize: 13.5 } : s.mono, { marginTop: 3 }]}>{value}</Text>
        </View>
      ))}
      {!!methods.notes && <Text style={[s.small, { paddingTop: 10, lineHeight: 18 }]}>{methods.notes}</Text>}
    </View>
  );
}
