import { accentFor } from "../../theme";
import { useStudentData } from "../../studentData";
import { PayFlow } from "../../components/PayFlow";

/** What the Fees screen hands over: the learner's own balance, read there. Plain values, so they can travel as route params. */
export interface StudentPayParams {
  name: string;
  context: string;
  balance: number;
  invoiceId: string | null;
}

/**
 * A learner paying their own fees (an adult at a college or university has no guardian to do it). The Fees
 * screen reads the balance again when it comes back into view, so nothing needs reloading from here.
 */
export function StudentPay({ route }: { route: { params?: StudentPayParams } }) {
  const { accent, country, tenantId } = useStudentData();
  const p = route.params;
  if (!p) return null;
  return (
    <PayFlow
      target={{
        name: p.name,
        context: p.context,
        possessive: "your",
        balance: p.balance,
        invoiceId: p.invoiceId,
        country,
        tint: accentFor(accent).deep,
        tenantId,
        onSettled: () => {},
      }}
    />
  );
}
