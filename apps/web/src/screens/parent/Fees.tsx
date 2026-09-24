import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { formatMoney, PAYMENT_FAILURES, itemsForStudent, normaliseMsisdn, payableSuggestions, supabase } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";
import { formatPhone, formatShortDate, type Receipt } from "@figbloom/shared";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { listPaymentProofs, privateDocUrl, uploadPaymentProof, type PaymentProof } from "../../lib/uploads";
import { ChildSwitcher } from "./ChildSwitcher";

type PayState = "idle" | "prompting" | "failed" | "done";

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
 * Real fee items for the term, real receipts, and the M-Pesa pay flow — the
 * same simulation the phone preview uses (there is no sandbox Daraja wired
 * up locally, and only a real Safaricom callback can ever mark a payment
 * "success"), laid out as a modal instead of a separate screen.
 */
export function ParentFees() {
  const { profile, tenant } = useTenantSession();
  const { data, loading, error, child } = useParentData();
  const [params, setParams] = useSearchParams();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
  const [phone, setPhone] = useState(formatPhone(profile.phone).replace("+254 ", "0") || "0722 118 004");
  const [payState, setPayState] = useState<PayState>("idle");
  const [phoneError, setPhoneError] = useState("");

  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofNote, setProofNote] = useState("");
  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofReload, setProofReload] = useState(0);

  const { data: invoiceId } = useAsync(
    () => (child ? fetchCurrentInvoiceId(child.id) : Promise.resolve(null)),
    [child?.id],
  );
  const { data: proofs, loading: proofsLoading } = useAsync(
    () => (invoiceId ? listPaymentProofs(invoiceId) : Promise.resolve([] as PaymentProof[])),
    [invoiceId, proofReload],
  );

  async function handleUploadProof(e: FormEvent) {
    e.preventDefault();
    if (!invoiceId || !proofFile) return;
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
      if (child.balance > 0) {
        setAmount(child.balance);
        setOpen(true);
      }
      const next = new URLSearchParams(params);
      next.delete("pay");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, child?.id]);

  function openPay() {
    if (!child) return;
    setAmount(child.balance);
    setPayState("idle");
    setPhoneError("");
    setOpen(true);
  }

  function closePay() {
    setOpen(false);
    setPayState("idle");
    setPhoneError("");
  }

  function startPay() {
    if (!child) return;
    const p = normaliseMsisdn(phone);
    if (!p.ok) { setPhoneError(p.message); return; }
    if (amount <= 0) { setPhoneError("Enter how much you are paying."); return; }
    setPhoneError("");
    setPayState("prompting");
    // Daraja STK push: the prompt appears on the handset, we wait for the callback.
    window.setTimeout(() => setPayState(amount > child.balance ? "failed" : "done"), 1800);
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
                empty={{ title: "No receipts yet.", body: "Payments made through M-Pesa appear here once confirmed." }}
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
                <Button type="submit" variant="accent" disabled={!proofFile || !invoiceId || uploadingProof}>
                  {uploadingProof ? "Uploading…" : "Upload proof"}
                </Button>
              </form>

              <div>
                {proofsLoading ? (
                  <div className="px-4 py-4 text-[12.5px] text-ink-faint">Loading…</div>
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

      {child && (
        <Modal
          open={open}
          onClose={closePay}
          eyebrow="M-PESA"
          title={
            payState === "done" ? `${formatMoney(amount, tenant.country)} received`
              : payState === "failed" ? "The payment did not go through"
              : payState === "prompting" ? "Check your phone"
              : `Pay for ${child.name}`
          }
          blurb={payState === "idle" ? `${child.cls} · balance ${formatMoney(child.balance, tenant.country)}` : undefined}
          footNote={payState === "idle" ? `A prompt will be sent to ${phone}. Nothing leaves the account until the PIN is entered.` : undefined}
          actions={
            payState === "idle" ? (
              <>
                <Button onClick={closePay}>Cancel</Button>
                <Button variant="accent" onClick={startPay}>Send M-Pesa prompt</Button>
              </>
            ) : payState === "failed" ? (
              <>
                <Button onClick={closePay}>Pay at the school office instead</Button>
                <Button variant="accent" onClick={() => setPayState("idle")}>Try again</Button>
              </>
            ) : payState === "done" ? (
              <Button variant="accent" onClick={closePay}>Done</Button>
            ) : undefined
          }
        >
          {payState === "idle" && (
            <div className="grid gap-4">
              <div>
                <h3 className="mb-2 text-[12.5px] font-semibold">How much?</h3>
                <div className="grid gap-2">
                  {payableSuggestions(child.balance).map((s) => {
                    const on = s.cents > 0 && amount === s.cents;
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setAmount(s.cents)}
                        className="flex items-center justify-between rounded-lg border-[1.5px] bg-white px-3.5 py-2.5 text-left"
                        style={{ borderColor: on ? "var(--accent)" : "#EAE6E5" }}
                      >
                        <span className="text-[13px] font-medium">{s.label}</span>
                        {s.cents > 0 && <span className="font-mono text-[12.5px]">{formatMoney(s.cents, tenant.country)}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-semibold">Amount</span>
                <input
                  value={amount ? String(amount / 100) : ""}
                  inputMode="numeric"
                  onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9]/g, "")) * 100)}
                  className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[14px] outline-none"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-semibold">M-Pesa number</span>
                <input
                  value={phone}
                  inputMode="tel"
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 font-mono text-[14px] outline-none"
                  style={{ borderColor: phoneError ? "#B8460A" : "#D3DAD5" }}
                />
                {phoneError && <span className="mt-1.5 block text-[11.5px] text-warn-ink">{phoneError}</span>}
              </label>
            </div>
          )}

          {payState === "prompting" && (
            <div className="py-6 text-center">
              <div className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-[3px] border-line" style={{ borderTopColor: "var(--accent)" }} />
              <p className="mx-auto max-w-[320px] text-[13px] leading-relaxed text-ink-muted">
                An M-Pesa prompt has been sent to {phone}. Enter the PIN when it appears. Do not close this window.
              </p>
            </div>
          )}

          {payState === "failed" && (
            <p className="text-[13px] leading-relaxed text-ink-muted">{PAYMENT_FAILURES.timeout}</p>
          )}

          {payState === "done" && (
            <div>
              <p className="text-[13px] leading-relaxed text-ink-muted">
                {child.first}'s balance is now {formatMoney(Math.max(child.balance - amount, 0), tenant.country)}. The receipt will appear
                above once the school's system confirms it.
              </p>
              <div className="mt-4 rounded-lg border border-line bg-page p-3.5">
                {[["Paid", formatMoney(amount, tenant.country)], ["For", child.name], ["Method", `M-Pesa ${phone}`]].map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                    <span className="text-ink-muted">{k}</span><span className="font-medium">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
