import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { itemsForStudent } from "@figbloom/shared";
import { accentFor } from "../../theme";
import { useChild, useFeeItems, useParentProfileId, useTenantId, useTermLabel } from "../../data";
import { FeesView } from "../../components/FeesView";
import { InvoiceSignature } from "../../components/PendingSignatures";
import { useTheme } from "../../ui/ThemeContext";

export function ParentFees() {
  const { s } = useTheme();
  const nav = useNavigation<any>();
  const { child, index, accent, country } = useChild();
  const feeItems = useFeeItems();
  const termLabel = useTermLabel();
  const tenantId = useTenantId();
  const profileId = useParentProfileId();
  const items = itemsForStudent(feeItems as never, { boarding: child.boarding }, child.formLevel, child.classLevel);
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>Fees</Text>
        <Text style={s.headerSub}>{child.name}{termLabel ? ` · ${termLabel}` : ""}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <FeesView
          tint={tint}
          country={country}
          tenantId={tenantId}
          uploadedBy={profileId}
          balance={child.balance}
          billed={child.billed}
          dueOn={child.dueOn}
          items={items}
          charges={child.charges}
          receipts={child.receipts}
          invoiceId={child.invoiceId}
          afterBalance={!!child.invoiceId && <InvoiceSignature invoiceId={child.invoiceId} />}
          onPay={() => nav.navigate("Pay")}
        />
      </ScrollView>
    </View>
  );
}
