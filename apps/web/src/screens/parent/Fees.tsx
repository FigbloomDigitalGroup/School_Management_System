import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { formatMoney, itemsForStudent, supabase } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { PayWithMpesaModal } from "../../components/PayWithMpesaModal";
import { useToast } from "../../components/ui/Toast";
import { formatPhone, formatShortDate, type Receipt } from "@figbloom/shared";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { listPaymentProofs, privateDocUrl, uploadPaymentProof, type PaymentProof } from "../../lib/uploads";
import { ChildSwitcher } from "./ChildSwitcher";

const PROOF_TONE: Record<PaymentProof["status"], Tone> = { pending: "muted", confirmed: "ok", rejected: "warn" };
const PROOF_LABEL: Record<PaymentProof["status"], string> = { pending: "Pending review", confirmed: "Confirmed", rejected: "Rejected" };

/** The current-term invoice id for a child — not exposed by useParentData(), so
 *  fetched the same way admin/Fees.tsx finds "the current term". */
async function fetchCurrentInvoiceId(studentId: string): Promise<string | null> {
  const { data: term } = await supabase().from("terms").select("id").eq("is_current", true).maybeSingle();
  if (!term) return null;
  const { data: invoice } = await supabase()
    .from("fee_invoices")
    .select("id")
    .eq("student_id", studentId)
    .eq("term_id", term.id)
    .maybeSingle();
  return invoice?.id ?? null;
}

/**
 * Real fee items for the term, real receipts, and the M-Pesa pay dialog
 * (PayWithMpesaModal): it asks the server for a prompt and shows only what the
 * payment row says, since only Safaricom's confirmed callback can ever mark a
 * payment "success".
 */
export function ParentFees() {
  const { profile, tenant } = useTenantSession();
  const { data, loading, error, child, reload } = useParentData();
  const [params, setParams] = useSearchParams();
  const toast = useToast();

  const [open, setOpen] = useState(false);

  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofNote, setProofNote] = useState("");
  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofReload, setProofReload] = useState(0);

  const { data: invoiceId, loading: invoiceLoading } = useAsync(
    () => (child ? fetchCurrentInvoiceId(child.id) : Promise.resolve(null)),
    [child?.id],
  );
  // Tagged with the invoice they belong to: after a child switch the previous
  // child's proofs must not show, but a reload after an upload keeps the list up.
  const { data: proofsFor, loading: proofsLoading } = useAsync(
    async () => ({ invoiceId, proofs: invoiceId ? await listPaymentProofs(invoiceId) : ([] as PaymentProof[]) }),
    [invoiceId, proofReload],
  );
  const proofs = !invoiceLoading && proofsFor?.invoiceId === invoiceId ? proofsFor.proofs : null;
  const proofsPending = !proofs && (invoiceLoading || proofsLoading);

  async function handleUploadProof(e: FormEvent) {
    e.preventDefault();
    if (!invoiceId || invoiceLoading || !proofFile) return;
    setUploadingProof(true);
    try {
      await uploadPaymentProof({
        tenantId: tenant.id,
        invoiceId,
        uploadedBy: profile.id,
        note: proofNote.trim() || undefined,
        file: proofFile,
      });
      toast("Payment proof uploaded — the bursar will review it.");
      setProofFile(null);
      setProofNote("");
      setProofReload((n) => n + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not upload proof: ${err.message}` : "Could not upload proof.", "error");
    } finally {
      setUploadingProof(false);
    }
  }

  async function openProof(path: string) {
    try {
      const url = await privateDocUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open that file.", "error");
    }
  }

  // Home links here with ?pay=1 so "Pay with M-Pesa" opens straight into the modal.
  useEffect(() => {
    if (!data || !child) return;
    if (params.get("pay") === "1") {
      if (child.balance > 0) setOpen(true);
      const next = new URLSearchParams(params);
      next.delete("pay");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, child?.id]);

  function openPay() {
    setOpen(true);
  }

  const feeItems = child && data ? itemsForStudent(data.feeItems as never, { boarding: child.boarding }, child.formLevel, child.classLevel) : [];

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Fees"}
        title={child ? `${child.first}'s fees` : "Fees"}
        blurb={data?.termLabel ? `${data.termLabel} fee balance, structure and receipts.` : undefined}
        actions={
          <>
            <ChildSwitcher />
            {child && child.balance > 0 && (
              <Button variant="accent" onClick={openPay}>Pay with M-Pesa</Button>
            )}
          </>
        }
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load fees: {error.message}
          </p>
        ) : loading || !data ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
        ) : !child ? (
          <EmptyState
            title="No child linked"
            body="This account is not yet linked to a learner. Contact the school office."
          />
        ) : (
          <>
            <StatRow
              stats={[
                { label: "Balance", value: formatMoney(child.balance, tenant.country), sub: child.dueOn ? `due ${formatShortDate(child.dueOn)}` : "nothing due", alarming: child.balance > 0 },
                { label: "Billed this term", value: formatMoney(child.billed, tenant.country), sub: data.termLabel ?? "" },
                { label: "Paid so far", value: formatMoney(child.billed - child.balance, tenant.country), sub: child.billed > 0 ? `${Math.round(((child.billed - child.balance) / child.billed) * 100)}% of billed` : "" },
              ]}
            />

            <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
              <section className="overflow-hidden rounded-lg border border-line bg-white">
                <header className="border-b border-line px-4 py-3">
                  <h2 className="text-body font-semibold">What this term covers</h2>
                </header>
                <div>
                  {feeItems.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">Fee structure not published yet.</div>
                  ) : (
                    feeItems.map((i) => (
                      <div key={i.id} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                        <span className="text-[13px]">{i.name}</span>
                        <Mono>{formatMoney(i.amount_cents, tenant.country)}</Mono>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <DataTable
                title="Receipts"
                columns={[
                  { key: "when", header: "Date", width: "0.8fr", render: (r: Receipt) => <Mono>{r.when}</Mono> },
                  { key: "ref", header: "Reference", render: (r: Receipt) => <Cell>{r.ref}</Cell> },
                  { key: "amount", header: "Amount", align: "right", render: (r: Receipt) => <Mono>{formatMoney(r.amount, tenant.country)}</Mono> },
                  { key: "st", header: "", align: "right", width: "0.8fr", render: () => <Badge tone="ok">Received</Badge> },
                ]}
                rows={child.receipts}
                rowKey={(r) => r.id}
                minWidth="480px"
                empty={{ title: "No receipts yet.", body: "Payments appear here once the school has confirmed them." }}
              />
            </div>

            {(tenant.payment_paybill || tenant.payment_till || tenant.payment_bank_details) && (
              <section className="mt-4 overflow-hidden rounded-lg border border-line bg-white">
                <header className="border-b border-line px-4 py-3">
                  <h2 className="text-body font-semibold">How to pay</h2>
                  <p className="mt-0.5 text-[12px] text-ink-faint">Pay using any of the school's options below, then upload proof underneath.</p>
                </header>
                <div className="grid gap-2 px-4 py-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                  {tenant.payment_paybill && (
                    <div className="rounded-lg bg-page px-3.5 py-2.5">
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Paybill</span>
                      <Mono>{tenant.payment_paybill}</Mono>
                    </div>
                  )}
                  {tenant.payment_till && (
                    <div className="rounded-lg bg-page px-3.5 py-2.5">
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Till number</span>
                      <Mono>{tenant.payment_till}</Mono>
                    </div>
                  )}
                  {tenant.payment_bank_details && (
                    <div className="rounded-lg bg-page px-3.5 py-2.5">
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Bank</span>
                      <span className="text-[13px]">{tenant.payment_bank_details}</span>
                    </div>
                  )}
                </div>
                {tenant.payment_notes && (
                  <p className="border-t border-line-soft px-4 py-2.5 text-[12px] leading-relaxed text-ink-muted">{tenant.payment_notes}</p>
                )}
              </section>
            )}

            <section className="mt-4 overflow-hidden rounded-lg border border-line bg-white">
              <header className="border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">Payment proof</h2>
                <p className="mt-0.5 text-[12px] text-ink-faint">
                  Paid by bank slip or cash at the office? Upload evidence here for the bursar to confirm.
                </p>
              </header>

              <form onSubmit={handleUploadProof} className="flex flex-wrap items-end gap-3 border-b border-line-soft px-4 py-3.5">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-semibold">File</span>
                  <input
                    key={proofReload}
                    type="file"
                    accept="image/*,.pdf"
                    onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
                    className="block text-[12.5px]"
                  />
                </label>
                <label className="block min-w-[200px] flex-1">
                  <span className="mb-1.5 block text-[12px] font-semibold">Note (optional)</span>
                  <input
                    value={proofNote}
                    onChange={(e) => setProofNote(e.target.value)}
                    placeholder="Paid at the school office"
                    className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[12.5px] outline-none"
                  />
                </label>
                <Button type="submit" variant="accent" disabled={!proofFile || !invoiceId || invoiceLoading || uploadingProof}>
                  {uploadingProof ? "Uploading…" : "Upload proof"}
                </Button>
              </form>

              <div>
                {proofsPending ? (
                  Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3 last:border-0">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-4 w-24 rounded-full" />
                    </div>
                  ))
                ) : !proofs || proofs.length === 0 ? (
                  <div className="px-4 py-6 text-center text-[12.5px] text-ink-faint">No payment proof uploaded yet.</div>
                ) : (
                  proofs.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                      <button
                        type="button"
                        onClick={() => openProof(p.file_path)}
                        className="min-w-0 truncate text-left text-[12.5px] font-medium text-forest hover:underline"
                      >
                        {p.file_name}
                      </button>
                      <div className="flex shrink-0 items-center gap-2">
                        {p.note && <span className="hidden max-w-[160px] truncate text-[11.5px] text-ink-faint sm:inline">{p.note}</span>}
                        <Badge tone={PROOF_TONE[p.status]}>{PROOF_LABEL[p.status]}</Badge>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>

      {open && child && (
        <PayWithMpesaModal
          payeeName={child.name}
          payeeFirst={child.first}
          context={child.cls}
          balanceCents={child.balance}
          invoiceId={invoiceId}
          country={tenant.country}
          initialPhone={formatPhone(profile.phone).replace("+254 ", "0")}
          onClose={() => setOpen(false)}
          onSettled={reload}
        />
      )}
    </>
  );
}
