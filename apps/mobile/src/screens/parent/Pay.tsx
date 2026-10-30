import { accentFor } from "../../theme";
import { useChild, useReloadParentData, useTenantId } from "../../data";
import { PayFlow } from "../../components/PayFlow";

/** A parent paying the selected child's balance; the flow itself is shared with a learner paying their own (components/PayFlow.tsx). */
export function ParentPay() {
  const { child, index, accent, country } = useChild();
  const reload = useReloadParentData();
  const tenantId = useTenantId();
  const a = accentFor(accent);
  return (
    <PayFlow
      target={{
        name: child.name,
        context: child.cls,
        possessive: `${child.first}'s`,
        balance: child.balance,
        invoiceId: child.invoiceId,
        country,
        tint: index === 0 ? a.deep : a.hex,
        tenantId,
        onSettled: reload,
      }}
    />
  );
}
