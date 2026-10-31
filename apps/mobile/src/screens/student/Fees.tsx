import { useCallback, useState } from "react";
import { ActivityIndicator } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { itemsForStudent, loadStudentFeeData, type StudentFeeData } from "@figbloom/shared";
import { accentFor } from "../../theme";
import { useStudentData } from "../../studentData";
import { FeesView } from "../../components/FeesView";
import { SubScreen } from "../../components/SubScreen";
import { EmptyState, ErrorState } from "../../ui/StateView";
import type { StudentPayParams } from "./Pay";
import { useTheme } from "../../ui/ThemeContext";

type State = { kind: "loading" } | { kind: "failed" } | { kind: "none" } | { kind: "ready"; fees: StudentFeeData };

/**
 * A learner's own fees: what they owe this term, what it covers, receipts and
 * how to pay, with the same Pay flow a parent has. For a learner with no
 * guardian on file (an adult at a college or university) this is the only way
 * to see the balance and settle it; for anyone else it shows what their family
 * sees. Read again each time the screen comes back into view, since paying
 * happens on a screen above this one.
 */
export function StudentFees() {
  const { accentInk } = useTheme();
  const nav = useNavigation<any>();
  const { accent, country, tenantId, profileId } = useStudentData();
  const tint = accentFor(accent).deep;
  const [state, setState] = useState<State>({ kind: "loading" });

  const read = useCallback(() => {
    let alive = true;
    loadStudentFeeData(profileId)
      .then((fees) => { if (alive) setState(fees ? { kind: "ready", fees } : { kind: "none" }); })
      // A failed re-read must not blank what is already on screen.
      .catch(() => { if (alive) setState((s) => (s.kind === "ready" ? s : { kind: "failed" })); });
    return () => { alive = false; };
  }, [profileId]);
  useFocusEffect(read);

  const fees = state.kind === "ready" ? state.fees : null;
  const pay = (f: StudentFeeData) => {
    const params: StudentPayParams = { name: f.name, context: f.className || "No class", balance: f.balance, invoiceId: f.invoiceId };
    nav.navigate("Pay", params);
  };

  return (
    <SubScreen
      tint={tint}
      title="Fees"
      sub={fees ? `${fees.name}${fees.termLabel ? ` · ${fees.termLabel}` : ""}` : "Your balance, what the term covers and your receipts"}
    >
      {state.kind === "loading" ? (
        <ActivityIndicator color={accentInk(tint)} style={{ marginTop: 24 }} />
      ) : state.kind === "failed" ? (
        <ErrorState title="Couldn't load your fees" onRetry={() => { setState({ kind: "loading" }); read(); }} />
      ) : !fees ? (
        <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
      ) : (
        <FeesView
          tint={tint}
          country={country}
          tenantId={tenantId}
          uploadedBy={profileId}
          balance={fees.balance}
          billed={fees.billed}
          dueOn={fees.dueOn}
          items={itemsForStudent(fees.feeItems as never, { boarding: fees.boarding }, fees.formLevel, fees.classLevel)}
          charges={fees.charges}
          receipts={fees.receipts}
          invoiceId={fees.invoiceId}
          onPay={() => pay(fees)}
        />
      )}
    </SubScreen>
  );
}
