import { useEffect, useState } from "react";
import { fetchDocumentSignatures, signatureFor, type StoredSignature } from "@figbloom/shared";

/**
 * The bursar's current signature on each of these receipts (payment ids),
 * loaded once for the whole list. null while loading, so a row doesn't flash
 * "Not signed" before the answer is in; an empty map if it can't be read.
 */
export function useReceiptSignatures(paymentIds: string[]): Map<string, StoredSignature> | null {
  const key = paymentIds.join(",");
  const [signatures, setSignatures] = useState<Map<string, StoredSignature> | null>(null);

  useEffect(() => {
    let alive = true;
    setSignatures(null);
    if (!paymentIds.length) { setSignatures(new Map()); return; }
    fetchDocumentSignatures("payment_receipt", paymentIds)
      .then((sigs) => {
        if (!alive) return;
        const out = new Map<string, StoredSignature>();
        for (const id of paymentIds) {
          const sig = signatureFor(sigs, id, "bursar", { currentOnly: true });
          if (sig) out.set(id, sig);
        }
        setSignatures(out);
      })
      .catch(() => { if (alive) setSignatures(new Map()); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paymentIds is a fresh array each render; its contents are the key
  }, [key]);

  return signatures;
}
