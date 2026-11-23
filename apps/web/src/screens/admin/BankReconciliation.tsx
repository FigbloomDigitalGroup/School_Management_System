import { useEffect, useRef, useState } from "react";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TextField } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

type MatchStatus = "unmatched" | "auto_matched" | "manual_matched" | "ignored";

interface BankStatement {
  id: string;
  bank_name: string;
  account_number: string;
  statement_from: string | null;
  statement_to: string | null;
  currency: string;
  row_count: number;
  matched_count: number;
  unmatched_count: number;
  status: "open" | "reconciled";
  created_at: string;
}

interface BankStatementLine {
  id: string;
  line_no: number;
  txn_date: string;
  reference: string | null;
  description: string;
  amount_minor: number;
  direction: "credit" | "debit";
  match_status: MatchStatus;
  matched_payment_id: string | null;
  matched_invoice_id: string | null;
  match_note: string | null;
}

interface StatementDetail {
  statement: BankStatement;
  summary: {
    total_credits_minor: number;
    matched_credits_minor: number;
    unmatched_credits_minor: number;
    total_debits_minor: number;
  };
  lines: BankStatementLine[];
}

const STATUS_TONE: Record<MatchStatus, Tone> = {
  auto_matched: "ok",
  manual_matched: "ok",
  unmatched: "warn",
  ignored: "muted",
};

function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("figbloom_api_token") ?? localStorage.getItem("api_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function fmtKes(minor: number): string {
  return `KES ${(minor / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BankReconciliation() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [statements, setStatements] = useState<BankStatement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StatementDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // Upload form
  const [showUpload, setShowUpload] = useState(false);
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [csvText, setCsvText] = useState("");
  const [uploading, setUploading] = useState(false);

  // Match / Ignore modal
  const [matchingLine, setMatchingLine] = useState<BankStatementLine | null>(null);
  const [matchInvoiceId, setMatchInvoiceId] = useState("");
  const [matchPaymentId, setMatchPaymentId] = useState("");
  const [matchNote, setMatchNote] = useState("");
  const [ignoringLine, setIgnoringLine] = useState<BankStatementLine | null>(null);
  const [ignoreNote, setIgnoreNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadStatements() {
    const base = apiBaseUrl();
    if (!base) return;
    setLoading(true);
    try {
      const res = await fetch(`${base}/v1/tenants/${tenant.id}/finance/bank-reconciliation/statements?limit=30`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { statements?: BankStatement[] };
      const list = json.statements ?? [];
      setStatements(list);
      if (!selectedId && list[0]) setSelectedId(list[0].id);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(statementId: string) {
    const base = apiBaseUrl();
    if (!base) return;
    const res = await fetch(`${base}/v1/tenants/${tenant.id}/finance/bank-reconciliation/statements/${statementId}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    setDetail((await res.json()) as StatementDetail);
  }

  useEffect(() => {
    void loadStatements();
  }, [tenant.id]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, tenant.id]);

  async function handleCsvFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    toast(`Loaded ${file.name}`);
  }

  async function submitImport() {
    if (!bankName.trim() || !accountNumber.trim() || !csvText.trim()) {
      toast("Enter bank name, account number, and select or paste a CSV statement.", "error");
      return;
    }
    setUploading(true);
    try {
      const res = await fetch(`${apiBaseUrl()}/v1/tenants/${tenant.id}/finance/bank-reconciliation/statements`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          bank_name: bankName.trim(),
          account_number: accountNumber.trim(),
          csv_text: csvText,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { statement?: BankStatement; error?: { message?: string } };
      if (!res.ok || !json.statement) {
        toast(json.error?.message ?? "Failed to import bank statement.", "error");
        return;
      }
      toast(`Imported ${json.statement.row_count} lines (${json.statement.matched_count} auto-matched).`);
      setShowUpload(false);
      setBankName("");
      setAccountNumber("");
      setCsvText("");
      await loadStatements();
      setSelectedId(json.statement.id);
    } finally {
      setUploading(false);
    }
  }

  async function submitMatch() {
    if (!matchingLine) return;
    if (!matchInvoiceId.trim() && !matchPaymentId.trim()) {
      toast("Enter either an existing Payment ID or an Invoice ID to record a bank payment.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `${apiBaseUrl()}/v1/tenants/${tenant.id}/finance/bank-reconciliation/lines/${matchingLine.id}/match`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            ...(matchPaymentId.trim() ? { payment_id: matchPaymentId.trim() } : {}),
            ...(matchInvoiceId.trim() ? { invoice_id: matchInvoiceId.trim() } : {}),
            ...(matchNote.trim() ? { note: matchNote.trim() } : {}),
          }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        toast(json.error?.message ?? "Could not match bank line.", "error");
        return;
      }
      toast("Bank transaction matched.");
      setMatchingLine(null);
      setMatchInvoiceId("");
      setMatchPaymentId("");
      setMatchNote("");
      if (selectedId) await loadDetail(selectedId);
      await loadStatements();
    } finally {
      setBusy(false);
    }
  }

  async function submitIgnore() {
    if (!ignoringLine || ignoreNote.trim().length < 3) {
      toast("Provide a reason (at least 3 characters) to ignore this line.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `${apiBaseUrl()}/v1/tenants/${tenant.id}/finance/bank-reconciliation/lines/${ignoringLine.id}/ignore`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ note: ignoreNote.trim() }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        toast(json.error?.message ?? "Could not ignore line.", "error");
        return;
      }
      toast("Bank line marked as ignored.");
      setIgnoringLine(null);
      setIgnoreNote("");
      if (selectedId) await loadDetail(selectedId);
      await loadStatements();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Finance · Bank reconciliation"
        title="Bank reconciliation"
        blurb="Import bank statement CSVs to automatically match fee deposits against recorded payments and reconcile unmatched credits."
        actions={<Button variant="accent" onClick={() => setShowUpload(true)}>Import bank statement</Button>}
      />

      <div className="space-y-6 px-7 py-6">
        {detail && (
          <StatRow
            stats={[
              { label: "Total credits", value: fmtKes(detail.summary.total_credits_minor), sub: `${detail.statement.row_count} rows imported` },
              { label: "Matched credits", value: fmtKes(detail.summary.matched_credits_minor), sub: `${detail.statement.matched_count} lines matched` },
              {
                label: "Unmatched credits",
                value: fmtKes(detail.summary.unmatched_credits_minor),
                sub: `${detail.statement.unmatched_count} lines remaining`,
                alarming: detail.statement.unmatched_count > 0,
              },
              { label: "Total debits", value: fmtKes(detail.summary.total_debits_minor), sub: detail.statement.status.toUpperCase() },
            ]}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-[0.35fr_0.65fr]">
          <section className="rounded-xl border border-line bg-white p-4">
            <h2 className="mb-3 text-[14px] font-semibold text-ink">Imported statements</h2>
            {loading && statements.length === 0 ? (
              <p className="text-[13px] text-ink-mute">Loading statements…</p>
            ) : statements.length === 0 ? (
              <p className="text-[13px] text-ink-mute">No bank statements uploaded yet.</p>
            ) : (
              <ul className="space-y-2">
                {statements.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        selectedId === s.id ? "border-forest bg-sunken/70" : "border-line hover:border-forest/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13.5px] font-medium text-ink">{s.bank_name}</span>
                        <Badge tone={s.status === "reconciled" ? "ok" : "warn"}>{s.status}</Badge>
                      </div>
                      <p className="text-[12px] text-ink-mute">
                        Acct {s.account_number} · {s.matched_count}/{s.row_count} matched
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-line bg-white p-4">
            <h2 className="mb-3 text-[14px] font-semibold text-ink">
              {detail ? `${detail.statement.bank_name} (${detail.statement.account_number})` : "Statement lines"}
            </h2>
            {!detail ? (
              <p className="text-[13px] text-ink-mute">Select a statement to review transactions.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-line text-ink-mute">
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Reference / Narration</th>
                      <th className="py-2 pr-3 text-right">Amount</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id} className="border-b border-line/60">
                        <td className="py-2.5 pr-3 font-mono text-[12px]">{line.txn_date}</td>
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-ink">{line.reference ?? "—"}</div>
                          <div className="text-[11.5px] text-ink-mute">{line.description}</div>
                          {line.match_note && <div className="text-[11px] text-forest">{line.match_note}</div>}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-mono">
                          {line.direction === "debit" ? "-" : "+"}
                          {fmtKes(line.amount_minor)}
                        </td>
                        <td className="py-2.5 pr-3">
                          <Badge tone={STATUS_TONE[line.match_status]}>{line.match_status.replace("_", " ")}</Badge>
                        </td>
                        <td className="py-2.5 text-right">
                          {line.match_status === "unmatched" && (
                            <div className="inline-flex gap-1.5">
                              {line.direction === "credit" && (
                                <Button
                                  onClick={() => {
                                    setMatchingLine(line);
                                    setMatchInvoiceId(line.matched_invoice_id ?? "");
                                    setMatchPaymentId("");
                                    setMatchNote("");
                                  }}
                                >
                                  Match
                                </Button>
                              )}
                              <Button onClick={() => { setIgnoringLine(line); setIgnoreNote(""); }}>
                                Ignore
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      <Modal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        title="Import bank statement CSV"
        actions={
          <>
            <Button onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button variant="accent" disabled={uploading} onClick={() => void submitImport()}>
              {uploading ? "Importing…" : "Import & auto-match"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField id="bank-name" label="Bank name" placeholder="e.g. KCB Bank Kenya" value={bankName} onChange={(e) => setBankName(e.target.value)} />
          <TextField id="bank-acct" label="Account number" placeholder="e.g. 1102345678" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
          <div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void handleCsvFile(e.target.files?.[0])} />
            <Button onClick={() => fileRef.current?.click()}>Choose CSV file</Button>
          </div>
          <textarea
            className="w-full rounded-md border border-[#D3DAD5] p-2.5 font-mono text-[12px] outline-none focus:border-forest"
            rows={6}
            placeholder="Or paste bank CSV rows here (Date, Reference, Narration, Debit, Credit, Balance)…"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(matchingLine)}
        onClose={() => setMatchingLine(null)}
        title="Match bank credit"
        actions={
          <>
            <Button onClick={() => setMatchingLine(null)}>Cancel</Button>
            <Button variant="accent" disabled={busy} onClick={() => void submitMatch()}>
              {busy ? "Matching…" : "Confirm match"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-mute">
            Link this deposit ({matchingLine ? fmtKes(matchingLine.amount_minor) : ""}) to an existing Payment ID, or enter an Invoice ID to record a new bank payment automatically.
          </p>
          <TextField id="match-invoice" label="Invoice ID (records a new bank payment)" value={matchInvoiceId} onChange={(e) => setMatchInvoiceId(e.target.value)} />
          <TextField id="match-payment" label="Or existing Payment ID" value={matchPaymentId} onChange={(e) => setMatchPaymentId(e.target.value)} />
          <TextField id="match-note" label="Note (optional)" value={matchNote} onChange={(e) => setMatchNote(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={Boolean(ignoringLine)}
        onClose={() => setIgnoringLine(null)}
        title="Ignore non-fee bank entry"
        actions={
          <>
            <Button onClick={() => setIgnoringLine(null)}>Cancel</Button>
            <Button variant="accent" disabled={busy} onClick={() => void submitIgnore()}>
              {busy ? "Saving…" : "Mark ignored"}
            </Button>
          </>
        }
      >
        <TextField
          id="ignore-note"
          label="Reason (e.g. Monthly bank ledger fee, internal transfer)"
          value={ignoreNote}
          onChange={(e) => setIgnoreNote(e.target.value)}
        />
      </Modal>
    </>
  );
}
