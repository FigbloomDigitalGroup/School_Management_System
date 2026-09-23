import { useNavigate } from "react-router-dom";
import { fetchMyClasses, type MyClassRow } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * "My classes" — the roster a teacher is actually assigned to, whether as
 * class teacher or a subject teacher, with one tap through to the two things
 * they'd come here to do next: take attendance or open the gradebook.
 */
export function TeacherClasses() {
  const { profile } = useTenantSession();
  const navigate = useNavigate();
  const { data, loading, error } = useAsync(() => fetchMyClasses(profile.id), [profile.id]);

  return (
    <>
      <PageHead
        eyebrow="Teaching"
        title="My classes"
        blurb={data ? `${data.length} class${data.length === 1 ? "" : "es"} you teach or lead.` : "Loading your classes…"}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your classes: {error.message}
          </p>
        ) : loading || !data ? (
          <TableSkeleton rows={6} />
        ) : (
          <DataTable
            columns={[
              { key: "name", header: "Class", width: "1.4fr", render: (c: MyClassRow) => <Cell sub={c.stream ?? undefined}>{c.name}</Cell> },
              {
                key: "role", header: "Your role",
                render: (c: MyClassRow) => c.class_teacher_id === profile.id
                  ? <Badge tone="ok">Class teacher</Badge>
                  : <Badge tone="muted">Subject teacher</Badge>,
              },
              {
                key: "subjects", header: "Subjects you teach here", width: "1.6fr",
                render: (c: MyClassRow) => c.subjects.length
                  ? <span className="text-[13px]">{c.subjects.join(", ")}</span>
                  : <span className="text-[12.5px] text-ink-faint">None assigned</span>,
              },
              { key: "learners", header: "Learners", align: "right", render: (c: MyClassRow) => <Mono>{c.learnerCount}</Mono> },
              {
                key: "actions", header: "", align: "right", width: "1.2fr",
                render: (c: MyClassRow) => (
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => navigate(`../teacher/attendance?class=${c.id}`)}>Attendance</Button>
                    <Button onClick={() => navigate(`../teacher/gradebook?class=${c.id}`)}>Gradebook</Button>
                  </div>
                ),
              },
            ]}
            rows={data}
            rowKey={(c) => c.id}
            minWidth="760px"
            empty={{ title: "No classes assigned yet.", body: "Ask the school office to assign you as a class teacher or to a subject." }}
          />
        )}
      </div>
    </>
  );
}
