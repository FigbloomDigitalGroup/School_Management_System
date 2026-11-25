import { PageHead } from "../../components/ConsoleShell";
import { LearnerBehaviour } from "../../components/behaviour/Behaviour";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { ChildSwitcher } from "./ChildSwitcher";

/**
 * The selected child's behaviour: their points this period and what the school shares with families
 * (merits always; demerits and incidents when the school turns them on; staff-only notes never).
 */
export function ParentBehaviour() {
  const { tenant } = useTenantSession();
  const { child, loading } = useParentData();
  return (
    <>
      <PageHead eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Behaviour"} title={child ? `${child.first}'s behaviour` : "Behaviour"}
        blurb="Merits and points from your child's teachers, and what else the school shares with families."
        actions={<ChildSwitcher />} />
      <div className="px-7 py-6">
        {loading ? <TableSkeleton rows={4} /> : child ? (
          <LearnerBehaviour studentId={child.id} tenantId={tenant.id} staff={false} firstName={child.first} />
        ) : <p className="text-[13px] text-ink-muted">No child is linked to your account yet.</p>}
      </div>
    </>
  );
}
