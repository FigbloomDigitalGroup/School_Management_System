import { useState } from "react";
import {
  CAPACITY_LABEL, fetchDocumentSignatures, requestSignatures, signDocuments, supabase, voidSignature,
} from "@figbloom/shared";
import { fileHash } from "../../lib/signing";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { SignatureMark } from "./SignatureMark";
import { SignatureStatus } from "./SignatureStatus";
import { SignDocumentModal } from "./SignDocumentModal";

interface Person { id: string; name: string; detail: string }

async function fetchSigners(tenantId: string, studentId: string): Promise<{ guardians: Person[]; staff: Person[] }> {
  const sb = supabase();
  const [g, s] = await Promise.all([
    sb.from("guardians").select("profile_id, relationship, profiles(full_name)").eq("student_id", studentId),
    sb.from("profiles").select("id, full_name, role, staff_title").eq("tenant_id", tenantId).in("role", ["school_admin", "teacher"]).order("full_name"),
  ]);
  if (g.error) throw new Error(g.error.message);
  if (s.error) throw new Error(s.error.message);
  const guardians = ((g.data ?? []) as unknown as { profile_id: string; relationship: string | null; profiles: { full_name: string } | null }[])
    .map((r) => ({ id: r.profile_id, name: r.profiles?.full_name ?? "Guardian", detail: r.relationship ?? "Guardian" }));
  const staff = ((s.data ?? []) as { id: string; full_name: string; role: string; staff_title: string | null }[])
    .map((r) => ({ id: r.id, name: r.full_name, detail: r.staff_title ?? (r.role === "school_admin" ? "Admin" : "Teacher") }));
  return { guardians, staff };
}

/**
 * Signatures on one file in a learner's records: who has signed, asking the
 * learner's guardians or colleagues to sign, and signing it yourself. The
 * office can void a signature made by mistake.
 */
export function LearnerDocumentSignatures({ doc, studentId, onClose }: {
  doc: { id: string; file_path: string; file_name: string };
  studentId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { tenant, profile } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [signing, setSigning] = useState(false);

  const signers = useAsync(() => fetchSigners(tenant.id, studentId), [tenant.id, studentId]);
  const signatures = useAsync(() => fetchDocumentSignatures("student_document", [doc.id]), [doc.id, reloadKey]);
  const isAdmin = profile.role === "school_admin";

  function toggle(id: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function ask() {
    setAsking(true);
    try {
      const n = await requestSignatures(doc.id, [...picked], note);
      toast(n ? `Asked ${n} ${n === 1 ? "person" : "people"} to sign` : "They had already been asked.");
      setPicked(new Set());
      setNote("");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not ask for signatures.", "error");
    } finally {
      setAsking(false);
    }
  }

  async function voidOne(id: string) {
    const reason = window.prompt("Why is this signature being voided? The signer can sign again afterwards.");
    if (!reason) return;
    try {
      await voidSignature(id, reason);
      setReloadKey((k) => k + 1);
      toast("Signature voided");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not void it.", "error");
    }
  }

  const people = [...(signers.data?.guardians ?? []).map((p) => ({ ...p, group: "Guardians" })), ...(signers.data?.staff ?? []).filter((p) => p.id !== profile.id).map((p) => ({ ...p, group: "Staff" }))];

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Signatures"
      title={doc.file_name}
      width={640}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      <div className="grid gap-5">
        <section>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold">Signed by</h3>
            <Button variant="primary" onClick={() => setSigning(true)}>Sign it yourself</Button>
          </div>
          {signatures.data?.length ? (
            <div className="mt-2 flex flex-wrap gap-5">
              {signatures.data.map((s) => (
                <SignatureMark key={s.id} signature={s} onVoid={isAdmin ? () => void voidOne(s.id) : undefined} />
              ))}
            </div>
          ) : (
            <p className="mt-1 text-small text-ink-faint">{signatures.loading ? "Loading…" : "Nobody has signed it yet."}</p>
          )}
          <SignatureStatus kind="student_document" docIds={[doc.id]} reloadKey={reloadKey} />
        </section>

        <section className="border-t border-line-soft pt-4">
          <h3 className="text-[13px] font-semibold">Ask someone to sign</h3>
          <p className="mt-0.5 text-[12px] text-ink-muted">They see it under “Waiting for your signature” and can read the file before signing.</p>
          <ul className="mt-2 grid max-h-56 gap-1 overflow-auto">
            {people.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2 rounded-md px-2 py-1 text-small hover:bg-sunken">
                  <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-ink-faint">{p.group === "Guardians" ? CAPACITY_LABEL.guardian : p.detail}</span>
                </label>
              </li>
            ))}
            {!signers.loading && !people.length && <li className="text-small text-ink-faint">No guardians or colleagues to ask.</li>}
          </ul>
          <div className="mt-2 grid gap-2">
            <TextField id="sig-note" label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
              placeholder="Please sign by Friday" />
            <div><Button variant="accent" disabled={!picked.size || asking} onClick={() => void ask()}>{asking ? "Asking…" : `Ask ${picked.size || ""} to sign`}</Button></div>
          </div>
        </section>
      </div>

      {signing && (
        <SignDocumentModal
          title={`Sign ${doc.file_name}`}
          what="this document"
          capacityLabel={CAPACITY_LABEL.staff}
          defaultName={profile.full_name}
          onSign={async (mark) => {
            const hash = await fileHash("private-documents", doc.file_path);
            await signDocuments("student_document", [doc.id], "staff", mark, [hash]);
            setSigning(false);
            setReloadKey((k) => k + 1);
            toast("Signed");
          }}
          onClose={() => setSigning(false)}
        />
      )}
    </Modal>
  );
}
