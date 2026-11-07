import {
  applicationReadiness, HR_CONNECT_ONCE, hrStatusLabel, leaveDaysWords, leaveRange, leaveTypeRules, linkExpired, MAX_LEAVE_DOCUMENT_BYTES, mayDecline,
  type ApprovalItem,
  type ApprovalsState, type LeaveForm, type MyLeave,
} from "@figbloom/shared";
import type { ReactNode } from "react";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { TableSkeleton } from "../../components/ui/Skeleton";

/**
 * The parts of the HR leave pages that only show what they're given (no calls), so the tests can render them:
 * "Leave to approve" in each of its states, the HR application form, and the person's applications with their
 * approval progress.
 */


function tone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === "approved" || s === "done" || s === "completed") return "ok";
  if (s === "pending" || s === "current" || s === "waiting") return "warn";
  if (s === "declined" || s === "rejected") return "info";
  return "muted";
}

export const ErrorNote = ({ message, problems = [] }: { message: string; problems?: string[] }) => (
  <div role="alert" className="rounded-lg border border-line bg-white px-4 py-3.5 text-[12.5px] text-warn-ink">
    <p>{message}</p>
    {problems.length > 1 && (
      <ul className="mt-1.5 list-disc pl-5">
        {problems.map((p) => <li key={p}>{p}</li>)}
      </ul>
    )}
  </div>
);

/** The approver hasn't opened HR & Payroll from Schools yet, so HR doesn't know which of its users they are. */
export function ConnectOnce({ hrButton }: { hrButton?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-white">
      <EmptyState
        title="Connect your HR account"
        body={`${HR_CONNECT_ONCE} After that, applications waiting on you show up here.${hrButton ? "" : " If you don't have HR & Payroll in the sidebar, ask the school office."}`}
        action={hrButton}
      />
    </div>
  );
}

export interface ApprovalsViewProps {
  state: ApprovalsState;
  /** the comment typed per application */
  comments: Record<string, string>;
  onComment: (id: string, text: string) => void;
  onDecide: (item: ApprovalItem, decision: "approve" | "decline") => void;
  /** the application being decided, while the call runs */
  busyId: string | null;
  /** the "HR & Payroll" button, when this person has it */
  hrButton?: ReactNode;
  /** asks HR again (new document links: they last 5 minutes) */
  onReload?: () => void;
  /** for the links' expiry; defaults to now */
  now?: number;
}

/** "Leave to approve": what waits on this person in HR, each with its documents, the chain so far, and approve / decline with a comment. */
export function ApprovalsView({ state, comments, onComment, onDecide, busyId, hrButton, onReload, now = Date.now() }: ApprovalsViewProps) {
  switch (state.kind) {
    case "loading":
      return <TableSkeleton rows={4} />;
    case "not_available":
      return (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState title="Nothing to approve here" body="Leave is approved in Figbloom HR only at schools whose leave runs through HR, by the head teacher, deputies, the bursar and the school's admins." />
        </div>
      );
    case "not_linked":
      return <ConnectOnce hrButton={hrButton} />;
    case "error":
      return <ErrorNote message={state.message} />;
    case "empty":
      return (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState title="Nothing waiting on you" body="Leave applications that need your decision in Figbloom HR will show up here." />
        </div>
      );
    case "list":
      return (
        <div className="grid gap-3">
          {state.items.map((a) => (
            <article key={a.id} aria-label={`${a.employee}: ${a.type}`} className="grid gap-3 rounded-lg border border-line bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">{a.employee}</div>
                  <div className="mt-0.5 text-[13px]">
                    {a.type} · {leaveRange(a.from, a.to)}{leaveDaysWords(a.days, a.halfDay) ? ` · ${leaveDaysWords(a.days, a.halfDay)}` : ""}
                  </div>
                  {a.reason && <p className="mt-1 text-[12.5px] text-ink-muted">{a.reason}</p>}
                  {a.step && <p className="mt-1 text-[12px] text-ink-faint">Your step: {a.step}</p>}
                </div>
                {a.documents.length > 0 && (
                  <div className="grid justify-items-end gap-1">
                    {a.documents.map((d) => linkExpired(d, now) ? (
                      <span key={d.name} className="text-[12px] text-ink-muted">
                        {d.name}: link expired.{" "}
                        {onReload && <button type="button" onClick={onReload} className="font-semibold text-accent hover:underline">Reload</button>}
                      </span>
                    ) : (
                      <a key={d.name} href={d.url!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
                        title="Opens HR's copy; the link works for 5 minutes" className="text-[12.5px] font-semibold text-accent hover:underline">
                        View {d.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              {a.steps.length > 0 && (
                <ol className="flex flex-wrap gap-2" aria-label="Approval so far">
                  {a.steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[12px]">
                      <Badge tone={tone(s.status)}>{s.label}: {hrStatusLabel(s.status)}{s.who ? ` (${s.who})` : ""}</Badge>
                    </li>
                  ))}
                </ol>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1">
                  <TextField
                    id={`comment-${a.id}`} label="Comment (needed to decline)" value={comments[a.id] ?? ""}
                    onChange={(e) => onComment(a.id, e.target.value)} maxLength={1000}
                  />
                </div>
                <Button disabled={busyId === a.id || !mayDecline(comments[a.id] ?? "")} title="Say why in the comment first" onClick={() => onDecide(a, "decline")}>Decline</Button>
                <Button variant="accent" disabled={busyId === a.id} onClick={() => onDecide(a, "approve")}>
                  {busyId === a.id ? "Saving…" : "Approve"}
                </Button>
              </div>
            </article>
          ))}
        </div>
      );
  }
}

export interface LeaveFormValues {
  typeId: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  reason: string;
  documentName: string | null;
}

export interface HrLeaveFormProps {
  form: LeaveForm | null;
  loading: boolean;
  error: string | null;
  values: LeaveFormValues;
  onChange: (v: Partial<LeaveFormValues>) => void;
  /** a file chosen (or cleared with null) */
  onDocument: (file: File | null) => void;
  onSubmit: () => void;
  saving: boolean;
  /** HR's refusal of the last try (422 leave_rules): its sentence and one line per rule */
  refusal?: { message: string; problems: string[] } | null;
}

/** The application form, from HR's leave/form: the types this person may use with their rules, and who approves. */
export function HrLeaveForm({ form, loading, error, values, onChange, onDocument, onSubmit, saving, refusal }: HrLeaveFormProps) {
  if (error) return <ErrorNote message={error} />;
  if (loading || !form) return <TableSkeleton rows={4} />;
  if (form.types.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState title="No leave types yet" body="Figbloom HR has no leave types you can apply for. Ask the school's HR administrator." />
      </div>
    );
  }
  const { type, needsDocument, ready } = applicationReadiness(form, values);
  const rules = type ? leaveTypeRules(type) : "";
  return (
    <form
      className="grid content-start gap-3.5 rounded-lg border border-line bg-white p-4"
      onSubmit={(e) => { e.preventDefault(); if (ready && !saving) onSubmit(); }}
    >
      <SelectField
        id="hr-leave-type" label="Type of leave" value={values.typeId}
        onChange={(e) => onChange({ typeId: e.target.value, halfDay: false })}
        options={[{ value: "", label: "Choose…" }, ...form.types.map((t) => ({ value: t.id, label: t.name }))]}
      />
      {rules && <p className="-mt-2 text-[12px] text-ink-muted">{rules}</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <TextField id="hr-leave-start" label="First day" type="date" value={values.startDate}
          onChange={(e) => onChange({ startDate: e.target.value, ...(values.halfDay ? { endDate: e.target.value } : {}) })} />
        <TextField id="hr-leave-end" label="Last day" type="date" value={values.endDate} disabled={values.halfDay}
          onChange={(e) => onChange({ endDate: e.target.value })} />
      </div>
      {type?.halfDays && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={values.halfDay} onChange={(e) => onChange({ halfDay: e.target.checked, endDate: e.target.checked ? values.startDate : values.endDate })} />
          Half a day
        </label>
      )}
      <TextArea id="hr-leave-reason" label={`Reason (at least ${form.reasonMin} characters)`} value={values.reason}
        onChange={(e) => onChange({ reason: e.target.value })} maxLength={2000} />
      <div className="grid gap-1">
        <label htmlFor="hr-leave-document" className="text-[12.5px] font-medium">
          {type?.document?.name ?? "Document"} {needsDocument ? "(needed)" : "(optional)"}: PDF, photo or Word, up to {MAX_LEAVE_DOCUMENT_BYTES / 1024 / 1024} MB
        </label>
        <input id="hr-leave-document" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx"
          onChange={(e) => onDocument(e.target.files?.[0] ?? null)} className="text-[12.5px]" />
        {values.documentName && <span className="text-[12px] text-ink-muted">Attached: {values.documentName}</span>}
      </div>
      {form.chain.length > 0 && <p className="text-[12px] text-ink-muted">Approved by: {form.chain.join(", then ")}.</p>}
      {refusal && <ErrorNote message={refusal.message} problems={refusal.problems} />}
      <Button type="submit" variant="accent" disabled={!ready || saving}>{saving ? "Sending to HR…" : "Apply for leave"}</Button>
    </form>
  );
}

/** The person's applications from HR's GET leave, newest as HR orders them, with each step of the approval. */
export function HrApplications({ leave, loading, error, onCancel, cancellingId }: {
  leave: MyLeave | null; loading: boolean; error: string | null; onCancel: (id: string) => void; cancellingId: string | null;
}) {
  if (error) return <ErrorNote message={error} />;
  if (loading || !leave) return <TableSkeleton rows={4} />;
  return (
    <div className="grid gap-3">
      {leave.balances.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Balances">
          {leave.balances.map((b) => (
            <Badge key={b.type} tone="muted">{b.type}: {b.available ?? "—"} {b.available === 1 ? "day" : "days"} left</Badge>
          ))}
        </div>
      )}
      {leave.applications.length === 0 ? (
        <EmptyState title="Nothing applied for yet" body="Your applications show up here, with who has approved them so far." />
      ) : leave.applications.map((a) => (
        <div key={a.id} className="border-b border-line-soft px-1 py-3 last:border-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{a.type} · {leaveRange(a.from, a.to)}{a.days !== null ? ` · ${a.days} ${a.days === 1 ? "day" : "days"}` : ""}</div>
              {a.reason && <p className="mt-0.5 text-[12px] text-ink-faint">{a.reason}</p>}
              {a.steps.length > 0 && (
                <p className="mt-1 text-[12px] text-ink-muted">
                  {a.steps.map((s) => `${s.label}: ${hrStatusLabel(s.status)}${s.who ? ` (${s.who})` : ""}`).join(" → ")}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={tone(a.status)}>{hrStatusLabel(a.status)}</Badge>
              {/* HR's own answer to "can it be cancelled now" (pending, or approved before it starts) */}
              {a.cancellable === true && (
                <button type="button" disabled={cancellingId === a.id} onClick={() => onCancel(a.id)} className="text-[12px] font-semibold text-warn-ink hover:underline">
                  {cancellingId === a.id ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
