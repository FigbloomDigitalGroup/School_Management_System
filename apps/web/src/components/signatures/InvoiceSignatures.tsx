import { useState } from "react";
import {
  CAPACITY_LABEL, chunk, fetchAllPages, fetchDocumentSignatures, signatureFor, signDocuments, supabase,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { SignatureMark } from "./SignatureMark";
import { SignDocumentModal } from "./SignDocumentModal";

/** sign_documents takes at most 500 at a time. */
const SIGN_BATCH = 500;

async function fetchTermInvoiceIds(tenantId: string, termId: string): Promise<string[]> {
  const rows = await fetchAllPages<{ id: string }>((from, to) =>
    supabase().from("fee_invoices").select("id").eq("tenant_id", tenantId).eq("term_id", termId).order("id").range(from, to).returns<{ id: string }[]>());
  return rows.map((r) => r.id);
}

/**
 * The bursar signs the term's invoices in one go: "Sign 412 invoices". New
 * invoices billed later show up as unsigned until signed too. An invoice
 * whose amount or due date changed after signing counts as unsigned again.
 */
export function SignTermInvoices({ termId }: { termId: string }) {
  const toast = useToast();
  const { tenant, profile } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [signing, setSigning] = useState(false);
  const { data } = useAsync(async () => {
    const ids = await fetchTermInvoiceIds(tenant.id, termId);
    const sigs = (await Promise.all(chunk(ids, SIGN_BATCH).map((part) => fetchDocumentSignatures("fee_invoice", part)))).flat();
    return ids.filter((id) => !signatureFor(sigs, id, "bursar", { currentOnly: true }));
  }, [tenant.id, termId, reloadKey]);

  if (!data) return null;
  const unsigned = data;

  return (
    <>
      <Button disabled={!unsigned.length} onClick={() => setSigning(true)} title="Your signature and the date show on each family's invoice">
        {unsigned.length ? `Sign ${unsigned.length.toLocaleString()} invoice${unsigned.length === 1 ? "" : "s"}` : "Invoices signed"}
      </Button>
      {signing && (
        <SignDocumentModal
          title={`Sign ${unsigned.length.toLocaleString()} invoice${unsigned.length === 1 ? "" : "s"}`}
          what={`this term's ${unsigned.length === 1 ? "invoice" : "invoices"}`}
          capacityLabel={CAPACITY_LABEL.bursar}
          defaultName={profile.full_name}
          onSign={async (mark) => {
            let n = 0;
            for (const part of chunk(unsigned, SIGN_BATCH)) n += await signDocuments("fee_invoice", part, "bursar", mark);
            setSigning(false);
            setReloadKey((k) => k + 1);
            toast(`Signed ${n.toLocaleString()} invoice${n === 1 ? "" : "s"}`);
          }}
          onClose={() => setSigning(false)}
        />
      )}
    </>
  );
}

/** On a family's fees page: who signed this term's invoice for the school, and when. */
export function InvoiceSignature({ invoiceId }: { invoiceId: string }) {
  const { data } = useAsync(() => fetchDocumentSignatures("fee_invoice", [invoiceId]), [invoiceId]);
  const sig = data && signatureFor(data, invoiceId, "bursar", { currentOnly: true });
  if (!sig) return null;
  return (
    <section className="mt-4 rounded-lg border border-line bg-white px-4 py-3">
      <div className="text-[12px] font-semibold text-ink-muted">This term's invoice is signed for the school</div>
      <div className="mt-2"><SignatureMark signature={sig} /></div>
    </section>
  );
}
