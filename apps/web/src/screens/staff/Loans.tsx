import { useState } from "react";
import { formatMoney, formatShortDate } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { StatRow } from "../../components/ui/StatCard";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

type LoanKind = "salary_advance" | "emergency" | "welfare";
type LoanStatus = "pending" | "active" | "repaid" | "rejected";

interface Loan {
  id: string;
  kind: LoanKind;
  amountCents: number;
  months: number;
  /** Instalments already deducted from salary. */
  paid: number;
  requestedOn: string;
  status: LoanStatus;
  reason?: string;
  note?: string;
}

const KINDS: Record<LoanKind, { label: string; maxMonths: number; ratePct: number; blurb: string }> = {
  salary_advance: { label: "Salary advance", maxMonths: 3, ratePct: 0, blurb: "Paid back from your next salaries, no interest." },
  emergency: { label: "Emergency loan", maxMonths: 6, ratePct: 0, blurb: "For medical bills, a funeral or school fees at short notice." },
  welfare: { label: "Staff welfare loan", maxMonths: 12, ratePct: 1, blurb: "From the staff welfare fund, 1% a month on the reducing balance." },
};

const STATUS_TONE: Record<LoanStatus, Tone> = { pending: "warn", active: "info", repaid: "ok", rejected: "muted" };
const STATUS_LABEL: Record<LoanStatus, string> = { pending: "Awaiting review", active: "Repaying", repaid: "Repaid", rejected: "Not approved" };

/** The most this person can owe at once: two months' pay, shown for the demo as a fixed figure. */
const LIMIT_CENTS = 12_000_000;

const SAMPLE: Loan[] = [
  { id: "l3", kind: "welfare", amountCents: 6_000_000, months: 12, paid: 4, requestedOn: "2026-06-12", status: "active", reason: "Plot survey fees", note: "Approved by the head teacher." },
  { id: "l2", kind: "salary_advance", amountCents: 1_500_000, months: 3, paid: 3, requestedOn: "2026-03-02", status: "repaid", reason: "Rent top-up" },
  { id: "l1", kind: "emergency", amountCents: 2_500_000, months: 6, paid: 0, requestedOn: "2026-01-20", status: "rejected", reason: "Car repair", note: "Please apply for a salary advance instead." },
];

/** Equal monthly instalments; with interest, the usual amortised payment on the reducing balance. */
function instalmentCents(amountCents: number, months: number, ratePct: number): number {
  if (ratePct === 0) return Math.ceil(amountCents / months);
  const r = ratePct / 100;
  return Math.ceil((amountCents * r) / (1 - (1 + r) ** -months));
}

function balanceCents(l: Loan): number {
  if (l.status !== "active") return 0;
  return instalmentCents(l.amountCents, l.months, KINDS[l.kind].ratePct) * (l.months - l.paid);
}

/**
 * Loans and salary advances for teachers and other staff. A preview: nothing
 * here is saved yet. Requests made on this page live only until it reloads,
 * and the history is sample data, until the loans tables and the office's
 * approval screen are built.
 */
export function StaffLoans() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const money = (cents: number) => formatMoney(cents, tenant.country);

  const [loans, setLoans] = useState<Loan[]>(SAMPLE);
  const [kind, setKind] = useState<LoanKind>("salary_advance");
  const [amount, setAmount] = useState("");
  const [months, setMonths] = useState("3");
  const [reason, setReason] = useState("");

  const owed = loans.reduce((n, l) => n + balanceCents(l), 0);
  const monthly = loans.filter((l) => l.status === "active").reduce((n, l) => n + instalmentCents(l.amountCents, l.months, KINDS[l.kind].ratePct), 0);
  const available = Math.max(0, LIMIT_CENTS - owed - loans.filter((l) => l.status === "pending").reduce((n, l) => n + l.amountCents, 0));

  const amountCents = Math.round(Number(amount.replace(/,/g, "")) * 100) || 0;
  const term = Math.min(Number(months) || 1, KINDS[kind].maxMonths);
  const quote = amountCents > 0 ? instalmentCents(amountCents, term, KINDS[kind].ratePct) : 0;

  function apply() {
    if (amountCents <= 0) { toast("Enter how much you need.", "error"); return; }
    if (amountCents > available) { toast(`That's more than you can borrow right now (${money(available)}).`, "error"); return; }
    setLoans((prev) => [{
      id: `new-${prev.length}`, kind, amountCents, months: term, paid: 0,
      requestedOn: new Date().toISOString().slice(0, 10), status: "pending", reason: reason.trim() || undefined,
    }, ...prev]);
    toast("Request sent. The office will review it.");
    setAmount("");
    setReason("");
  }

  function withdraw(id: string) {
    setLoans((prev) => prev.filter((l) => l.id !== id));
    toast("Request withdrawn.");
  }

  return (
    <>
      <PageHead eyebrow="Loans" title="Loans & advances" blurb="Ask for a salary advance or a staff loan. Repayments come off your salary each month." />

      <div className="grid gap-5 px-7 py-6">
        <p className="rounded-lg bg-page px-4 py-2.5 text-[12.5px] text-ink-muted">
          Preview: requests here aren't saved yet, and the history below is sample data.
        </p>

        <StatRow stats={[
          { label: "You owe", value: money(owed), sub: owed ? "Across active loans" : "Nothing outstanding" },
          { label: "Monthly deduction", value: money(monthly), sub: "Taken from your salary" },
          { label: "You can borrow", value: money(available), sub: `Limit ${money(LIMIT_CENTS)}` },
        ]} />

        <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <div className="grid content-start gap-3.5 rounded-lg border border-line bg-white p-4">
            <h2 className="text-body font-semibold">Request a loan</h2>
            <SelectField
              id="loan-kind" label="Type" value={kind}
              onChange={(e) => { const k = e.target.value as LoanKind; setKind(k); setMonths(String(KINDS[k].maxMonths)); }}
              options={Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label }))}
              hint={KINDS[kind].blurb}
            />
            <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <TextField id="loan-amount" label="Amount" inputMode="decimal" placeholder="e.g. 20,000" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <SelectField
                id="loan-months" label="Repay over" value={String(term)} onChange={(e) => setMonths(e.target.value)}
                options={Array.from({ length: KINDS[kind].maxMonths }, (_, i) => ({ value: String(i + 1), label: `${i + 1} month${i ? "s" : ""}` }))}
              />
            </div>
            <TextArea id="loan-reason" label="What it's for (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Hospital bill" />
            {quote > 0 && (
              <p className="rounded-lg bg-page px-3 py-2 text-[12.5px]">
                About <strong>{money(quote)}</strong> a month for {term} month{term > 1 ? "s" : ""}
                {KINDS[kind].ratePct ? `, ${money(quote * term)} in total.` : "."}
              </p>
            )}
            <Button variant="accent" disabled={amountCents <= 0} onClick={apply}>Send request</Button>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-white">
            <header className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Your loans</h2>
            </header>
            {loans.map((l) => (
              <div key={l.id} className="border-b border-line-soft px-4 py-3 last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{KINDS[l.kind].label} · {money(l.amountCents)}</div>
                    <p className="mt-0.5 text-[12px] text-ink-faint">
                      Requested {formatShortDate(l.requestedOn)} · {l.months} month{l.months > 1 ? "s" : ""}{l.reason ? ` · ${l.reason}` : ""}
                    </p>
                    {l.note && <p className="mt-1 text-[12px] italic text-ink-muted">"{l.note}"</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Badge>
                    {l.status === "pending" && (
                      <button type="button" onClick={() => withdraw(l.id)} className="text-[12px] font-semibold text-warn-ink hover:underline">
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
                {l.status === "active" && (
                  <div className="mt-2">
                    <div className="h-1.5 overflow-hidden rounded-full bg-page">
                      <div className="h-full rounded-full bg-forest" style={{ width: `${(l.paid / l.months) * 100}%` }} />
                    </div>
                    <p className="mt-1 text-[11.5px] text-ink-faint">{l.paid} of {l.months} paid · {money(balanceCents(l))} left</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
