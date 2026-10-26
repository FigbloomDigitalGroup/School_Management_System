import { PageHead } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useParentData } from "../../lib/parentContext";
import { ClassMaterials } from "../student/Materials";
import { ChildSwitcher } from "./ChildSwitcher";

/** The selected child's class materials: what the teachers have shared, by subject, the same list the child sees. */
export function ParentMaterials() {
  const { child, loading } = useParentData();

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Learning materials"}
        title={child ? `${child.first}'s learning materials` : "Learning materials"}
        blurb="Notes, worksheets and videos the teachers have shared with the class."
        actions={<ChildSwitcher />}
      />
      <div className="px-7 py-6">
        {loading ? (
          <TableSkeleton rows={4} />
        ) : !child ? (
          <EmptyState title="No child linked" body="This account is not yet linked to a learner. Contact the school office." />
        ) : (
          <ClassMaterials classId={child.classId} emptyBody={`When ${child.first}'s teachers share notes, worksheets or videos with the class, they'll be here.`} />
        )}
      </div>
    </>
  );
}
