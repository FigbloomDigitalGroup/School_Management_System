import { PageHead } from "../../components/ConsoleShell";
import { LearnerActivitiesView } from "../../components/learners/Activities";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import { useStudentData } from "../../lib/studentContext";

export function StudentActivities() {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useStudentData();

  return (
    <>
      <PageHead eyebrow="Sports & activities" title="Sports & activities" blurb="Your clubs and teams, what's coming up, and what you've won." />
      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your record: {error.message}
          </p>
        ) : loading || !data ? (
          <TableSkeleton rows={4} />
        ) : (
          <LearnerActivitiesView tenantId={tenant.id} studentId={data.studentId} first={null} />
        )}
      </div>
    </>
  );
}
