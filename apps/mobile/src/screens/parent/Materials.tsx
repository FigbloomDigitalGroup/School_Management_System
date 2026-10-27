import { accentFor } from "../../theme";
import { useChild, useChildren } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { MaterialsScreen } from "../student/Materials";

/** The selected child's class materials, opened from the Home card: the same list the child sees. */
export function ParentMaterials() {
  const { child, index, setIndex, accent } = useChild();
  const kids = useChildren();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  return (
    <MaterialsScreen
      classId={child.classId || null}
      tint={tint}
      title={`${child.first}'s learning materials`}
      sub={child.cls}
      emptyText={`When ${child.first}'s teachers share notes, worksheets or videos with the class, they'll be here.`}
      headerRight={<ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />}
    />
  );
}
