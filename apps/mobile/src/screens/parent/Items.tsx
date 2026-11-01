import { accentFor } from "../../theme";
import { useChild, useChildren } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { IssuedItemsView } from "../../components/IssuedItems";
import { SubScreen } from "../../components/SubScreen";

/** The textbooks and other school property the selected child has been issued, and anything overdue. */
export function ParentItems() {
  const { child, index, setIndex, accent } = useChild();
  const kids = useChildren();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  return (
    <SubScreen
      tint={tint}
      title={`${child.first}'s issued items`}
      sub="Books and equipment the school has lent them"
      headerRight={<ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />}
    >
      <IssuedItemsView key={child.id} holder={{ kind: "learner", studentId: child.id }} whose={child.first} tint={tint} />
    </SubScreen>
  );
}
