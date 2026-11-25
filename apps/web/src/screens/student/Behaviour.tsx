import { PageHead } from "../../components/ConsoleShell";
import { LearnerBehaviour } from "../../components/behaviour/Behaviour";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useStudentData } from "../../lib/studentContext";
import { useTenantSession } from "../../lib/sessionContext";

/** The learner's own behaviour: what their parents see (merits, points, and what else the school shares). */
export function StudentBehaviour() {
  const { tenant } = useTenantSession();
  const { data, loading } = useStudentData();
  return (
    <>
      <PageHead eyebrow={data?.className ?? "School life"} title="My behaviour" blurb="Your merits and points, as your teachers record them." />
      <div className="px-7 py-6">
        {loading || !data ? <TableSkeleton rows={4} /> : <LearnerBehaviour studentId={data.studentId} tenantId={tenant.id} staff={false} />}
      </div>
    </>
  );
}
