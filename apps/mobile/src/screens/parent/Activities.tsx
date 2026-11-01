import { accentFor } from "../../theme";
import { useChild, useChildren, useTenantId } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { LearnerActivitiesView } from "../../components/LearnerActivities";
import { SubScreen } from "../../components/SubScreen";

/** The selected child's clubs and teams, their upcoming fixtures and trips, and what they've won. */
export function ParentActivities() {
  const { child, index, setIndex, accent } = useChild();
  const kids = useChildren();
  const tenantId = useTenantId();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  return (
    <SubScreen
      tint={tint}
      title={`${child.first}'s sports & activities`}
      sub={child.cls}
      headerRight={<ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />}
    >
      <LearnerActivitiesView key={child.id} tenantId={tenantId} studentId={child.id} first={child.first} tint={tint} />
    </SubScreen>
  );
}
