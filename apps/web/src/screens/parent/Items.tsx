import { fetchLearnerInventory } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { IssuedItems } from "../../components/IssuedItems";
import { EmptyState } from "../../components/ui/DataTable";
import { useParentData } from "../../lib/parentContext";
import { useAsync } from "../../lib/useAsync";
import { ChildSwitcher } from "./ChildSwitcher";

/** The textbooks and other school property the selected child has been issued, and anything overdue. */
export function ParentItems() {
  const { child, loading: kidsLoading } = useParentData();
  const { data, loading, error } = useAsync(() => fetchLearnerInventory(child ? [child.id] : []), [child?.id]);
  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Issued items"}
        title={child ? `${child.first}'s issued items` : "Issued items"}
        blurb="Books and equipment the school has lent your child. They're due back by the date shown; lost items may need replacing."
        actions={<ChildSwitcher />}
      />
      <div className="px-7 py-6">
        {!child && !kidsLoading ? (
          <EmptyState title="No child linked" body="This account is not yet linked to a learner. Contact the school office." />
        ) : (
          <IssuedItems rows={child ? data : []} loading={loading || kidsLoading} error={error} whose={child?.first ?? "your child"} />
        )}
      </div>
    </>
  );
}
