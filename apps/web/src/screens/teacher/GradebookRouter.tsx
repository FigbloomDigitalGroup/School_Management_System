import { gradesCapabilities } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/ui/DataTable";
import { useTenantSession } from "../../lib/sessionContext";
import { GpaGradebook } from "./GpaGradebook";
import { K12Gradebook } from "./K12Gradebook";

/** One "Gradebook" nav entry, two different screens underneath — K-12's letter-grade/class-mean model vs higher-ed's credit/GPA one (FIG-330). */
export function GradebookRouter() {
  const { tenant } = useTenantSession();
  if (tenant.institution_type !== "higher_ed") return <K12Gradebook />;
  if (gradesCapabilities().gpaGradebook) return <GpaGradebook />;
  // Not on the new system yet: the API keeps one final grade per course enrolment, not a section's assessments and marks.
  return (
    <>
      <PageHead eyebrow="Gradebook" title="Gradebook" />
      <div className="px-7 py-6">
        <div className="rounded-lg border border-line bg-white">
          <EmptyState
            title="The course gradebook is not on the new system yet"
            body="A course section's assessments and marks are not in the new system. It keeps one final grade for each enrolment, and the screen for that is not built yet."
          />
        </div>
      </div>
    </>
  );
}
