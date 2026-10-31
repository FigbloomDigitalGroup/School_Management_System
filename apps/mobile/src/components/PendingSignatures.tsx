import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import {
  CAPACITY_LABEL, fetchDocumentSignatures, fetchMySignatureRequests, signatureFor, signDocuments, supabase,
  type SignatureMark as Mark, type SignatureRequest, type StoredSignature,
} from "@figbloom/shared";
import { fileHash } from "../lib/signing";
import { useMyName } from "../lib/useMyName";
import { SignatureMark } from "./SignatureMark";
import { SignSheet } from "./SignSheet";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

/**
 * "Waiting for your signature": the files someone has asked the viewer to
 * sign (a permission slip on a message, a form in their child's records),
 * each with a way to read it first and a Sign button. Says nothing when
 * there's nothing to sign, or when the list can't be loaded (offline).
 * onlyDocIds narrows it to one message's files.
 */
export function PendingSignatures({ tint, onlyDocIds, compact }: { tint: string; onlyDocIds?: string[]; compact?: boolean }) {
  const { t, s } = useTheme();
  const name = useMyName();
  const [requests, setRequests] = useState<SignatureRequest[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [signing, setSigning] = useState<SignatureRequest | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMySignatureRequests()
      .then((r) => { if (alive) setRequests(r); })
      .catch(() => { if (alive) setRequests([]); });
    return () => { alive = false; };
  }, [reloadKey]);

  const list = (requests ?? []).filter((r) => !onlyDocIds || onlyDocIds.includes(r.docId));
  if (!list.length && !note) return null;

  async function open(r: SignatureRequest) {
    if (!r.filePath) return;
    const { data, error } = await supabase().storage.from(r.bucket).createSignedUrl(r.filePath, 600);
    if (error || !data) { setNote("Could not open the file."); return; }
    await Linking.openURL(data.signedUrl).catch(() => setNote("Could not open the file."));
  }

  async function sign(r: SignatureRequest, mark: Mark) {
    if (!r.filePath) throw new Error("This file is no longer there to sign.");
    // What the signature vouches for: the file exactly as it is now.
    const hash = await fileHash(r.bucket, r.filePath);
    await signDocuments(r.docKind, [r.docId], r.capacity, mark, [hash]);
    setSigning(null);
    setNote(`Signed: ${r.title}`);
    setReloadKey((k) => k + 1);
  }

  return (
    <View style={[s.card, { marginTop: compact ? 12 : 16, padding: 0, borderColor: t.brand.orangeLine }]}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 }}>
        <Text style={s.eyebrow}>WAITING FOR YOUR SIGNATURE</Text>
        {!compact && !!list.length && <Text style={[s.small, { marginTop: 4 }]}>Read each one, then sign it here. The school sees the date you signed.</Text>}
      </View>
      {list.map((r) => (
        <View key={r.requestId} style={{ paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }}>
          <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "600" }}>{r.title}</Text>
          <Text style={s.faint}>{[r.detail, r.requestedByName && `asked by ${r.requestedByName}`].filter(Boolean).join(" · ")}</Text>
          {!!r.note && <Text style={[s.small, { marginTop: 4 }]}>{r.note}</Text>}
          <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
            {!!r.filePath && (
              <Tap accessibilityRole="button" onPress={() => void open(r)} style={{ minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: t.appSurface.ink, fontWeight: "600" }}>Read</Text>
              </Tap>
            )}
            <Tap accessibilityRole="button" onPress={() => { setNote(null); setSigning(r); }} style={{ minHeight: 44, paddingHorizontal: 20, borderRadius: 12, backgroundColor: tint, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontWeight: "600", color: "#fff" }}>Sign</Text>
            </Tap>
          </View>
        </View>
      ))}
      {!!note && <Text style={[s.small, { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: list.length ? 1 : 0, borderTopColor: t.appSurface.lineSoft }]}>{note}</Text>}
      {signing && (
        <SignSheet
          title={`Sign ${signing.title}`}
          what={`“${signing.title}”`}
          capacityLabel={CAPACITY_LABEL[signing.capacity]}
          defaultName={name}
          tint={tint}
          onSign={(mark) => sign(signing, mark)}
          onClose={() => setSigning(null)}
        />
      )}
    </View>
  );
}

/** The files on one message still waiting for the viewer's signature. */
export function MessageToSign({ announcementId, tint }: { announcementId: string; tint: string }) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    supabase().from("attachments").select("id").eq("announcement_id", announcementId).eq("needs_signature", true)
      .then(({ data }) => { if (alive) setIds(((data ?? []) as { id: string }[]).map((r) => r.id)); });
    return () => { alive = false; };
  }, [announcementId]);
  return ids.length ? <PendingSignatures tint={tint} onlyDocIds={ids} compact /> : null;
}

/** On a family's fees page: who signed this term's invoice for the school, and when. */
export function InvoiceSignature({ invoiceId }: { invoiceId: string }) {
  const { s } = useTheme();
  const [sigs, setSigs] = useState<StoredSignature[] | null>(null);
  useEffect(() => {
    let alive = true;
    setSigs(null);
    fetchDocumentSignatures("fee_invoice", [invoiceId])
      .then((r) => { if (alive) setSigs(r); })
      .catch(() => { /* nothing to show beats a broken card */ });
    return () => { alive = false; };
  }, [invoiceId]);
  const sig = sigs && signatureFor(sigs, invoiceId, "bursar", { currentOnly: true });
  if (!sig) return null;
  return (
    <View style={[s.card, { marginTop: 12, padding: 14 }]}>
      <Text style={[s.small, { fontWeight: "600" }]}>This term's invoice is signed for the school</Text>
      <View style={{ marginTop: 8 }}><SignatureMark signature={sig} /></View>
    </View>
  );
}
