import { useState } from "react";
import { fetchEnrollmentsForSection, fetchInstructorSections, type EnrolledStudentRow, type InstructorSectionRow } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/**
 * "My sections" — the higher-ed equivalent of teacher/Classes.tsx. Simpler
 * than that screen's dual class_teacher_id/teaching_assignments union: a
 * lecturer's sections are just course_sections where instructor_id is them,
 * since higher-ed has no homeroom-owner concept to also account for.
 */
export function TeacherMySections() {
  const { profile, tenant } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchInstructorSections(tenant.id, profile.id), [tenant.id, profile.id]);
  const [rosterFor, setRosterFor] = useState<InstructorSectionRow | null>(null);

  return (
    <>
      <PageHead
        eyebrow="Teaching"
        title="My sections"
        blurb={data ? `${data.length} section${data.length === 1 ? "" : "s"} you teach.` : "Loading your sections…"}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load your sections: {error.message}
          </p>
        ) : loading || !data ? (
          <TableSkeleton rows={6} />
        ) : (
          <DataTable
            columns={[
              { key: "course", header: "Course", width: "1.6fr", render: (s: InstructorSectionRow) => <Cell sub={s.course_code}>{s.course_name}</Cell> },
              { key: "section", header: "Section", render: (s: InstructorSectionRow) => <Mono>{s.section_label}</Mono> },
              { key: "semester", header: "Semester", width: "1.2fr", render: (s: InstructorSectionRow) => <span className="text-[13px]">{s.semester_name}</span> },
              { key: "room", header: "Room", render: (s: InstructorSectionRow) => <span className="text-[13px]">{s.room ?? "—"}</span> },
              { key: "enrolled", header: "Enrolled", align: "right", render: (s: InstructorSectionRow) => <Mono>{s.enrolled_count}{s.capacity ? ` / ${s.capacity}` : ""}</Mono> },
              {
                key: "actions", header: "", align: "right",
                render: (s: InstructorSectionRow) => (
                  <button type="button" onClick={() => setRosterFor(s)} className="text-[12px] font-semibold text-leaf hover:underline">
                    Roster
                  </button>
                ),
              },
            ]}
            rows={data}
            rowKey={(s) => s.id}
            minWidth="820px"
            empty={{ title: "No sections assigned yet.", body: "Ask the school office to assign you to a course section." }}
          />
        )}
      </div>

      {rosterFor && <SectionRosterModal section={rosterFor} onClose={() => setRosterFor(null)} />}
    </>
  );
}

/** Read-only — a lecturer sees who's enrolled but manages the roster through the office, same as attendance/gradebook. */
function SectionRosterModal({ section, onClose }: { section: InstructorSectionRow; onClose: () => void }) {
  const { data, loading } = useAsync(() => fetchEnrollmentsForSection(section.id), [section.id]);
  const enrolled = (data ?? []).filter((r) => r.status === "enrolled");

  return (
    <Modal open onClose={onClose} eyebrow="Roster" title={`${section.course_code} ${section.section_label}`} actions={<Button onClick={onClose}>Close</Button>}>
      {loading || !data ? (
        <p className="text-[12.5px] text-ink-faint">Loading…</p>
      ) : enrolled.length === 0 ? (
        <p className="text-[12.5px] text-ink-faint">No one enrolled yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          {enrolled.map((r: EnrolledStudentRow) => (
            <div key={r.enrollment_id} className="border-b border-line-soft px-3.5 py-2 last:border-0">
              <Cell sub={`ADM ${r.admission_no}`}>{r.full_name}</Cell>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
