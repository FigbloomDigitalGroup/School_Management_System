// Leave run by Figbloom HR (SCHOOLS_HR_LEAVE_CONTRACT.md section 3): the staff leave page at a school whose leave is HR's.
import { useState } from "react";
import {
  applyForLeave, cancelHrLeave, documentProblem, EdgeError, fetchHrLeaveApplications, fetchLeaveForm, leaveProblems, readLeave, readLeaveForm,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { confirmDialog } from "../../components/ui/Confirm";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { HrApplications, HrLeaveForm, type LeaveFormValues } from "./HrLeaveViews";

const EMPTY: LeaveFormValues = { typeId: "", startDate: "", endDate: "", halfDay: false, reason: "", documentName: null };

/** The file's content as base64 (no "data:...;base64," prefix). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The document couldn't be read. Choose it again."));
    reader.readAsDataURL(file);
  });
}

/**
 * Apply for leave through HR: HR's types and rules, balances, approval chain, documents; then follow each
 * application to approval, or cancel it while HR allows. Everything goes through the my-hr function as the
 * signed-in person. Once HR approves, the leave appears in Schools on its own (cover planning, notices).
 */
export function HrLeave() {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const form = useAsync(async () => readLeaveForm(await fetchLeaveForm()), []);
  const mine = useAsync(async () => readLeave(await fetchHrLeaveApplications()), [reloadKey]);
  const [values, setValues] = useState<LeaveFormValues>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  /** HR's refusal of the last try (422 leave_rules), shown on the form with each rule */
  const [refusal, setRefusal] = useState<{ message: string; problems: string[] } | null>(null);

  function onDocument(f: File | null) {
    if (f) {
      const problem = documentProblem({ size: f.size, type: f.type });
      if (problem) { toast(problem, "error"); return; }
    }
    setFile(f);
    setValues((v) => ({ ...v, documentName: f?.name ?? null }));
  }

  async function submit() {
    if (values.endDate < values.startDate) { toast("The last day is before the first.", "error"); return; }
    setSaving(true);
    setRefusal(null);
    try {
      const document = file ? { name: file.name, contentType: file.type, base64: await readBase64(file) } : null;
      await applyForLeave({ typeId: values.typeId, startDate: values.startDate, endDate: values.endDate, halfDay: values.halfDay, reason: values.reason, document });
      toast("Sent to Figbloom HR for approval.");
      setValues(EMPTY);
      setFile(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (err instanceof EdgeError && err.code === "leave_rules") setRefusal(leaveProblems(err));
      else toast(err instanceof Error ? err.message : "Could not apply for leave.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: string) {
    if (!(await confirmDialog({ title: "Cancel this leave application?", confirmLabel: "Cancel it" }))) return;
    setCancellingId(id);
    try {
      await cancelHrLeave(id);
      toast("Cancelled in Figbloom HR.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not cancel.", "error");
      // not_cancellable: HR's answer changed since the list was read
      setReloadKey((k) => k + 1);
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <>
      <PageHead eyebrow="Leave" title="Leave" blurb="Your school's leave runs in Figbloom HR: apply here, and follow each application until it's approved." />
      <div className="grid gap-5 px-7 py-6" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)" }}>
        <HrLeaveForm
          form={form.data ?? null} loading={form.loading} error={form.error?.message ?? null}
          values={values} onChange={(v) => setValues((old) => ({ ...old, ...v }))} onDocument={onDocument}
          onSubmit={() => void submit()} saving={saving} refusal={refusal}
        />
        <div className="overflow-hidden rounded-lg border border-line bg-white">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-body font-semibold">Your applications</h2>
          </header>
          <div className="px-4 py-2">
            <HrApplications
              leave={mine.data ?? null} loading={mine.loading && !mine.data} error={mine.error?.message ?? null}
              onCancel={(id) => void cancel(id)} cancellingId={cancellingId}
            />
          </div>
        </div>
      </div>
    </>
  );
}
