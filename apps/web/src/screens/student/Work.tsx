import { useRef, useState } from "react";
import { formatDueLabel, type WorkItem } from "../../lib/studentData";
import { useStudentData } from "../../lib/studentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { uploadAssignmentSubmission } from "../../lib/uploads";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { TableSkeleton } from "../../components/ui/Skeleton";

type Tab = "To do" | "Done";

const STATE_TONE: Record<WorkItem["state"], Tone> = { open: "muted", late: "warn", done: "ok" };
const STATE_LABEL: Record<WorkItem["state"], string> = { open: "Open", late: "Overdue", done: "Done" };

/**
 * "Mark as handed in" mirrors StudentApp.tsx (the phone preview): it flips
 * local component state, same as before. Attaching a file goes further —
 * it uploads to the private-documents bucket via uploadAssignmentSubmission
 * and upserts assignment_submissions.file_path/file_name for real, then
 * flips the same local "done" state (a submitted file counts as handed in).
 */
export function StudentWork() {
  const { data, loading, error } = useStudentData();
  const { tenant } = useTenantSession();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("To do");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [attached, setAttached] = useState<Record<string, string>>({});

  if (error) {
    return (
      <>
        <PageHead eyebrow="Work" title="Work" />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load work: {error.message}
          </p>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHead eyebrow="Work" title="Loading…" />
        <div className="px-7 py-6"><TableSkeleton rows={8} /></div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHead eyebrow="Work" title="Work" />
        <div className="px-7 py-6">
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        </div>
      </>
    );
  }

  const work: WorkItem[] = data.work.map((w) => (done[w.id] ? { ...w, state: "done" } : w));
  const open = work.filter((w) => w.state !== "done").slice().sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const finished = work.filter((w) => w.state === "done");
  const rows = tab === "Done" ? finished : open;

  const selected = rows.find((w) => w.id === selectedId) ?? rows[0] ?? null;

  async function handleFileSelected(item: WorkItem, file: File | undefined) {
    if (!file || !data) return;
    setUploading((u) => ({ ...u, [item.id]: true }));
    try {
      await uploadAssignmentSubmission({ tenantId: tenant.id, assignmentId: item.id, studentId: data.studentId, file });
      setAttached((a) => ({ ...a, [item.id]: file.name }));
      setDone((d) => ({ ...d, [item.id]: true }));
      toast(`Uploaded ${file.name}. ${item.teacher} has been told.`);
    } catch (err) {
      toast(err instanceof Error ? `Could not upload the file: ${err.message}` : "Could not upload the file.");
    } finally {
      setUploading((u) => ({ ...u, [item.id]: false }));
    }
  }

  return (
    <>
      <PageHead eyebrow="Work" title="Work" blurb={`${open.length} to hand in.`} />

      <div className="px-7 py-6">
        <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)" }}>
          <DataTable
            filters={
              <div className="flex gap-1.5">
                {(["To do", "Done"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => { setTab(t); setSelectedId(null); }}
                    className="rounded-full px-2.5 py-1 text-[11.5px]"
                    style={tab === t ? { background: "#17402A", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}
                  >
                    {t} {t === "Done" ? finished.length : open.length}
                  </button>
                ))}
              </div>
            }
            columns={[
              { key: "title", header: "Work", width: "1.8fr", render: (w: WorkItem) => <Cell sub={`${w.subject} · ${w.teacher}`}>{w.title}</Cell> },
              {
                key: "due", header: "Due", width: "1fr",
                render: (w: WorkItem) => (
                  <Mono>{w.state === "done" ? "Handed in" : w.state === "late" ? `Overdue · ${formatDueLabel(w.dueOn, true)}` : formatDueLabel(w.dueOn, false)}</Mono>
                ),
              },
              { key: "state", header: "", align: "right", width: "0.7fr", render: (w: WorkItem) => <Badge tone={STATE_TONE[w.state]}>{STATE_LABEL[w.state]}</Badge> },
            ]}
            rows={rows}
            rowKey={(w) => w.id}
            onRowClick={(w) => setSelectedId(w.id)}
            minWidth="520px"
            empty={
              tab === "Done"
                ? { title: "Nothing done yet", body: "Work you mark as handed in will appear here." }
                : { title: "Nothing here", body: "Handed in work moves to Done. Anything new your teachers set appears the moment they set it." }
            }
          />

          <section className="h-fit rounded-lg border border-line bg-white p-5">
            {!selected ? (
              <p className="py-8 text-center text-small text-ink-faint">Select a piece of work to see the full brief.</p>
            ) : (
              <>
                <h2 className="text-[16px] font-semibold leading-snug tracking-tight">{selected.title}</h2>
                <div className="mt-1 text-[12.5px] text-ink-faint">{selected.subject} · set by {selected.teacher}</div>

                <div className="mt-4 flex gap-4 rounded-lg border border-line-soft bg-page px-3.5 py-3">
                  <div className="flex-1">
                    <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">DUE</div>
                    <div className="mt-1 text-[13px] font-semibold" style={{ color: selected.state === "late" ? "#B8460A" : undefined }}>
                      {selected.state === "done" ? "Handed in" : formatDueLabel(selected.dueOn, selected.state === "late")}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">HAND IN</div>
                    <div className="mt-1 text-[13px] font-semibold">{selected.how}</div>
                  </div>
                </div>

                <p className="mt-4 whitespace-pre-line text-[13.5px] leading-relaxed text-ink">{selected.body}</p>

                {selected.state === "done" ? (
                  <div className="mt-5 flex items-center gap-2.5 rounded-lg bg-ok-bg px-3.5 py-3">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-ink text-[11px] text-white">✓</span>
                    <span className="text-small leading-relaxed text-ok-ink">Handed in. {selected.teacher} has been told.</span>
                  </div>
                ) : (
                  <>
                    <Button block variant="accent" className="mt-5" onClick={() => setDone((d) => ({ ...d, [selected.id]: true }))}>
                      Mark as handed in
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        void handleFileSelected(selected, e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      block
                      variant="secondary"
                      className="mt-2"
                      disabled={uploading[selected.id]}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploading[selected.id]
                        ? "Uploading…"
                        : attached[selected.id]
                          ? `Attached · ${attached[selected.id]}`
                          : "Attach a file"}
                    </Button>
                    <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-ink-faint">
                      This tells {selected.teacher} you have finished it. Attaching a file uploads it and marks it done too.
                    </p>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
