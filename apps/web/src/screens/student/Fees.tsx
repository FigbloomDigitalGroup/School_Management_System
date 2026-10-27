import { useState } from "react";
import { formatMoney, formatPhone, itemsForStudent, loadStudentFeeData, type Receipt } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { PayWithMpesaModal } from "../../components/PayWithMpesaModal";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { listPaymentProofs, privateDocUrl, type PaymentProof } from "../../lib/uploads";
import { PaymentProofForm, ProofLabel } from "../../components/PaymentProofForm";
import { FeeChargeLines } from "../../components/FeeChargeLines";

const PROOF_TONE: Record<PaymentProof["status"], Tone> = { pending: "muted", confirmed: "ok", rejected: "warn" };
const PROOF_LABEL: Record<PaymentProof["status"], string> = { pending: "Pending review", confirmed: "Confirmed", rejected: "Rejected" };

/**
 * A student with no guardian on file (the common case for an adult higher-ed
 * learner, FIG-329) still needs to see their balance and pay it — this is the
 * student-self equivalent of parent/Fees.tsx, same PayWithMpesaModal (only a
 * real Safaricom callback can ever mark a payment "success"), keyed off the
 * student's own profile instead of a guardian link.
 */
export function StudentFees() {
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => loadStudentFeeData(profile.id), [profile.id, reloadKey]);
  const toast = useToast();

  const [open, setOpen] = useState(false);

  const [proofReload, setProofReload] = useState(0);

  const invoiceId = data?.invoiceId ?? null;
  // Tagged with the invoice they belong to, so the proofs fetched for "no
  // invoice yet" (while fees load) never read as "none uploaded" — but a
  // reload after an upload keeps the list up.
  const { data: proofsFor, loading: proofsLoading } = useAsync(
    async () => ({ invoiceId, proofs: invoiceId ? await listPaymentProofs(invoiceId) : ([] as PaymentProof[]) }),
    [invoiceId, proofReload],
  );
  const proofs = proofsFor?.invoiceId === invoiceId ? proofsFor.proofs : null;
  const proofsPending = !proofs && proofsLoading;

  async function openProof(path: string) {
    try {
      const url = await privateDocUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open that file.", "error");
    }
  }

  function openPay() {
    setOpen(true);
  }

  const feeItems = data ? itemsForStudent(data.feeItems as never, { boarding: data.boarding }, data.formLevel, data.classLevel) : [];

  return (
    <>
      <PageHead
        eyebrow={data ? `${data.className || "No class"} · ADM ${data.admissionNo}` : "Fees"}
        title="Fees"
        blurb={data?.termLabel ? `${data.termLabel} fee balance, structure and receipts.` : undefined}
        actions={data && data.balance > 0 ? <Button variant="accent" onClick={openPay}>Pay with M-Pesa</Button> : undefined}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load fees: {error.message}
          </p>
        ) : loading ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
        ) : !data ? (
          <EmptyState title="No learner record" body="This login is not yet linked to a learner record. Contact the school office." />
        ) : (
          <>
            <StatRow
              stats={[
                { label: "Balance", value: formatMoney(data.balance, tenant.country), sub: data.dueOn ? `due ${data.dueOn}` : "nothing due", alarming: data.balance > 0 },
                { label: "Billed this term", value: formatMoney(data.billed, tenant.country), sub: data.termLabel ?? "" },
                { label: "Paid so far", value: formatMoney(data.billed - data.balance, tenant.country), sub: data.billed > 0 ? `${Math.round(((data.billed - data.balance) / data.billed) * 100)}% of billed` : "" },
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
                  <FeeChargeLines charges={data.charges} country={tenant.country} />
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
                rows={data.receipts}
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
                  Paid to the school's paybill, by bank or at the office? Paste the confirmation SMS or upload the slip for the bursar to confirm.
                </p>
              </header>

              <PaymentProofForm
                tenantId={tenant.id}
                invoiceId={invoiceId}
                uploadedBy={profile.id}
                balanceCents={data.balance}
                country={tenant.country}
                school={{ paybill: tenant.payment_paybill, till: tenant.payment_till }}
                onSent={() => setProofReload((n) => n + 1)}
              />

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
                    <div key={p.id} className="border-b border-line-soft px-4 py-2.5 last:border-0">
                      <div className="flex items-center justify-between gap-3">
                        <ProofLabel proof={p} country={tenant.country} onOpen={openProof} />
                        <div className="flex shrink-0 items-center gap-2">
                          {p.note && <span className="hidden max-w-[160px] truncate text-[11.5px] text-ink-faint sm:inline">{p.note}</span>}
                          <Badge tone={PROOF_TONE[p.status]}>{PROOF_LABEL[p.status]}</Badge>
                        </div>
                      </div>
                      {p.status === "rejected" && p.rejection_reason && (
                        <p className="mt-1 text-[12px] text-warn-ink">Not accepted: {p.rejection_reason}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>

      {open && data && (
        <PayWithMpesaModal
          payeeName={profile.full_name}
          payeeFirst={profile.full_name.split(" ")[0] ?? profile.full_name}
          context={data.className || "No class"}
          balanceCents={data.balance}
          invoiceId={invoiceId}
          country={tenant.country}
          initialPhone={formatPhone(profile.phone).replace("+254 ", "0")}
          onClose={() => setOpen(false)}
          onSettled={() => setReloadKey((n) => n + 1)}
        />
      )}
    </>
  );
}
