import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  COLLECTION_FILTERS, PAYMENT_SMS_FLAG_LABEL, REJECT_REASONS, balanceStanding, fetchCollectionPage, fetchFeesExtras, fetchLargestBalances, fetchSchoolYearGroups,
  fetchTenantCurrentTerm, fetchTermAmounts, fetchTermFeeItems, formatMoney, formatShortDate, groupFeeItems, itemsForStudent, proofFlags, proofToConfirm,
  rejectPaymentProof, rejectionReason, targetYearLabel, termFigures, totalCents, yearLabel,
} from "@figbloom/shared";
import type { CollectionFilter, CollectionRow, FeeItem, OutstandingRow, OverpaidRow, PayableInvoice, PendingProof } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { SectionError } from "../../components/ui/SectionError";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TextField } from "../../components/ui/Field";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Pagination } from "../../components/ui/Pagination";
import { usePaging } from "../../components/ui/usePaging";
import { useToast } from "../../components/ui/Toast";
import { invalidate, useQuery } from "../../lib/queryCache";
import { useTenantSession } from "../../lib/sessionContext";
import { privateDocUrl } from "../../lib/uploads";
import { SignTermInvoices } from "../../components/signatures/InvoiceSignatures";
import { TermReceipts } from "../../components/signatures/ReceiptSignatures";
import { FeeItemsEditor } from "./FeeItemsEditor";
import { BillTermModal, RecordPaymentModal } from "./FeeCollection";

const feesKey = (tenantId: string, ...parts: (string | number | null)[]) => [tenantId, "fees", ...parts].join(":");

/**
 * The term's fees: figures that open the matching list, fee items grouped by
 * band, the collection a page at a time (search and status filters on the
 * server), the largest balances, overpayments and proofs to review. Each part
 * loads on its own through the query cache, so coming back is instant.
 */
export function Fees() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [params, setParams] = useSearchParams();
  const filter = (COLLECTION_FILTERS.find((f) => f.key === params.get("status"))?.key ?? "all") as CollectionFilter;
  const setFilter = (f: CollectionFilter) => {
    const next = new URLSearchParams(params);
    if (f === "all") next.delete("status"); else next.set("status", f);
    setParams(next, { replace: true });
    document.getElementById("fee-collection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const [query, setQuery] = useState("");

  const termQ = useQuery(feesKey(tenant.id, "term"), () => fetchTenantCurrentTerm(tenant.id), { staleTime: 5 * 60_000 });
  const term = termQ.data ?? null;
  const termId = term?.id ?? null;
  const items = useQuery(termId ? feesKey(tenant.id, "items", termId) : null, () => fetchTermFeeItems(termId!), { staleTime: 5 * 60_000 });
  const groups = useQuery(feesKey(tenant.id, "yeargroups"), () => fetchSchoolYearGroups(tenant.id), { staleTime: 10 * 60_000 });
  const amounts = useQuery(termId ? feesKey(tenant.id, "amounts", termId) : null, () => fetchTermAmounts(tenant.id, termId!));
  const largest = useQuery(amounts.data ? feesKey(tenant.id, "largest", termId, amounts.data.length, amounts.data.reduce((a, r) => a + r.paid_cents, 0)) : null,
    () => fetchLargestBalances(amounts.data!));
  const extras = useQuery(termQ.data !== undefined && !termQ.loading ? feesKey(tenant.id, "extras", termId) : null, () => fetchFeesExtras(tenant.id, termId));

  const termPending = termQ.loading;
  const figures = amounts.data ? termFigures(amounts.data) : null;

  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [editingItems, setEditingItems] = useState(false);
  const [billing, setBilling] = useState(false);
  const [recording, setRecording] = useState<{ invoice?: PayableInvoice; proof?: PendingProof } | null>(null);
  const [rejecting, setRejecting] = useState<PendingProof | null>(null);

  /** After billing, a payment, a proof or an item edit: everything fee-related refetches. */
  function refresh() {
    invalidate(`${tenant.id}:fees:`);
    setReloadKey((k) => k + 1);
  }

  function done(message: string) {
    setBilling(false);
    setRecording(null);
    refresh();
    toast(message);
  }

  async function rejectProof(id: string, reason: string): Promise<boolean> {
    try {
      await rejectPaymentProof({ proofId: id, reviewerId: profile.id, reason });
    } catch (err) {
      toast(`Could not update: ${err instanceof Error ? err.message : "try again."}`, "error");
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

  const feeItems = items.data ?? [];
  const totalsByForm = items.data && groups.data
    ? groups.data.map((g) => ({
        key: g.key,
        label: yearLabel(g.level, g.year),
        day: totalCents(itemsForStudent(feeItems, { boarding: false }, g.year, g.level)),
        boarder: totalCents(itemsForStudent(feeItems, { boarding: true }, g.year, g.level)),
      }))
    : [];
  const money = (c: number) => formatMoney(c, tenant.country);
  const error = termQ.error ?? amounts.error;

  return (
    <>
      <PageHead
        eyebrow={term ? `Fees · ${term.name.toLowerCase()}` : "Fees"}
        title="Fee structure and collection"
        blurb="Published once at the start of term. Changing an amount after publication notifies every affected parent, so the composer says how many before you confirm."
        actions={
          <>
            <Button onClick={() => setBilling(true)} disabled={!term || !items.data}>Bill learners</Button>
            {term && <SignTermInvoices key={`${term.id}:${reloadKey}`} termId={term.id} />}
            <Button variant="accent" onClick={() => setRecording({})} disabled={!term}>Record a payment</Button>
          </>
        }
      />

      <div className="grid gap-5 px-7 py-6">
        {error && (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load fees: {error.message}
          </p>
        )}

        {term && figures && figures.invoices === 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-sunken px-4 py-3">
            <p className="text-[13px] leading-relaxed">
              No invoices yet for {term.name}. {feeItems.length > 0 ? "Parents see nothing owing until learners are billed." : "Add this term's fee items, then bill learners."}
            </p>
            {feeItems.length > 0 && <Button variant="accent" onClick={() => setBilling(true)}>Bill learners</Button>}
          </div>
        )}

        <FeeWidgets figures={figures} loading={termPending || (!!termId && amounts.loading)} money={money} active={filter} onFilter={setFilter} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <FeeItemsCard
            title={`${term ? term.name : "Term"} fee items`}
            loading={termPending || (!!termId && items.loading)}
            items={feeItems}
            totalsByForm={totalsByForm}
            money={money}
            onEdit={term ? () => setEditingItems(true) : undefined}
          />
          {largest.loading || amounts.loading || termPending ? <TableSkeleton rows={6} /> : (
            <DataTable
              title="Largest outstanding balances"
              filters={figures && figures.owing > 0 ? <Button onClick={() => setFilter("owing")}>All {figures.owing.toLocaleString()} owing →</Button> : undefined}
              columns={[
                { key: "name", header: "Learner", width: "1.6fr", render: (r: OutstandingRow) => <Cell sub={r.cls}>{r.name}</Cell> },
                { key: "billed", header: "Billed", align: "right", render: (r: OutstandingRow) => (
                  <Cell sub={r.charges > 0 ? `incl. ${money(r.charges)} charges` : undefined}><Mono>{money(r.billed)}</Mono></Cell>
                ) },
                { key: "paid", header: "Paid", align: "right", render: (r: OutstandingRow) => <Mono>{money(r.paid)}</Mono> },
                { key: "bal", header: "Balance", align: "right", render: (r: OutstandingRow) => <span className="font-mono text-[12.5px] font-medium text-warn-ink">{money(r.billed - r.paid)}</span> },
                { key: "st", header: "", align: "right", render: (r: OutstandingRow) => <Badge tone={r.paid === 0 ? "warn" : "muted"}>{balanceStanding(r)}</Badge> },
                { key: "pay", header: "", align: "right", render: (r: OutstandingRow) => (
                  <Button onClick={() => setRecording({ invoice: { id: r.id, studentName: r.name, cls: r.cls, balanceCents: r.billed - r.paid } })}>Record payment</Button>
                ) },
              ]}
              rows={largest.data ?? []}
              rowKey={(r) => r.id}
              minWidth="780px"
              pageSize={10}
              empty={{ title: "Every balance is cleared", body: "Nothing outstanding this term. That is rare — worth telling the board." }}
            />
          )}
        </div>

        {termId && (
          <CollectionTable
            tenantId={tenant.id}
            termId={termId}
            filter={filter}
            onFilter={setFilter}
            query={query}
            onQuery={setQuery}
            figures={figures}
            money={money}
            onRecord={(r) => setRecording({ invoice: { id: r.id, studentName: r.studentName, cls: r.cls, balanceCents: Math.max(r.total - r.paid, 0) } })}
          />
        )}
        {extras.data && extras.data.overpaid.length > 0 && (
          <div className="">
            <DataTable
              title="Paid more than was owed"
              columns={[
                { key: "name", header: "Learner", width: "1.6fr", render: (r: OverpaidRow) => (
                  <Cell sub={r.students?.classes?.name ?? "—"}>{r.students?.full_name ?? "Unknown learner"}</Cell>
                ) },
                { key: "term", header: "Term", render: (r: OverpaidRow) => r.terms?.name ?? "—" },
                { key: "billed", header: "Billed", align: "right", render: (r: OverpaidRow) => <Mono>{formatMoney(r.total_cents, tenant.country)}</Mono> },
                { key: "paid", header: "Paid", align: "right", render: (r: OverpaidRow) => <Mono>{formatMoney(r.paid_cents, tenant.country)}</Mono> },
                { key: "over", header: "Owed back", align: "right", render: (r: OverpaidRow) => (
                  <span className="font-mono text-[12.5px] font-medium text-warn-ink">{formatMoney(r.overpaid_cents, tenant.country)}</span>
                ) },
              ]}
              rows={extras.data.overpaid}
              rowKey={(r) => r.id}
              minWidth="720px"
              empty={{ title: "No overpayments", body: "" }}
            />
            <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
              Two payments crossed (cash at the desk while an M-Pesa prompt was waiting), or a charge was cancelled after the
              invoice was paid. Refund the family or agree to carry it forward; each overpayment is in the audit log.
            </p>
          </div>
        )}

        <div className="">
          {extras.loading || termPending ? (
            <TableSkeleton rows={3} />
          ) : (
            <DataTable
              title="Payment proof awaiting review"
              columns={[
                { key: "student", header: "Learner", width: "1.4fr", render: (r: PendingProof) => <Cell sub={r.cls}>{r.studentName}</Cell> },
                { key: "file", header: "Evidence", width: "1.6fr", render: (r: PendingProof) => {
                  const flags = proofFlags(r, { paybill: tenant.payment_paybill, till: tenant.payment_till });
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
                { key: "note", header: "Note", render: (r: PendingProof) => <Cell>{r.note ?? "—"}</Cell> },
                { key: "when", header: "Uploaded", width: "0.8fr", render: (r: PendingProof) => (
                  <Mono>{new Date(r.uploaded_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</Mono>
                ) },
                { key: "actions", header: "", align: "right", width: "1.2fr", render: (r: PendingProof) => (
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => setRejecting(r)}>Reject</Button>
                    <Button variant="accent" disabled={!r.invoice} onClick={() => r.invoice && setRecording({ invoice: r.invoice, proof: r })}>Confirm</Button>
                  </div>
                ) },
              ]}
              rows={extras.data!.pendingProofs.filter((r) => !reviewedIds.has(r.id))}
              rowKey={(r) => r.id}
              minWidth="820px"
              empty={{ title: "Nothing to review", body: "Bank slips, pasted M-Pesa messages and other payment evidence parents send will appear here for confirmation." }}
            />
          )}
        </div>

        {term && (
          <div className="">
            <TermReceipts termId={term.id} reloadKey={reloadKey} />
          </div>
        )}
      </div>

      {editingItems && term && (
        <FeeItemsEditor
          termId={term.id}
          termName={term.name}
          tenantId={tenant.id}
          country={tenant.country}
          onClose={() => { setEditingItems(false); refresh(); }}
        />
      )}

      {billing && term && (
        <BillTermModal
          term={term}
          feeItems={feeItems}
          tenantId={tenant.id}
          country={tenant.country}
          onClose={() => setBilling(false)}
          onBilled={done}
        />
      )}

      {recording && term && (
        <RecordPaymentModal
          termId={term.id}
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

function RejectProofModal({ proof, onClose, onReject }: {
  proof: PendingProof;
  onClose: () => void;
  onReject: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const ready = rejectionReason(reason) !== null && !saving;

  async function submit() {
    if (!ready) return;
    setSaving(true);
    if (!(await onReject(reason))) setSaving(false);
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

// ---------------------------------------------------------------- widgets

function FeeWidgets({ figures, loading, money, active, onFilter }: {
  figures: ReturnType<typeof termFigures> | null; loading: boolean; money: (c: number) => string;
  active: CollectionFilter; onFilter: (f: CollectionFilter) => void;
}) {
  const card = (label: string, value: string, sub: string, filter: CollectionFilter | null, alarming = false) => {
    const body = (
      <>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-micro tracking-[0.1em] text-ink-faint">{label.toUpperCase()}</span>
          {filter && <span aria-hidden className="text-[13px] text-ink-faint">→</span>}
        </div>
        {loading || !figures ? (
          <><Skeleton className="mt-2.5 h-6 w-20" /><Skeleton className="mt-2 h-2.5 w-28" /></>
        ) : (
          <>
            <div className="mt-1.5 font-mono text-2xl tracking-tight" style={{ color: alarming ? "#D9550C" : undefined }}>{value}</div>
            <div className="mt-0.5 text-[11.5px] text-ink-faint">{sub}</div>
          </>
        )}
      </>
    );
    const cls = "min-w-0 rounded-lg border bg-white px-4 py-3.5 text-left";
    return filter ? (
      <button key={label} type="button" aria-pressed={active === filter} onClick={() => onFilter(filter)}
        aria-label={figures ? `${label}: ${value}. Show the ${filter === "all" ? "whole" : filter.replace("_", " ")} list` : label}
        className={`${cls} transition-colors hover:border-[#9DB5A6] hover:bg-page ${active === filter ? "border-[#17402A] ring-1 ring-[#17402A]" : "border-line"}`}>
        {body}
      </button>
    ) : <div key={label} className={`${cls} border-line`}>{body}</div>;
  };
  const f = figures;
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
      {card("Billed this term", f ? money(f.billed) : "", f ? `${f.invoices.toLocaleString()} learners` : "", "all")}
      {card("Collected", f ? money(f.collected) : "", f ? `${f.paid.toLocaleString()} fully paid` : "", "paid")}
      {card("Outstanding", f ? money(f.outstanding) : "", f ? `${f.owing.toLocaleString()} owe · ${f.partPaid.toLocaleString()} part paid` : "", "owing", true)}
      {card("% collected", f ? `${f.collectedPct}%` : "", f ? `${f.nothingPaid.toLocaleString()} have paid nothing` : "", null)}
      {card("Overdue", f ? f.overdue.toLocaleString() : "", "past the due date, not cleared", "overdue", (f?.overdue ?? 0) > 0)}
      {f && !loading && (
        <div className="col-span-full -mt-1 h-2 overflow-hidden rounded-full bg-line-soft" role="img" aria-label={`${f.collectedPct}% of the term's fees collected`}>
          <div className="h-full rounded-full bg-[#1BAF7A]" style={{ width: `${Math.min(100, f.collectedPct)}%` }} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- fee items by band

function FeeItemsCard({ title, loading, items, totalsByForm, money, onEdit }: {
  title: string; loading: boolean; items: FeeItem[]; money: (c: number) => string; onEdit?: () => void;
  totalsByForm: { key: string; label: string; day: number; boarder: number }[];
}) {
  const bands = groupFeeItems(items);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showTotals, setShowTotals] = useState(false);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white self-start">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-body font-semibold">{title}</h2>
          {!loading && <p className="mt-0.5 text-[12px] text-ink-faint">{items.length.toLocaleString()} items in {bands.length} group{bands.length === 1 ? "" : "s"}</p>}
        </div>
        <div className="flex gap-2">
          {bands.length > 1 && <Button onClick={() => setOpen(open.size === bands.length ? new Set() : new Set(bands.map((b) => b.key)))}>{open.size === bands.length ? "Collapse all" : "Expand all"}</Button>}
          <Button onClick={onEdit} disabled={!onEdit}>Edit</Button>
        </div>
      </header>
      {loading ? (
        Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
            <Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-16" />
          </div>
        ))
      ) : bands.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-muted">No fee items for this term yet. Use Edit to add tuition, boarding and activities.</p>
      ) : (
        <ul>
          {bands.map((b) => {
            const isOpen = open.has(b.key);
            const names = [...new Set(b.items.map((i) => i.name))];
            return (
              <li key={b.key} className="border-b border-line-soft last:border-0">
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(b.key)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-page">
                  <span aria-hidden className={`text-[11px] text-ink-faint transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">{b.label}</span>
                    <span className="block truncate text-[11.5px] text-ink-faint">{b.items.length} item{b.items.length === 1 ? "" : "s"} · {names.slice(0, 4).join(", ")}{names.length > 4 ? `, +${names.length - 4} more` : ""}</span>
                  </span>
                  <Mono>{money(b.totalCents)}</Mono>
                </button>
                {isOpen && (
                  <ul className="bg-page/60 pb-1">
                    {b.items.map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-2 pl-10">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{i.name}</div>
                          <div className="mt-0.5 text-[11.5px] text-ink-faint">
                            {i.applies_to === "all" ? "Every learner" : i.applies_to === "boarders" ? "Boarders only" : i.applies_to === "day" ? "Day scholars only" : `${targetYearLabel(i.level, i.form_level ?? 0)} only`}
                          </div>
                        </div>
                        <Mono>{money(i.amount_cents)}</Mono>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!loading && totalsByForm.length > 0 && (
        <div className="border-t border-line bg-sunken px-4 py-3">
          <button type="button" aria-expanded={showTotals} onClick={() => setShowTotals((v) => !v)} className="flex w-full items-center justify-between text-left text-[12px] font-semibold">
            <span>What each year group pays in total</span>
            <span className="font-normal text-ink-muted">{showTotals ? "Hide" : `Show ${totalsByForm.length}`}</span>
          </button>
          {showTotals && (
            <div className="mt-2 grid gap-1.5">
              <div className="grid gap-2 text-[11px] font-semibold text-ink-faint" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                <span>Year</span><span className="text-right">Day</span><span className="text-right">Boarder</span>
              </div>
              {totalsByForm.map((t) => (
                <div key={t.key} className="grid gap-2 text-[13px]" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                  <span className="font-medium">{t.label}</span>
                  <div className="text-right"><Mono>{money(t.day)}</Mono></div>
                  <div className="text-right"><Mono>{money(t.boarder)}</Mono></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- collection, server-paged

const STATUS_BADGE = (r: CollectionRow) =>
  r.status === "paid" ? <Badge tone="ok">✓ Paid</Badge>
  : r.status === "overdue" ? <Badge tone="warn">{r.paid > 0 ? "Overdue · part paid" : "Overdue"}</Badge>
  : r.paid > 0 ? <Badge tone="info">Part paid</Badge>
  : <Badge>Nothing paid</Badge>;

function CollectionTable({ tenantId, termId, filter, onFilter, query, onQuery, figures, money, onRecord }: {
  tenantId: string; termId: string; filter: CollectionFilter; onFilter: (f: CollectionFilter) => void;
  query: string; onQuery: (q: string) => void; figures: ReturnType<typeof termFigures> | null;
  money: (c: number) => string; onRecord: (r: CollectionRow) => void;
}) {
  const [typed, setTyped] = useState(query);
  const q = query.trim();
  const [total, setTotal] = useState(0);
  // the last page's error (a 416 when a filter left fewer pages) sends the list back to page 1
  const [pageError, setPageError] = useState<Error | null>(null);
  const paging = usePaging(total, `${filter}|${q}`, 25, pageError);
  const page = useQuery(feesKey(tenantId, "collection", termId, filter, q, paging.offset, paging.size),
    () => fetchCollectionPage(tenantId, termId, { filter, query: q, offset: paging.offset, limit: paging.size }), { staleTime: 30_000 });
  if (page.data && page.data.total !== total) setTotal(page.data.total);
  if (page.error !== pageError) setPageError(page.error);
  const count = (f: CollectionFilter) => !figures ? null
    : f === "all" ? figures.invoices : f === "paid" ? figures.paid : f === "owing" ? figures.owing : f === "overdue" ? figures.overdue
    : f === "part_paid" ? figures.partPaid : figures.nothingPaid;

  return (
    <section id="fee-collection" className="grid scroll-mt-4 gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-body font-semibold">Learners and invoices</h2>
        <div role="group" aria-label="Status" className="flex flex-wrap rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {COLLECTION_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)} className="rounded px-3 py-1.5 text-small"
              style={filter === f.key ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {f.label}{count(f.key) != null ? ` · ${count(f.key)!.toLocaleString()}` : ""}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onQuery(typed); }} className="flex gap-2">
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Learner, admission no. or class" aria-label="Search learners"
            className="w-56 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small outline-none" />
          <Button type="submit">Search</Button>
          {q && <Button onClick={() => { setTyped(""); onQuery(""); }}>Clear</Button>}
        </form>
      </div>
      {page.error ? <SectionError what="load the invoices" error={page.error} onRetry={page.retry} />
        : page.loading ? <TableSkeleton rows={8} /> : (
          <DataTable
            columns={[
              { key: "name", header: "Learner", width: "1.6fr", render: (r: CollectionRow) => <Cell sub={[r.admissionNo ? `ADM ${r.admissionNo}` : null, r.cls].filter(Boolean).join(" · ")}>{r.studentName}</Cell> },
              { key: "billed", header: "Billed", align: "right", render: (r: CollectionRow) => <Cell sub={r.charges > 0 ? `incl. ${money(r.charges)} charges` : undefined}><Mono>{money(r.total)}</Mono></Cell> },
              { key: "paid", header: "Paid", align: "right", render: (r: CollectionRow) => <Mono>{money(r.paid)}</Mono> },
              { key: "bal", header: "Balance", align: "right", render: (r: CollectionRow) => r.total > r.paid ? <span className="font-mono text-[12.5px] font-medium text-warn-ink">{money(r.total - r.paid)}</span> : <span className="text-ink-faint">—</span> },
              { key: "due", header: "Due", render: (r: CollectionRow) => <span className="text-[13px]">{r.dueOn ? formatShortDate(r.dueOn) : "—"}</span> },
              { key: "st", header: "Status", render: STATUS_BADGE },
              { key: "pay", header: "", align: "right", render: (r: CollectionRow) => r.status !== "paid" ? <Button onClick={() => onRecord(r)}>Record payment</Button> : null },
            ]}
            rows={page.data?.rows ?? []}
            rowKey={(r) => r.id}
            minWidth="880px"
            pageSize={0}
            empty={q ? { title: "Nobody matches", body: "Try a learner's name, admission number or class." }
              : { title: filter === "all" ? "No invoices yet" : "No one in this list", body: filter === "all" ? "Bill learners to create this term's invoices." : "Try another status." }}
          />
        )}
      {total > 0 && <Pagination {...paging.props} total={total} />}
    </section>
  );
}
