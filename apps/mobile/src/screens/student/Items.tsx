import { accentFor } from "../../theme";
import { useStudentData } from "../../studentData";
import { IssuedItemsView } from "../../components/IssuedItems";
import { SubScreen } from "../../components/SubScreen";

/** The textbooks and equipment the school has lent this learner. */
export function StudentItems() {
  const { data, accent } = useStudentData();
  const tint = accentFor(accent).deep;
  return (
    <SubScreen tint={tint} title="My items" sub="Books and equipment the school has lent you, and when to bring them back.">
      <IssuedItemsView studentId={data.studentId} whose="you" tint={tint} />
    </SubScreen>
  );
}
