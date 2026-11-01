import { accentFor } from "../../theme";
import { useStudentData } from "../../studentData";
import { LearnerActivitiesView } from "../../components/LearnerActivities";
import { SubScreen } from "../../components/SubScreen";

/** The learner's own clubs and teams, what's coming up, and what they've won. */
export function StudentActivities() {
  const { data, accent, tenantId } = useStudentData();
  const tint = accentFor(accent).deep;
  return (
    <SubScreen tint={tint} title="Sports & activities" sub="Your clubs and teams, what's coming up, and what you've won.">
      <LearnerActivitiesView tenantId={tenantId} studentId={data.studentId} first={null} tint={tint} />
    </SubScreen>
  );
}
