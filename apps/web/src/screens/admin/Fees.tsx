import { useState } from "react";
import { KES, itemsForStudent, supabase, totalCents } from "@figbloom/shared";
import type { FeeItem, Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { privateDocUrl } from "../../lib/uploads";

interface OutstandingRow {
  id: string;
  name: string;
  cls: string;
  billed: number;
  paid: number;
}

interface RawInvoiceRow {
  id: string;
  total_cents: number;
  paid_cents: number;
  students: { full_name: string; classes: { name: string } | null } | null;
}

interface PendingProofRow {
  id: string;
  file_path: string;
  file_name: string;
  note: string | null;
  uploaded_at: string;
  studentName: string;
  cls: string;
}

interface RawProofRow {
  id: string;
  file_path: string;
  file_name: string;
  note: string | null;
  uploaded_at: string;
  fee_invoices: { students: { full_name: string; classes: { name: string } | null } | null } | null;
}

interface FeesData {
  term: Term | null;
  feeItems: FeeItem[];
  invoices: { total_cents: number; paid_cents: number }[];
  outstanding: OutstandingRow[];
  pendingProofs: PendingProofRow[];
}

async function fetchFees(): Promise<FeesData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const [{ data: feeItemRows }, invoicesRes, proofsRes] = await Promise.all([
    termId
      ? sb.from("fee_items").select("*").eq("term_id", termId).returns<FeeItem[]>()
      : Promise.resolve({ data: [] as FeeItem[] }),
    termId
      ? sb.from("fee_invoices").select("id,total_cents,paid_cents,students(full_name,classes(name))").eq("term_id", termId).returns<RawInvoiceRow[]>()
      : Promise.resolve({ data: [] as RawInvoiceRow[] }),
    // Payment proofs are keyed by invoice, not term — reach the current term
    // through fee_invoices the same way the outstanding-balances query does.
    termId
      ? sb.from("payment_proofs")
          .select("id,file_path,file_name,note,uploaded_at,fee_invoices!inner(term_id,students(full_name,classes(name)))")
          .eq("status", "pending")
          .eq("fee_invoices.term_id", termId)
          .order("uploaded_at", { ascending: true })
          .returns<RawProofRow[]>()
      : Promise.resolve({ data: [] as RawProofRow[] }),
  ]);

  const rawInvoices = invoicesRes.data ?? [];
  const invoices = rawInvoices.map((r) => ({ total_cents: r.total_cents, paid_cents: r.paid_cents }));

  const outstanding = rawInvoices
    .filter((r) => r.paid_cents < r.total_cents)
    .map((r) => ({
      id: r.id,
      name: r.students?.full_name ?? "Unknown learner",
      cls: r.students?.classes?.name ?? "—",
      billed: r.total_cents,
      paid: r.paid_cents,
    }))
    .sort((a, b) => (b.billed - b.paid) - (a.billed - a.paid))
    .slice(0, 10);

  const pendingProofs: PendingProofRow[] = (proofsRes.data ?? []).map((r) => ({
    id: r.id,
    file_path: r.file_path,
    file_name: r.file_name,
    note: r.note,
    uploaded_at: r.uploaded_at,
    studentName: r.fee_invoices?.students?.full_name ?? "Unknown learner",
    cls: r.fee_invoices?.students?.classes?.name ?? "—",
  }));

  return { term: term ?? null, feeItems: feeItemRows ?? [], invoices, outstanding, pendingProofs };
}

export function Fees() {
  const toast = useToast();
  const { profile } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchFees(), []);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());

  async function reviewProof(id: string, status: "confirmed" | "rejected") {
    const { error: updateError } = await supabase()
      .from("payment_proofs")
      .update({ status, reviewed_by: profile.id, reviewed_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) {
      toast(`Could not update: ${updateError.message}`);
      return;
    }
    setReviewedIds((s) => new Set(s).add(id));
    toast(status === "confirmed" ? "Payment proof confirmed" : "Payment proof rejected");
  }

  async function openProof(path: string) {
    try {
      const url = await privateDocUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open that file.");
    }
  }

  // "A Form 2 boarder pays" — the representative figure the label promises,
  // so it must include Form-2-scoped items too (KCSE registration etc.), not
  // just the school-wide ones.
  const boarderTotal = data ? totalCents(itemsForStudent(data.feeItems, { boarding: true }, 2)) : 0;

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
            <Button onClick={() => toast("Exported the fee register for accounts")}>Export register</Button>
            <Button variant="accent" onClick={() => toast(`Reminder drafted for ${owingCount} parents`)}>Send reminders</Button>
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
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
        ) : (
          <StatRow
            stats={[
              { label: "Billed this term", value: KES(billed), sub: `${data.invoices.length.toLocaleString()} learners` },
              { label: "Collected", value: KES(collected), sub: `${collectedPct}% of billed` },
              { label: "Outstanding", value: KES(outstandingTotal), sub: `${owingCount.toLocaleString()} learners owe a balance`, alarming: true },
              { label: "Fully paid", value: `${fullyPaidPct}%`, sub: `${fullyPaidCount.toLocaleString()} invoices cleared` },
            ]}
          />
        )}

        <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
          <section className="overflow-hidden rounded-lg border border-line">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">{data?.term ? data.term.name : "Term"} fee items</h2>
              <Button onClick={() => toast("Editing the fee structure")}>Edit</Button>
            </header>
            <div>
              {error ? null : loading || !data ? (
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
                            : `Form ${i.form_level} only`}
                        </div>
                      </div>
                      <Mono>{KES(i.amount_cents)}</Mono>
                    </div>
                  ))}
                  <div className="flex items-center justify-between bg-sunken px-4 py-3">
                    <span className="text-[13px] font-semibold">A Form 2 boarder pays</span>
                    <span className="font-mono text-[15px] font-medium">{KES(boarderTotal)}</span>
                  </div>
                </>
              )}
            </div>
          </section>

          {error ? null : loading || !data ? (
            <TableSkeleton rows={6} />
          ) : (
            <DataTable
              title="Largest outstanding balances"
              columns={[
                { key: "name", header: "Learner", width: "1.6fr", render: (r: OutstandingRow) => <Cell sub={r.cls}>{r.name}</Cell> },
                { key: "billed", header: "Billed", align: "right", render: (r: OutstandingRow) => <Mono>{KES(r.billed)}</Mono> },
                { key: "paid", header: "Paid", align: "right", render: (r: OutstandingRow) => <Mono>{KES(r.paid)}</Mono> },
                { key: "bal", header: "Balance", align: "right", render: (r: OutstandingRow) => (
                  <span className="font-mono text-[12.5px] font-medium text-warn-ink">{KES(r.billed - r.paid)}</span>
                ) },
                { key: "st", header: "", align: "right", render: (r: OutstandingRow) => (
                  <Badge tone={r.paid === 0 ? "warn" : "muted"}>{r.paid === 0 ? "Nothing paid" : "Part paid"}</Badge>
                ) },
              ]}
              rows={data.outstanding}
              rowKey={(r) => r.id}
              minWidth="640px"
              empty={{ title: "Every balance is cleared", body: "Nothing outstanding this term. That is rare — worth telling the board." }}
            />
          )}
        </div>

        <div className="mt-4">
          {error ? null : loading || !data ? (
            <TableSkeleton rows={3} />
          ) : (
            <DataTable
              title="Payment proof awaiting review"
              columns={[
                { key: "student", header: "Learner", width: "1.4fr", render: (r: PendingProofRow) => <Cell sub={r.cls}>{r.studentName}</Cell> },
                { key: "file", header: "File", render: (r: PendingProofRow) => (
                  <button
                    type="button"
                    onClick={() => openProof(r.file_path)}
                    className="min-w-0 truncate text-left text-[12.5px] font-medium text-forest hover:underline"
                  >
                    {r.file_name}
                  </button>
                ) },
                { key: "note", header: "Note", render: (r: PendingProofRow) => <Cell>{r.note ?? "—"}</Cell> },
                { key: "when", header: "Uploaded", width: "0.8fr", render: (r: PendingProofRow) => (
                  <Mono>{new Date(r.uploaded_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</Mono>
                ) },
                { key: "actions", header: "", align: "right", width: "1.2fr", render: (r: PendingProofRow) => (
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => reviewProof(r.id, "rejected")}>Reject</Button>
                    <Button variant="accent" onClick={() => reviewProof(r.id, "confirmed")}>Confirm</Button>
                  </div>
                ) },
              ]}
              rows={data.pendingProofs.filter((r) => !reviewedIds.has(r.id))}
              rowKey={(r) => r.id}
              minWidth="720px"
              empty={{ title: "Nothing to review", body: "Bank slips and other payment evidence parents upload will appear here for confirmation." }}
            />
          )}
        </div>
      </div>
    </>
  );
}
