import { PageHead } from "../../components/ConsoleShell";
import { LearnerActivitiesView } from "../../components/learners/Activities";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { ChildSwitcher } from "./ChildSwitcher";

/** The selected child's clubs and teams, their upcoming fixtures and trips, and what they've won. */
export function ParentActivities() {
  const { tenant } = useTenantSession();
  const { child, loading } = useParentData();

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Sports & activities"}
        title={child ? `${child.first}'s sports & activities` : "Sports & activities"}
        blurb="Clubs, teams and societies, fixtures and competitions coming up, and medals and awards."
        actions={<ChildSwitcher />}
      />
      <div className="px-7 py-6">
        {loading ? (
          <TableSkeleton rows={4} />
        ) : !child ? (
          <EmptyState title="No child linked" body="This account is not yet linked to a learner. Contact the school office." />
        ) : (
          <LearnerActivitiesView key={child.id} tenantId={tenant.id} studentId={child.id} first={child.first} />
        )}
      </div>
    </>
  );
}
