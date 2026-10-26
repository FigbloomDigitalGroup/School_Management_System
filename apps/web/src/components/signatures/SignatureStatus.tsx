import { useState } from "react";
import { fetchSignatureStatus, signatureDate, supabase, type SignedDocKind } from "@figbloom/shared";
import { useAsync } from "../../lib/useAsync";

/**
 * For whoever asked: "Signed by 12 of 30", opening to who has and who
 * hasn't. Shown on a sent message whose files need signing, and on a
 * learner's document. Says nothing when nobody was asked.
 */
export function SignatureStatus({ kind, docIds, reloadKey = 0 }: { kind: SignedDocKind; docIds: string[]; reloadKey?: number }) {
  const [open, setOpen] = useState(false);
  const key = docIds.join(",");
  const { data } = useAsync(() => fetchSignatureStatus(kind, docIds), [kind, key, reloadKey]);
  if (!data?.length) return null;

  // One line per person: a message with two files to sign counts someone as signed once they've signed both.
  const people = new Map<string, { id: string; name: string; signed: number; asked: number; lastSigned: string | null }>();
  for (const r of data) {
    const p = people.get(r.signerId) ?? { id: r.signerId, name: r.signerName, signed: 0, asked: 0, lastSigned: null };
    p.asked++;
    if (r.signedAt) { p.signed++; if (!p.lastSigned || r.signedAt > p.lastSigned) p.lastSigned = r.signedAt; }
    people.set(r.signerId, p);
  }
  const all = [...people.values()];
  const done = all.filter((p) => p.signed === p.asked);
  const waiting = all.filter((p) => p.signed < p.asked);

  return (
    <div className="mt-2 text-[12px]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="font-medium text-ink-muted underline" aria-expanded={open}>
        Signed by {done.length} of {all.length}
      </button>
      {open && (
        <div className="mt-1.5 grid gap-2 rounded-md bg-sunken px-3 py-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <div className="font-semibold">Not yet ({waiting.length})</div>
            <ul className="mt-0.5 text-ink-muted">{waiting.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
          </div>
          <div>
            <div className="font-semibold">Signed ({done.length})</div>
            <ul className="mt-0.5 text-ink-muted">
              {done.map((p) => <li key={p.id}>{p.name}{p.lastSigned && <span className="text-ink-faint"> · {signatureDate(p.lastSigned)}</span>}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** The ids of a message's files that need signing. */
async function fetchSignableAttachmentIds(announcementId: string): Promise<string[]> {
  const { data, error } = await supabase().from("attachments").select("id")
    .eq("announcement_id", announcementId).eq("needs_signature", true).order("created_at");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/** SignatureStatus for a sent message, when its files need signing; nothing otherwise. */
export function MessageSignatureStatus({ announcementId }: { announcementId: string }) {
  const { data } = useAsync(() => fetchSignableAttachmentIds(announcementId), [announcementId]);
  return data?.length ? <SignatureStatus kind="attachment" docIds={data} /> : null;
}

/**
 * "Ask families to sign the attached files", under a composer's attachment
 * picker. Only offered once there are files.
 */
export function NeedsSignatureToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-[12.5px] leading-snug">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="mt-0.5" />
      <span>
        <span className="font-medium">Ask them to sign the attached files</span>
        <span className="block text-[11.5px] text-ink-faint">For a permission slip or consent form. Each family signs in the app, and you see who has.</span>
      </span>
    </label>
  );
}
