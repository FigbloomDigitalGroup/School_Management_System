import { useState } from "react";
import {
  PAYMENT_SMS_FLAG_LABEL, fetchAllPages, formatMoney, itemsForStudent, paymentSmsFlags, supabase, targetYearLabel, totalCents, yearGroupsOf, yearLabel,
} from "@figbloom/shared";
import type { ClassLevel, FeeItem, PaymentSmsSource, Term, YearGroup } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TextField } from "../../components/ui/Field";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { privateDocUrl } from "../../lib/uploads";
import { SignTermInvoices } from "../../components/signatures/InvoiceSignatures";
import { TermReceipts } from "../../components/signatures/ReceiptSignatures";
import { FeeItemsEditor } from "./FeeItemsEditor";
import { BillTermModal, RecordPaymentModal, type PayableInvoice, type ProofToConfirm } from "./FeeCollection";

interface OutstandingRow {
  id: string;
  name: string;
  cls: string;
  /** The invoice total, charges included. */
  billed: number;
  /** The part of `billed` that is charges (a lost textbook). */
  charges: number;
  paid: number;
}

interface RawInvoiceRow {
  id: string;
  total_cents: number;
  charges_cents: number;
  paid_cents: number;
  students: { full_name: string; classes: { name: string } | null } | null;
}

/** What a pasted confirmation SMS said (payment_proofs.sms_text and the txn_* fields parsed from it). */
interface ProofSms {
  sms_text: string | null;
  txn_source: PaymentSmsSource | null;
  txn_code: string | null;
  txn_amount_cents: number | null;
  txn_at: string | null;
  txn_payee: string | null;
  txn_payee_number: string | null;
  txn_account: string | null;
}

interface PendingProofRow extends ProofSms {
  id: string;
  file_path: string | null;
  file_name: string | null;
  note: string | null;
  uploaded_at: string;
  studentName: string;
  cls: string;
  invoice: PayableInvoice | null;
}

interface RawProofRow extends ProofSms {
  id: string;
  file_path: string | null;
  file_name: string | null;
  note: string | null;
  uploaded_at: string;
  fee_invoices: { id: string; total_cents: number; paid_cents: number; students: { full_name: string; classes: { name: string } | null } | null } | null;
}

interface FeesData {
  term: Term | null;
  feeItems: FeeItem[];
  formLevels: YearGroup[];
  invoices: { total_cents: number; paid_cents: number }[];
  outstanding: OutstandingRow[];
  pendingProofs: PendingProofRow[];
}

async function fetchFees(tenantId: string): Promise<FeesData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const [{ data: feeItemRows }, rawInvoices, proofsRes, { data: classRows }] = await Promise.all([
    termId
      ? sb.from("fee_items").select("*").eq("tenant_id", tenantId).eq("term_id", termId).returns<FeeItem[]>()
      : Promise.resolve({ data: [] as FeeItem[] }),
    // Every invoice, not the first 1000: the totals below are the school's whole term.
    termId
      ? fetchAllPages<RawInvoiceRow>((from, to) =>
          sb.from("fee_invoices").select("id,total_cents,charges_cents,paid_cents,students(full_name,classes(name))")
            .eq("tenant_id", tenantId).eq("term_id", termId).order("id").range(from, to).returns<RawInvoiceRow[]>())
      : Promise.resolve([] as RawInvoiceRow[]),
    // Payment proofs are keyed by invoice, not term — reach the current term
    // through fee_invoices the same way the outstanding-balances query does.
    termId
      ? sb.from("payment_proofs")
          .select("id,file_path,file_name,note,uploaded_at,sms_text,txn_source,txn_code,txn_amount_cents,txn_at,txn_payee,txn_payee_number,txn_account,fee_invoices!inner(id,total_cents,paid_cents,term_id,students(full_name,classes(name)))")
          .eq("tenant_id", tenantId)
          .eq("status", "pending")
          .eq("fee_invoices.term_id", termId)
          .order("uploaded_at", { ascending: true })
          .returns<RawProofRow[]>()
      : Promise.resolve({ data: [] as RawProofRow[] }),
    sb.from("classes").select("level, form_level").eq("tenant_id", tenantId).returns<{ level: ClassLevel; form_level: number }[]>(),
  ]);

  // Year groups, not bare form_levels: Grade 1 and Form 1 are both 1.
  const formLevels = yearGroupsOf(classRows ?? []);

  const invoices = rawInvoices.map((r) => ({ total_cents: r.total_cents, paid_cents: r.paid_cents }));

  const outstanding = rawInvoices
    .filter((r) => r.paid_cents < r.total_cents)
    .map((r) => ({
      id: r.id,
      name: r.students?.full_name ?? "Unknown learner",
      cls: r.students?.classes?.name ?? "—",
      billed: r.total_cents,
      charges: r.charges_cents,
      paid: r.paid_cents,
    }))
    .sort((a, b) => (b.billed - b.paid) - (a.billed - a.paid))
    .slice(0, 10);

  const pendingProofs: PendingProofRow[] = (proofsRes.data ?? []).map((r) => {
    const studentName = r.fee_invoices?.students?.full_name ?? "Unknown learner";
    const cls = r.fee_invoices?.students?.classes?.name ?? "—";
    const { fee_invoices: _invoice, ...proof } = r;
    return {
      ...proof,
      studentName,
      cls,
      invoice: r.fee_invoices
        ? { id: r.fee_invoices.id, studentName, cls, balanceCents: Math.max(r.fee_invoices.total_cents - r.fee_invoices.paid_cents, 0) }
        : null,
    };
  });

  return { term: term ?? null, feeItems: feeItemRows ?? [], formLevels, invoices, outstanding, pendingProofs };
}

export function Fees() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchFees(tenant.id), [tenant.id, reloadKey]);
  // A reloadKey refetch keeps what's already on screen; switching to a different school's
  // data must not show the previous one's meanwhile — skeleton for those only.
  const [loadedFor, setLoadedFor] = useState(tenant.id);
  if (!loading && loadedFor !== tenant.id) setLoadedFor(tenant.id);
  const pending = loading && (!data || loadedFor !== tenant.id);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [editingItems, setEditingItems] = useState(false);
  const [billing, setBilling] = useState(false);
  // null: closed. {}: open with a learner search. Otherwise that invoice (and proof, when confirming one).
  const [recording, setRecording] = useState<{ invoice?: PayableInvoice; proof?: PendingProofRow } | null>(null);
  const [rejecting, setRejecting] = useState<PendingProofRow | null>(null);

  function done(message: string) {
    setBilling(false);
    setRecording(null);
    setReloadKey((k) => k + 1);
    toast(message);
  }

  // Confirming goes through RecordPaymentModal instead: a proof is only
  // confirmed together with the payment it shows, so the balance moves too.
  // The reason is shown to the family, so they know whether to resubmit or call.
  async function rejectProof(id: string, reason: string): Promise<boolean> {
    const { error: updateError } = await supabase()
      .from("payment_proofs")
      .update({ status: "rejected", reviewed_by: profile.id, reviewed_at: new Date().toISOString(), rejection_reason: reason })
      .eq("id", id);
    if (updateError) {
      toast(`Could not update: ${updateError.message}`, "error");
      return false;
    }
    setReviewedIds((s) => new Set(s).add(id));
    setRejecting(null);
    toast("Payment proof rejected");
    return true;
  }

  async function openProof(path: string) {
    try {
      const url = await privateDocUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open that file.", "error");
    }
  }

  // What each year group actually pays in total, day vs boarding — not just
  // one representative figure, since year-scoped items (KCSE registration
  // etc.) mean the total genuinely differs year to year, not only by residence.
  const totalsByForm = data
    ? data.formLevels.map((g) => ({
        key: g.key,
        label: yearLabel(g.level, g.year),
        day: totalCents(itemsForStudent(data.feeItems, { boarding: false }, g.year, g.level)),
        boarder: totalCents(itemsForStudent(data.feeItems, { boarding: true }, g.year, g.level)),
      }))
    : [];

  const billed = data ? data.invoices.reduce((a, i) => a + i.total_cents, 0) : 0;
  const collected = data ? data.invoices.reduce((a, i) => a + i.paid_cents, 0) : 0;
  const outstandingTotal = billed - collected;
  const collectedPct = billed > 0 ? Math.round((collected / billed) * 100) : 0;
  const owingCount = data ? data.invoices.filter((i) => i.paid_cents < i.total_cents).length : 0;
  const fullyPaidCount = data ? data.invoices.filter((i) => i.paid_cents >= i.total_cents && i.total_cents > 0).length : 0;
  const fullyPaidPct = data && data.invoices.length > 0 ? Math.round((fullyPaidCount / data.invoices.length) * 100) : 0;

  return (
    <>
      <PageHead
        eyebrow={data?.term ? `Fees · ${data.term.name.toLowerCase()}` : "Fees"}
        title="Fee structure and collection"
        blurb="Published once at the start of term. Changing an amount after publication notifies every affected parent, so the composer says how many before you confirm."
        actions={
          <>
            <Button onClick={() => setBilling(true)} disabled={!data?.term}>Bill learners</Button>
            {data?.term && <SignTermInvoices key={`${data.term.id}:${reloadKey}`} termId={data.term.id} />}
            <Button variant="accent" onClick={() => setRecording({})} disabled={!data?.term}>Record a payment</Button>
          </>
        }
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load fees: {error.message}
          </p>
        ) : pending || !data ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
        ) : (
          <>
          {data.term && data.invoices.length === 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-sunken px-4 py-3">
              <p className="text-[13px] leading-relaxed">
                No invoices yet for {data.term.name}. {data.feeItems.length > 0
                  ? "Parents see nothing owing until learners are billed."
                  : "Add this term's fee items, then bill learners."}
              </p>
              {data.feeItems.length > 0 && <Button variant="accent" onClick={() => setBilling(true)}>Bill learners</Button>}
            </div>
          )}
          <StatRow
            stats={[
              { label: "Billed this term", value: formatMoney(billed, tenant.country), sub: `${data.invoices.length.toLocaleString()} learners` },
              { label: "Collected", value: formatMoney(collected, tenant.country), sub: `${collectedPct}% of billed` },
              { label: "Outstanding", value: formatMoney(outstandingTotal, tenant.country), sub: `${owingCount.toLocaleString()} learners owe a balance`, alarming: true },
              { label: "Fully paid", value: `${fullyPaidPct}%`, sub: `${fullyPaidCount.toLocaleString()} invoices cleared` },
            ]}
          />
          </>
        )}

        <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
          <section className="overflow-hidden rounded-lg border border-line">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">{data?.term ? data.term.name : "Term"} fee items</h2>
              <Button onClick={() => setEditingItems(true)} disabled={!data?.term}>Edit</Button>
            </header>
            <div>
              {error ? null : pending || !data ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))
              ) : (
                <>
                  {data.feeItems.map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">{i.name}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-faint">
                          {i.applies_to === "all" ? "Every learner"
                            : i.applies_to === "boarders" ? "Boarders only"
                            : i.applies_to === "day" ? "Day scholars only"
                            : `${targetYearLabel(i.level, i.form_level ?? 0)} only`}
                        </div>
                      </div>
                      <Mono>{formatMoney(i.amount_cents, tenant.country)}</Mono>
                    </div>
                  ))}
                  {totalsByForm.length > 0 && (
                    <div className="bg-sunken px-4 py-3">
                      <div className="mb-2 text-[12px] font-semibold">What each year group pays in total</div>
                      <div className="grid gap-1.5">
                        <div className="grid gap-2 text-[11px] font-semibold text-ink-faint" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                          <span>Year</span><span className="text-right">Day</span><span className="text-right">Boarder</span>
                        </div>
                        {totalsByForm.map((t) => (
                          <div key={t.key} className="grid gap-2 text-[13px]" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                            <span className="font-medium">{t.label}</span>
                            <div className="text-right"><Mono>{formatMoney(t.day, tenant.country)}</Mono></div>
                            <div className="text-right"><Mono>{formatMoney(t.boarder, tenant.country)}</Mono></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {error ? null : pending || !data ? (
            <TableSkeleton rows={6} />
          ) : (
            <DataTable
              title="Largest outstanding balances"
              columns={[
                { key: "name", header: "Learner", width: "1.6fr", render: (r: OutstandingRow) => <Cell sub={r.cls}>{r.name}</Cell> },
                { key: "billed", header: "Billed", align: "right", render: (r: OutstandingRow) => (
                  <Cell sub={r.charges > 0 ? `incl. ${formatMoney(r.charges, tenant.country)} charges` : undefined}>
                    <Mono>{formatMoney(r.billed, tenant.country)}</Mono>
                  </Cell>
                ) },
                { key: "paid", header: "Paid", align: "right", render: (r: OutstandingRow) => <Mono>{formatMoney(r.paid, tenant.country)}</Mono> },
                { key: "bal", header: "Balance", align: "right", render: (r: OutstandingRow) => (
                  <span className="font-mono text-[12.5px] font-medium text-warn-ink">{formatMoney(r.billed - r.paid, tenant.country)}</span>
                ) },
                { key: "st", header: "", align: "right", render: (r: OutstandingRow) => (
                  <Badge tone={r.paid === 0 ? "warn" : "muted"}>{r.paid === 0 ? "Nothing paid" : "Part paid"}</Badge>
                ) },
                { key: "pay", header: "", align: "right", render: (r: OutstandingRow) => (
                  <Button onClick={() => setRecording({ invoice: { id: r.id, studentName: r.name, cls: r.cls, balanceCents: r.billed - r.paid } })}>
                    Record payment
                  </Button>
                ) },
              ]}
              rows={data.outstanding}
              rowKey={(r) => r.id}
              minWidth="780px"
              empty={{ title: "Every balance is cleared", body: "Nothing outstanding this term. That is rare — worth telling the board." }}
            />
          )}
        </div>

        <div className="mt-4">
          {error ? null : pending || !data ? (
            <TableSkeleton rows={3} />
          ) : (
            <DataTable
              title="Payment proof awaiting review"
              columns={[
                { key: "student", header: "Learner", width: "1.4fr", render: (r: PendingProofRow) => <Cell sub={r.cls}>{r.studentName}</Cell> },
                { key: "file", header: "Evidence", width: "1.6fr", render: (r: PendingProofRow) => {
                  const flags = r.sms_text
                    ? paymentSmsFlags(
                        { code: r.txn_code, amountCents: r.txn_amount_cents, payeeNumber: r.txn_payee_number, paidAt: r.txn_at },
                        { balanceCents: r.invoice?.balanceCents ?? null, paybill: tenant.payment_paybill, till: tenant.payment_till },
                      )
                    : [];
                  const path = r.file_path;
                  return (
                    <div className="min-w-0">
                      {r.txn_code && (
                        <div className="truncate font-mono text-[12.5px]" title={r.sms_text ?? undefined}>
                          {r.txn_code}
                          {r.txn_amount_cents !== null && <span className="text-ink-faint"> · {formatMoney(r.txn_amount_cents, tenant.country)}</span>}
                        </div>
                      )}
                      {path && (
                        <button
                          type="button"
                          onClick={() => openProof(path)}
                          className="block min-w-0 max-w-full truncate text-left text-[12.5px] font-medium text-forest hover:underline"
                        >
                          {r.file_name}
                        </button>
                      )}
                      {flags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {flags.map((f) => <Badge key={f} tone="warn">{PAYMENT_SMS_FLAG_LABEL[f]}</Badge>)}
                        </div>
                      )}
                    </div>
                  );
                } },
                { key: "note", header: "Note", render: (r: PendingProofRow) => <Cell>{r.note ?? "—"}</Cell> },
                { key: "when", header: "Uploaded", width: "0.8fr", render: (r: PendingProofRow) => (
                  <Mono>{new Date(r.uploaded_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</Mono>
                ) },
                { key: "actions", header: "", align: "right", width: "1.2fr", render: (r: PendingProofRow) => (
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => setRejecting(r)}>Reject</Button>
                    <Button variant="accent" disabled={!r.invoice} onClick={() => r.invoice && setRecording({ invoice: r.invoice, proof: r })}>Confirm</Button>
                  </div>
                ) },
              ]}
              rows={data.pendingProofs.filter((r) => !reviewedIds.has(r.id))}
              rowKey={(r) => r.id}
              minWidth="820px"
              empty={{ title: "Nothing to review", body: "Bank slips, pasted M-Pesa messages and other payment evidence parents send will appear here for confirmation." }}
            />
          )}
        </div>

        {data?.term && (
          <div className="mt-4">
            <TermReceipts termId={data.term.id} reloadKey={reloadKey} />
          </div>
        )}
      </div>

      {editingItems && data?.term && (
        <FeeItemsEditor
          termId={data.term.id}
          termName={data.term.name}
          tenantId={tenant.id}
          country={tenant.country}
          onClose={() => { setEditingItems(false); setReloadKey((k) => k + 1); }}
        />
      )}

      {billing && data?.term && (
        <BillTermModal
          term={data.term}
          feeItems={data.feeItems}
          tenantId={tenant.id}
          country={tenant.country}
          onClose={() => setBilling(false)}
          onBilled={done}
        />
      )}

      {recording && data?.term && (
        <RecordPaymentModal
          termId={data.term.id}
          country={tenant.country}
          invoice={recording.invoice}
          proof={recording.proof && proofToConfirm(recording.proof)}
          onClose={() => setRecording(null)}
          onRecorded={done}
        />
      )}

      {rejecting && (
        <RejectProofModal proof={rejecting} onClose={() => setRejecting(null)} onReject={(reason) => rejectProof(rejecting.id, reason)} />
      )}
    </>
  );
}

function proofToConfirm(p: PendingProofRow): ProofToConfirm {
  return {
    id: p.id,
    fileName: p.file_name,
    note: p.note,
    smsText: p.sms_text,
    code: p.txn_code,
    amountCents: p.txn_amount_cents,
    // Airtel Money and bank transfers are recorded as bank: there is no separate method for them.
    method: p.txn_source === "mpesa" ? "mpesa" : p.sms_text ? "bank" : null,
  };
}

const REJECT_REASONS = [
  "The transaction code is not on the school's statement.",
  "The amount on the statement is different.",
  "This payment is for a different learner.",
  "The file or message can't be read.",
];

function RejectProofModal({ proof, onClose, onReject }: {
  proof: PendingProofRow;
  onClose: () => void;
  onReject: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const ready = reason.trim().length >= 3 && !saving;

  async function submit() {
    if (!ready) return;
    setSaving(true);
    if (!(await onReject(reason.trim().slice(0, 300)))) setSaving(false);
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Fees"
      title={`Reject ${proof.txn_code ?? proof.file_name ?? "this proof"}`}
      blurb={`${proof.studentName}'s family will see this reason, and can send the proof again if it was a mistake.`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ready} onClick={() => void submit()}>{saving ? "Rejecting…" : "Reject proof"}</Button>
        </>
      }
      width={520}
    >
      <div className="grid gap-3">
        {proof.sms_text && <pre className="whitespace-pre-wrap rounded-md bg-sunken px-3 py-2 font-mono text-[12px] text-ink-muted">{proof.sms_text}</pre>}
        <div className="flex flex-wrap gap-1.5">
          {REJECT_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)}
              className="rounded-full border border-line px-2.5 py-1 text-left text-[12px] hover:bg-page">
              {r}
            </button>
          ))}
        </div>
        <TextField id="reject-reason" label="Reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}
