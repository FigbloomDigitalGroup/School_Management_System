import { useState } from "react";
import {
  CAPACITY_LABEL, chunk, fetchAllPages, fetchDocumentSignatures, formatMoney, receiptRef, signatureDate, signatureFor, signDocuments,
  supabase, type Payment, type StoredSignature,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { Cell, DataTable, Mono } from "../ui/DataTable";
import { TableSkeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { SignatureInk } from "./SignatureMark";
import { SignDocumentModal } from "./SignDocumentModal";

/** sign_documents takes at most 500 at a time. */
const SIGN_BATCH = 500;

/** The bursar's current signature on each of these receipts (payment ids), by receipt. */
export async function fetchReceiptSignatures(paymentIds: string[]): Promise<Map<string, StoredSignature>> {
  const sigs = (await Promise.all(chunk(paymentIds, SIGN_BATCH).map((part) => fetchDocumentSignatures("payment_receipt", part)))).flat();
  const out = new Map<string, StoredSignature>();
  for (const id of paymentIds) {
    const sig = signatureFor(sigs, id, "bursar", { currentOnly: true });
    if (sig) out.set(id, sig);
  }
  return out;
}

/** For a family's receipt list: each receipt's signature, loaded once for the list. Empty while loading or if none. */
export function useReceiptSignatures(paymentIds: string[]): Map<string, StoredSignature> {
  const key = paymentIds.join(",");
  const { data } = useAsync(() => (paymentIds.length ? fetchReceiptSignatures(paymentIds) : Promise.resolve(new Map<string, StoredSignature>())), [key]);
  return data ?? new Map();
}

/** A receipt's signature in a table cell: the mark, then who and when. "Not signed" when it isn't. */
export function ReceiptSignature({ signature }: { signature: StoredSignature | undefined }) {
  if (!signature) return <span className="text-[12px] text-ink-faint">Not signed</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <SignatureInk signature={signature} height={24} />
      <span className="text-[11px] text-ink-faint">
        {signature.fullName}, {CAPACITY_LABEL[signature.capacity].toLowerCase()} · {signatureDate(signature.signedAt)}
      </span>
    </span>
  );
}

interface TermReceipt {
  id: string;
  amount: number;
  when: string;
  ref: string;
  learner: string;
}

type PaymentDb = Pick<Payment, "id" | "amount_cents" | "method" | "mpesa_receipt" | "reference" | "completed_at" | "created_at"> & {
  fee_invoices: { students: { full_name: string } | null } | null;
};

async function fetchTermReceipts(tenantId: string, termId: string): Promise<TermReceipt[]> {
  const rows = await fetchAllPages<PaymentDb>((from, to) =>
    supabase().from("payments")
      .select("id, amount_cents, method, mpesa_receipt, reference, completed_at, created_at, fee_invoices!inner(term_id, students(full_name))")
      .eq("tenant_id", tenantId).eq("status", "success").eq("fee_invoices.term_id", termId)
      .order("completed_at", { ascending: false }).order("id").range(from, to).returns<PaymentDb[]>());
  return rows.map((p) => ({
    id: p.id,
    amount: p.amount_cents,
    when: (p.completed_at ?? p.created_at).slice(0, 10),
    ref: receiptRef(p),
    learner: p.fee_invoices?.students?.full_name ?? "Unknown learner",
  }));
}

/** How many receipts the office's list shows before "Sign all" is the way to deal with the rest. */
const SHOWN = 25;

/**
 * The office's receipts for the term, newest first, each with the bursar's
 * signature or a Sign button, and "Sign all" for every unsigned one at
 * once, as for invoices. Families see the signature and date beside the
 * receipt on their Fees screen.
 */
export function TermReceipts({ termId, reloadKey }: { termId: string; reloadKey?: number }) {
  const toast = useToast();
  const { tenant, profile } = useTenantSession();
  const [signedKey, setSignedKey] = useState(0);
  const [signing, setSigning] = useState<TermReceipt[] | null>(null);
  const { data, loading, error } = useAsync(async () => {
    const receipts = await fetchTermReceipts(tenant.id, termId);
    return { receipts, signatures: await fetchReceiptSignatures(receipts.map((r) => r.id)) };
  }, [tenant.id, termId, reloadKey, signedKey]);

  const unsigned = data ? data.receipts.filter((r) => !data.signatures.has(r.id)) : [];
  const many = signing && signing.length > 1;

  return (
    <>
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load this term's receipts: {error.message}</p>
      ) : loading && !data ? (
        <TableSkeleton rows={3} />
      ) : (
        <DataTable
          title="Receipts this term"
          filters={
            <Button disabled={!unsigned.length} onClick={() => setSigning(unsigned)} title="Your signature and the date show beside each receipt on the family's Fees screen">
              {unsigned.length ? `Sign ${unsigned.length.toLocaleString()} receipt${unsigned.length === 1 ? "" : "s"}` : "Receipts signed"}
            </Button>
          }
          columns={[
            { key: "when", header: "Date", width: "0.8fr", render: (r: TermReceipt) => <Mono>{new Date(`${r.when}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</Mono> },
            { key: "learner", header: "Learner", width: "1.4fr", render: (r: TermReceipt) => <Cell sub={r.ref}>{r.learner}</Cell> },
            { key: "amount", header: "Amount", align: "right", render: (r: TermReceipt) => <Mono>{formatMoney(r.amount, tenant.country)}</Mono> },
            {
              key: "signed", header: "Signed", align: "right", width: "1.4fr",
              render: (r: TermReceipt) => {
                const sig = data?.signatures.get(r.id);
                return sig ? <ReceiptSignature signature={sig} /> : <Button onClick={() => setSigning([r])}>Sign</Button>;
              },
            },
          ]}
          rows={(data?.receipts ?? []).slice(0, SHOWN)}
          rowKey={(r) => r.id}
          minWidth="720px"
          empty={{ title: "No receipts yet this term", body: "Every payment that goes through, by M-Pesa or recorded here, gets a receipt the bursar can sign." }}
        />
      )}
      {signing && (
        <SignDocumentModal
          title={many ? `Sign ${signing.length.toLocaleString()} receipts` : "Sign this receipt"}
          what={many ? "this term's receipts" : `the receipt for ${formatMoney(signing[0]!.amount, tenant.country)} from ${signing[0]!.learner}'s family`}
          capacityLabel={CAPACITY_LABEL.bursar}
          defaultName={profile.full_name}
          onSign={async (mark) => {
            let n = 0;
            for (const part of chunk(signing.map((r) => r.id), SIGN_BATCH)) n += await signDocuments("payment_receipt", part, "bursar", mark);
            setSigning(null);
            setSignedKey((k) => k + 1);
            toast(`Signed ${n.toLocaleString()} receipt${n === 1 ? "" : "s"}`);
          }}
          onClose={() => setSigning(null)}
        />
      )}
    </>
  );
}
