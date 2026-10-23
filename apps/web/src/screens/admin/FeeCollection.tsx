import { useEffect, useState } from "react";
import { fetchAllPages, formatMoney, planTermBilling, supabase, type ClassLevel, type FeeItem, type Term } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { SelectField, TextField } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";

// ---------------------------------------------------------------- billing run

interface StudentRow { id: string; boarding: boolean; classes: { form_level: number; level: ClassLevel } | null }

async function fetchBillingInputs(tenantId: string, termId: string) {
  const sb = supabase();
  const [students, invoiced] = await Promise.all([
    fetchAllPages<StudentRow>((from, to) =>
      sb.from("students").select("id, boarding, classes(form_level, level)")
        .eq("tenant_id", tenantId).eq("active", true).order("id").range(from, to).returns<StudentRow[]>()),
    fetchAllPages<{ student_id: string }>((from, to) =>
      sb.from("fee_invoices").select("student_id").eq("term_id", termId).order("id").range(from, to)),
  ]);
  return { students, invoiced: new Set(invoiced.map((i) => i.student_id)) };
}

/** Fees are due on opening day; billing after that gives families two weeks rather than an instant "overdue". */
function defaultDueOn(term: Term): string {
  const inTwoWeeks = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  return term.starts_on > inTwoWeeks ? term.starts_on : inTwoWeeks;
}

const CHUNK = 500;

/**
 * Creates this term's invoices from its fee items, one per active learner,
 * with the same itemsForStudent() maths the parent's bill breakdown uses.
 * Learners already invoiced for the term are left alone, so running it again
 * after admitting new learners only bills the new ones.
 */
export function BillTermModal({ term, feeItems, tenantId, country, onClose, onBilled }: {
  term: Term; feeItems: FeeItem[]; tenantId: string; country: string;
  onClose: () => void; onBilled: (message: string) => void;
}) {
  const { data, loading, error } = useAsync(() => fetchBillingInputs(tenantId, term.id), [tenantId, term.id]);
  const [dueOn, setDueOn] = useState(() => defaultDueOn(term));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const plan = data
    ? planTermBilling(
        data.students.map((s) => ({ id: s.id, boarding: s.boarding, formLevel: s.classes?.form_level ?? null, classLevel: s.classes?.level ?? null })),
        feeItems, data.invoiced,
      )
    : null;

  async function bill() {
    if (!plan || !dueOn) return;
    setSaving(true);
    setSaveError("");
    try {
      const rows = plan.invoices.map((i) => ({ ...i, tenant_id: tenantId, term_id: term.id, due_on: dueOn }));
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error: insertError } = await supabase().from("fee_invoices")
          .upsert(rows.slice(i, i + CHUNK), { onConflict: "student_id,term_id", ignoreDuplicates: true });
        if (insertError) throw new Error(insertError.message);
      }
      await supabase().rpc("log_admin_event", {
        p_tenant_id: tenantId,
        p_event: `${term.name} billed: ${rows.length} invoices, ${formatMoney(plan.totalCents, country)}, due ${dueOn}`,
        p_category: "financial",
        p_metadata: { term_id: term.id, invoices: rows.length, total_cents: plan.totalCents, due_on: dueOn },
      });
      onBilled(`${rows.length.toLocaleString()} invoices created for ${term.name}`);
    } catch (err) {
      // Invoices are created in batches; any already written stay, and running this again picks up the rest.
      setSaveError(err instanceof Error ? err.message : "Could not create the invoices.");
    } finally {
      setSaving(false);
    }
  }

  const count = plan?.invoices.length ?? 0;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Fees"
      title={`Bill learners for ${term.name}`}
      blurb="One invoice per active learner, totalling the fee items that apply to them."
      footNote="Editing fee items later doesn't change invoices already created."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!plan || count === 0 || !dueOn || saving} onClick={() => void bill()}>
            {saving ? "Creating…" : `Create ${count.toLocaleString()} invoice${count === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-[13px] text-warn-ink">Could not load learners: {error.message}</p>
      ) : loading || !plan ? (
        <div className="grid gap-2"><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-56" /></div>
      ) : (
        <div className="grid gap-4">
          {feeItems.length === 0 ? (
            <p className="text-[13px] text-warn-ink">This term has no fee items yet. Add them first, then bill.</p>
          ) : (
            <ul className="grid gap-1.5 text-[13px] leading-relaxed">
              <li>
                <span className="font-semibold">{count.toLocaleString()}</span> learner{count === 1 ? "" : "s"} will be billed,{" "}
                <span className="font-mono font-medium">{formatMoney(plan.totalCents, country)}</span> in total.
              </li>
              {plan.alreadyBilled > 0 && (
                <li className="text-ink-muted">{plan.alreadyBilled.toLocaleString()} already have an invoice for this term and are left as they are.</li>
              )}
              {plan.nothingApplies > 0 && (
                <li className="text-ink-muted">{plan.nothingApplies.toLocaleString()} have no fee items that apply to them, so get no invoice.</li>
              )}
            </ul>
          )}
          <TextField id="bill-due" label="Due date" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} error={saveError || undefined} />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- record a payment

export interface PayableInvoice {
  id: string;
  studentName: string;
  cls: string;
  balanceCents: number;
}

const METHODS = [
  { value: "cash", label: "Cash", refLabel: "Receipt book number", refHint: "Optional for cash." },
  { value: "mpesa", label: "M-Pesa to the school's paybill/till", refLabel: "M-Pesa receipt", refHint: "The code on the confirmation SMS, e.g. SFC1234ABC. Each receipt can only be recorded once." },
  { value: "bank", label: "Bank deposit or transfer", refLabel: "Slip or transaction number", refHint: "As printed on the deposit slip." },
  { value: "cheque", label: "Cheque", refLabel: "Cheque number", refHint: "Record it once the cheque has cleared." },
] as const;
type Method = (typeof METHODS)[number]["value"];

interface InvoiceSearchRow {
  id: string;
  total_cents: number;
  paid_cents: number;
  students: { full_name: string; admission_no: string; classes: { name: string } | null } | null;
}

async function searchInvoices(termId: string, q: string): Promise<PayableInvoice[]> {
  const term = q.replace(/[%,()]/g, " ").trim();
  const { data, error } = await supabase().from("fee_invoices")
    .select("id, total_cents, paid_cents, students!inner(full_name, admission_no, classes(name))")
    .eq("term_id", termId)
    .or(`full_name.ilike.%${term}%,admission_no.ilike.%${term}%`, { referencedTable: "students" })
    .limit(8)
    .returns<InvoiceSearchRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    studentName: r.students ? `${r.students.full_name} · ${r.students.admission_no}` : "Unknown learner",
    cls: r.students?.classes?.name ?? "—",
    balanceCents: Math.max(r.total_cents - r.paid_cents, 0),
  }));
}

/**
 * The one way the office credits an invoice outside the M-Pesa prompt: cash
 * at the bursar's window, a bank slip, a cheque, or M-Pesa paid straight to
 * the school's paybill. Goes through record_payment(), which writes a real
 * payment (so the balance moves the same way an M-Pesa prompt moves it),
 * confirms the parent's uploaded proof when it came from one, and logs it.
 */
export function RecordPaymentModal({ termId, country, invoice: preset, proof, onClose, onRecorded }: {
  termId: string;
  country: string;
  invoice?: PayableInvoice;
  /** Recording the payment a parent's uploaded proof shows; confirms the proof too. */
  proof?: { id: string; fileName: string; note: string | null };
  onClose: () => void;
  onRecorded: (message: string) => void;
}) {
  const [invoice, setInvoice] = useState<PayableInvoice | undefined>(preset);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PayableInvoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>(proof ? "bank" : "cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (invoice) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      searchInvoices(termId, q).then(setResults).catch(() => setResults([])).finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, invoice, termId]);

  const m = METHODS.find((x) => x.value === method)!;
  const cents = Math.round(parseFloat(amount.replace(/,/g, "")) * 100);

  async function save() {
    if (!invoice) return;
    setError("");
    if (!Number.isFinite(cents) || cents <= 0) { setError("Enter the amount received."); return; }
    if (cents > invoice.balanceCents) { setError(`That is more than the ${formatMoney(invoice.balanceCents, country)} still owed.`); return; }
    if (method !== "cash" && !reference.trim()) { setError(`Enter the ${m.refLabel.toLowerCase()}.`); return; }
    setSaving(true);
    try {
      const { error: rpcError } = await supabase().rpc("record_payment", {
        p_invoice_id: invoice.id,
        p_amount_cents: cents,
        p_method: method,
        p_reference: reference.trim() || null,
        p_proof_id: proof?.id ?? null,
      });
      if (rpcError) throw new Error(rpcError.message);
      onRecorded(`${formatMoney(cents, country)} recorded for ${invoice.studentName.split(" · ")[0]}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the payment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Fees"
      title={proof ? "Confirm payment proof" : "Record a payment"}
      blurb={proof
        ? `Check ${proof.fileName} and enter what it shows. The balance only moves once the payment is recorded.`
        : "For money received outside the M-Pesa prompt in the app."}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!invoice || saving} onClick={() => void save()}>
            {saving ? "Recording…" : proof ? "Confirm and record" : "Record payment"}
          </Button>
        </>
      }
      width={540}
    >
      <div className="grid gap-3.5">
        {invoice ? (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-page px-3.5 py-3">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold">{invoice.studentName}</div>
              <div className="text-[12px] text-ink-faint">{invoice.cls}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-ink-faint">Balance</div>
              <div className="font-mono text-[13px] font-medium">{formatMoney(invoice.balanceCents, country)}</div>
              {!preset && (
                <button type="button" onClick={() => { setInvoice(undefined); setQuery(""); }} className="mt-1 text-[12px] font-semibold text-forest hover:underline">Change</button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <TextField id="pay-search" label="Learner" placeholder="Name or admission number" value={query} onChange={(e) => setQuery(e.target.value)}
              hint={searching ? "Searching…" : query.trim().length >= 2 && results.length === 0 ? "No invoice this term matches." : undefined} />
            {results.length > 0 && (
              <ul className="mt-1.5 overflow-hidden rounded-lg border border-line">
                {results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setInvoice(r)}
                      className="flex w-full items-center justify-between gap-3 border-b border-line-soft px-3.5 py-2.5 text-left last:border-0 hover:bg-page">
                      <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{r.studentName}</span><span className="text-[11.5px] text-ink-faint">{r.cls}</span></span>
                      <span className="font-mono text-[12.5px]">{formatMoney(r.balanceCents, country)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {proof?.note && <p className="rounded-md bg-sunken px-3 py-2 text-[12.5px] text-ink-muted">Parent's note: {proof.note}</p>}

        <TextField id="pay-amount" label="Amount received" inputMode="decimal" mono placeholder="e.g. 15000" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <SelectField id="pay-method" label="How it was paid" value={method} onChange={(e) => setMethod(e.target.value as Method)}
          options={METHODS.map((x) => ({ value: x.value, label: x.label }))} />
        <TextField id="pay-ref" label={m.refLabel} mono value={reference} onChange={(e) => setReference(e.target.value)} hint={error ? undefined : m.refHint} error={error || undefined} />
      </div>
    </Modal>
  );
}
