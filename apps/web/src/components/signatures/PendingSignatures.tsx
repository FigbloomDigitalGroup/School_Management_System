import { useState } from "react";
import { CAPACITY_LABEL, fetchMySignatureRequests, fileHash, signDocuments, supabase, type SignatureRequest } from "@figbloom/shared";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { SignDocumentModal } from "./SignDocumentModal";

/**
 * "Waiting for your signature": the files someone has asked the viewer to
 * sign (a permission slip on a message, a form in their child's records),
 * each with a way to read it first and a Sign button. Says nothing when
 * there's nothing to sign. onlyDocIds narrows it to one message's files.
 */
export function PendingSignatures({ onlyDocIds, compact }: { onlyDocIds?: string[]; compact?: boolean }) {
  const toast = useToast();
  const { profile } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [signing, setSigning] = useState<SignatureRequest | null>(null);
  const { data } = useAsync(() => fetchMySignatureRequests(), [reloadKey]);

  const list = (data ?? []).filter((r) => !onlyDocIds || onlyDocIds.includes(r.docId));
  if (!list.length) return null;

  async function open(r: SignatureRequest) {
    if (!r.filePath) return;
    const { data: url, error } = await supabase().storage.from(r.bucket).createSignedUrl(r.filePath, 600);
    if (error || !url) { toast("Could not open the file.", "error"); return; }
    window.open(url.signedUrl, "_blank", "noopener");
  }

  async function sign(r: SignatureRequest, mark: Parameters<typeof signDocuments>[3]) {
    if (!r.filePath) throw new Error("This file is no longer there to sign.");
    // What the signature vouches for: the file exactly as it is now.
    const hash = await fileHash(r.bucket, r.filePath);
    await signDocuments(r.docKind, [r.docId], r.capacity, mark, [hash]);
    setSigning(null);
    setReloadKey((k) => k + 1);
    toast(`Signed: ${r.title}`);
  }

  return (
    <section className={`overflow-hidden rounded-lg border border-orange-line bg-white ${compact ? "" : "mb-4"}`}>
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold">Waiting for your signature</h2>
        {!compact && <p className="mt-0.5 text-[12px] text-ink-muted">Read each one, then sign it here. The school sees the date you signed.</p>}
      </header>
      <ul>
        {list.map((r) => (
          <li key={r.requestId} className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-b-0">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium">{r.title}</div>
              <div className="text-[12px] text-ink-faint">
                {[r.detail, r.requestedByName && `asked by ${r.requestedByName}`].filter(Boolean).join(" · ")}
              </div>
              {r.note && <p className="mt-0.5 text-[12px] text-ink-muted">{r.note}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              {r.filePath && <Button onClick={() => void open(r)}>Read</Button>}
              <Button variant="accent" onClick={() => setSigning(r)}>Sign</Button>
            </div>
          </li>
        ))}
      </ul>
      {signing && (
        <SignDocumentModal
          title={`Sign ${signing.title}`}
          what={`“${signing.title}”`}
          capacityLabel={CAPACITY_LABEL[signing.capacity]}
          defaultName={profile.full_name}
          onSign={(mark) => sign(signing, mark)}
          onClose={() => setSigning(null)}
        />
      )}
    </section>
  );
}

/** The files on one message still waiting for the viewer's signature. */
export function MessageToSign({ announcementId }: { announcementId: string }) {
  const { data } = useAsync(async () => {
    const { data, error } = await supabase().from("attachments").select("id").eq("announcement_id", announcementId).eq("needs_signature", true);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }, [announcementId]);
  return data?.length ? <PendingSignatures onlyDocIds={data} compact /> : null;
}
