import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { CURRENCY, toMinor } from "./money.js";
import { recordPayment, type PublicPayment } from "./payments.js";

export type BankLineDirection = "credit" | "debit";
export type BankLineMatchStatus = "unmatched" | "auto_matched" | "manual_matched" | "ignored";

export interface ParsedBankLine {
  txn_date: string;
  reference: string | null;
  description: string;
  amount_minor: number;
  direction: BankLineDirection;
  balance_minor: number | null;
}

export interface PublicBankStatement {
  id: string;
  tenantId: string;
  bank_name: string;
  account_number: string;
  statement_from: string | null;
  statement_to: string | null;
  currency: string;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  row_count: number;
  matched_count: number;
  unmatched_count: number;
  status: "open" | "reconciled";
  uploaded_by: string | null;
  created_at: string;
}

export interface PublicBankStatementLine {
  id: string;
  statement_id: string;
  line_no: number;
  txn_date: string;
  reference: string | null;
  reference_norm: string | null;
  description: string;
  amount_minor: number;
  direction: BankLineDirection;
  balance_minor: number | null;
  match_status: BankLineMatchStatus;
  matched_payment_id: string | null;
  matched_invoice_id: string | null;
  matched_by: string | null;
  matched_at: string | null;
  match_note: string | null;
}

export function normalizeBankReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return norm.length >= 4 ? norm.slice(0, 60) : null;
}

/** Extract a `FIG-XXXXXXXX` invoice reference prefix from a bank reference or narration. */
export function extractInvoicePrefix(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/\bFIG[-_ ]?([0-9A-F]{8})\b/);
  return m ? m[1]!.toLowerCase() : null;
}

/** Parse a money string (e.g. "KES 15,000.00", "(500.00)", "15000") into integer minor units. */
export function parseMoneyToMinor(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || s === "-" || s === "—") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(KES|KSH|USD|UGX|TZS)\s*/i, "").replace(/,/g, "").trim();
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor > 1e12) return null;
  return negative ? -minor : minor;
}

/** Parse YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YYYY into ISO YYYY-MM-DD. */
export function parseBankDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return null;
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((c) => c.trim().length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  return rows;
}

/**
 * Parses a bank statement CSV (KCB, Equity, Co-op, NCBA, Absa, generic) into normalized lines.
 * Supports either separate Credit/Debit columns or a single signed Amount column.
 */
export function parseBankStatementCsv(csvText: string): ParsedBankLine[] {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) throw validationError("Bank statement CSV must contain a header row and at least one transaction row");

  const headers = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const col = (...names: string[]) => headers.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const dateIdx = col("txn_date", "transaction_date", "value_date", "posting_date", "date");
  const refIdx = col("reference", "ref", "cheque", "receipt", "txn_id", "transaction_id");
  const descIdx = col("description", "narration", "details", "particulars", "memo");
  const creditIdx = col("credit", "deposit", "money_in", "paid_in", "cr");
  const debitIdx = col("debit", "withdrawal", "money_out", "paid_out", "dr");
  const amountIdx = col("amount");
  const balanceIdx = col("balance", "running_balance");

  if (dateIdx < 0) throw validationError("CSV is missing a Date column");
  if (creditIdx < 0 && debitIdx < 0 && amountIdx < 0) {
    throw validationError("CSV must contain Credit/Debit columns or an Amount column");
  }

  const parsed: ParsedBankLine[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const txnDate = parseBankDate(r[dateIdx]);
    if (!txnDate) continue;

    let amountMinor: number | null = null;
    let direction: BankLineDirection = "credit";

    if (creditIdx >= 0 || debitIdx >= 0) {
      const cr = creditIdx >= 0 ? parseMoneyToMinor(r[creditIdx]) : null;
      const dr = debitIdx >= 0 ? parseMoneyToMinor(r[debitIdx]) : null;
      if (cr && cr > 0) {
        amountMinor = cr;
        direction = "credit";
      } else if (dr && Math.abs(dr) > 0) {
        amountMinor = Math.abs(dr);
        direction = "debit";
      }
    } else if (amountIdx >= 0) {
      const amt = parseMoneyToMinor(r[amountIdx]);
      if (amt && amt !== 0) {
        direction = amt > 0 ? "credit" : "debit";
        amountMinor = Math.abs(amt);
      }
    }

    if (!amountMinor || amountMinor <= 0) continue;

    const rawRef = refIdx >= 0 ? r[refIdx]?.trim() || null : null;
    const rawDesc = descIdx >= 0 ? r[descIdx]?.trim() || "" : "";
    const balanceMinor = balanceIdx >= 0 ? parseMoneyToMinor(r[balanceIdx]) : null;

    parsed.push({
      txn_date: txnDate,
      reference: rawRef ? rawRef.slice(0, 80) : null,
      description: rawDesc.slice(0, 300),
      amount_minor: amountMinor,
      direction,
      balance_minor: balanceMinor,
    });
  }

  if (parsed.length === 0) throw validationError("No valid transaction rows found in bank statement CSV");
  if (parsed.length > 5_000) throw validationError("Bank statement exceeds maximum of 5,000 rows per upload");
  return parsed;
}

type StatementRow = {
  id: string;
  tenant_id: string;
  bank_name: string;
  account_number: string;
  statement_from: string | null;
  statement_to: string | null;
  currency: string;
  opening_balance_minor: string | null;
  closing_balance_minor: string | null;
  row_count: number;
  matched_count: number;
  unmatched_count: number;
  status: "open" | "reconciled";
  uploaded_by: string | null;
  created_at: Date;
};

type LineRow = {
  id: string;
  statement_id: string;
  line_no: number;
  txn_date: string;
  reference: string | null;
  reference_norm: string | null;
  description: string;
  amount_minor: string;
  direction: BankLineDirection;
  balance_minor: string | null;
  match_status: BankLineMatchStatus;
  matched_payment_id: string | null;
  matched_invoice_id: string | null;
  matched_by: string | null;
  matched_at: Date | null;
  match_note: string | null;
};

const STMT_COLS = `id, tenant_id, bank_name, account_number, statement_from::text AS statement_from, statement_to::text AS statement_to,
  currency, opening_balance_minor, closing_balance_minor, row_count, matched_count, unmatched_count, status, uploaded_by, created_at`;

const LINE_COLS = `id, statement_id, line_no, txn_date::text AS txn_date, reference, reference_norm, description,
  amount_minor, direction, balance_minor, match_status, matched_payment_id, matched_invoice_id, matched_by, matched_at, match_note`;

function mapStatement(r: StatementRow): PublicBankStatement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    bank_name: r.bank_name,
    account_number: r.account_number,
    statement_from: r.statement_from,
    statement_to: r.statement_to,
    currency: r.currency,
    opening_balance_minor: r.opening_balance_minor === null ? null : toMinor(r.opening_balance_minor),
    closing_balance_minor: r.closing_balance_minor === null ? null : toMinor(r.closing_balance_minor),
    row_count: r.row_count,
    matched_count: r.matched_count,
    unmatched_count: r.unmatched_count,
    status: r.status,
    uploaded_by: r.uploaded_by,
    created_at: r.created_at.toISOString(),
  };
}

function mapLine(r: LineRow): PublicBankStatementLine {
  return {
    id: r.id,
    statement_id: r.statement_id,
    line_no: r.line_no,
    txn_date: r.txn_date,
    reference: r.reference,
    reference_norm: r.reference_norm,
    description: r.description,
    amount_minor: toMinor(r.amount_minor),
    direction: r.direction,
    balance_minor: r.balance_minor === null ? null : toMinor(r.balance_minor),
    match_status: r.match_status,
    matched_payment_id: r.matched_payment_id,
    matched_invoice_id: r.matched_invoice_id,
    matched_by: r.matched_by,
    matched_at: r.matched_at ? r.matched_at.toISOString() : null,
    match_note: r.match_note,
  };
}

async function refreshStatementCounters(tx: Tx, tenantId: string, statementId: string): Promise<PublicBankStatement> {
  const counts = await tx.query<{ matched: string; unmatched: string }>(
    `SELECT
       count(*) FILTER (WHERE match_status IN ('auto_matched', 'manual_matched')) AS matched,
       count(*) FILTER (WHERE match_status = 'unmatched') AS unmatched
     FROM finance_bank_statement_lines
     WHERE tenant_id = $1 AND statement_id = $2`,
    [tenantId, statementId],
  );
  const matched = Number(counts.rows[0]!.matched);
  const unmatched = Number(counts.rows[0]!.unmatched);
  const status = unmatched === 0 ? "reconciled" : "open";
  const updated = await tx.query<StatementRow>(
    `UPDATE finance_bank_statements
        SET matched_count = $3, unmatched_count = $4, status = $5
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${STMT_COLS}`,
    [tenantId, statementId, matched, unmatched, status],
  );
  return mapStatement(updated.rows[0]!);
}

/**
 * Imports a bank statement (from CSV text or pre-parsed lines) and automatically matches credit
 * transactions against confirmed `finance_payments` (by reference/M-Pesa receipt + amount) and
 * detects suggested invoices via `FIG-XXXXXXXX` prefixes.
 */
export async function importBankStatement(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    bank_name: string;
    account_number: string;
    opening_balance_minor?: number | null;
    closing_balance_minor?: number | null;
    csv_text?: string;
    lines?: ParsedBankLine[];
    ip?: string | null;
  },
): Promise<{ statement: PublicBankStatement; lines: PublicBankStatementLine[] }> {
  const parsedLines = input.lines && input.lines.length > 0 ? input.lines : input.csv_text ? parseBankStatementCsv(input.csv_text) : [];
  if (parsedLines.length === 0) throw validationError("Provide csv_text or non-empty lines");

  const dates = parsedLines.map((l) => l.txn_date).sort();
  const stmtRes = await tx.query<StatementRow>(
    `INSERT INTO finance_bank_statements
       (tenant_id, bank_name, account_number, statement_from, statement_to, currency, opening_balance_minor, closing_balance_minor, row_count, uploaded_by)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10)
     RETURNING ${STMT_COLS}`,
    [
      input.tenantId,
      input.bank_name.trim(),
      input.account_number.trim(),
      dates[0] ?? null,
      dates[dates.length - 1] ?? null,
      CURRENCY,
      input.opening_balance_minor ?? null,
      input.closing_balance_minor ?? null,
      parsedLines.length,
      input.actorUserId,
    ],
  );
  const statementId = stmtRes.rows[0]!.id;

  const insertedLines: PublicBankStatementLine[] = [];
  for (let i = 0; i < parsedLines.length; i++) {
    const line = parsedLines[i]!;
    const refNorm = normalizeBankReference(line.reference);
    let matchStatus: BankLineMatchStatus = "unmatched";
    let matchedPaymentId: string | null = null;
    let matchedInvoiceId: string | null = null;
    let matchNote: string | null = null;

    if (line.direction === "credit") {
      // 1. Exact reference + amount match against an existing confirmed payment
      if (refNorm) {
        const pay = await tx.query<{ id: string; invoice_id: string }>(
          `SELECT id, invoice_id FROM finance_payments
            WHERE tenant_id = $1 AND status = 'success' AND amount_minor = $2
              AND (reference_norm = $3 OR mpesa_receipt = $3)
            LIMIT 1`,
          [input.tenantId, line.amount_minor, refNorm],
        );
        if (pay.rows[0]) {
          matchStatus = "auto_matched";
          matchedPaymentId = pay.rows[0].id;
          matchedInvoiceId = pay.rows[0].invoice_id;
          matchNote = "Auto-matched by reference and amount";
        }
      }
      // 2. If not matched to a payment yet, check for a FIG-XXXXXXXX invoice reference hint
      if (!matchedInvoiceId) {
        const prefix = extractInvoicePrefix(`${line.reference ?? ""} ${line.description}`);
        if (prefix) {
          const inv = await tx.query<{ id: string }>(
            `SELECT id FROM finance_invoices
              WHERE tenant_id = $1 AND voided_at IS NULL AND lower(id::text) LIKE $2
              LIMIT 1`,
            [input.tenantId, `${prefix}%`],
          );
          if (inv.rows[0]) {
            matchedInvoiceId = inv.rows[0].id;
            matchNote = "Suggested invoice from FIG reference";
          }
        }
      }
    }

    const ins = await tx.query<LineRow>(
      `INSERT INTO finance_bank_statement_lines
         (tenant_id, statement_id, line_no, txn_date, reference, reference_norm, description, amount_minor, direction, balance_minor,
          match_status, matched_payment_id, matched_invoice_id, matched_at, match_note)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${LINE_COLS}`,
      [
        input.tenantId,
        statementId,
        i + 1,
        line.txn_date,
        line.reference,
        refNorm,
        line.description,
        line.amount_minor,
        line.direction,
        line.balance_minor,
        matchStatus,
        matchedPaymentId,
        matchedInvoiceId,
        matchStatus === "auto_matched" ? new Date() : null,
        matchNote,
      ],
    );
    insertedLines.push(mapLine(ins.rows[0]!));
  }

  const statement = await refreshStatementCounters(tx, input.tenantId, statementId);

  await recordSecurityEvent(tx, {
    eventType: "finance.bank_statement.imported",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      statementId,
      bankName: statement.bank_name,
      rowCount: statement.row_count,
      matchedCount: statement.matched_count,
      unmatchedCount: statement.unmatched_count,
    },
    ip: input.ip,
  });

  return { statement, lines: insertedLines };
}

export async function listBankStatements(tx: Tx, input: { tenantId: string; page: PageInput }): Promise<Page<PublicBankStatement>> {
  const out = await pageQuery<StatementRow>(
    tx,
    `SELECT ${STMT_COLS} FROM finance_bank_statements WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "bank_statements", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapStatement), page: out.page };
}

export async function getBankStatementDetail(
  tx: Tx,
  input: { tenantId: string; statementId: string; matchStatus?: BankLineMatchStatus },
): Promise<{
  statement: PublicBankStatement;
  summary: {
    total_credits_minor: number;
    matched_credits_minor: number;
    unmatched_credits_minor: number;
    total_debits_minor: number;
  };
  lines: PublicBankStatementLine[];
}> {
  const stmtRes = await tx.query<StatementRow>(`SELECT ${STMT_COLS} FROM finance_bank_statements WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.statementId,
  ]);
  if (!stmtRes.rows[0]) throw notFound("Bank statement not found");

  const params: unknown[] = [input.tenantId, input.statementId];
  const statusFilter = input.matchStatus ? ` AND match_status = $${params.push(input.matchStatus)}` : "";
  const linesRes = await tx.query<LineRow>(
    `SELECT ${LINE_COLS} FROM finance_bank_statement_lines
      WHERE tenant_id = $1 AND statement_id = $2${statusFilter}
      ORDER BY line_no ASC`,
    params,
  );

  const aggRes = await tx.query<{
    total_credits: string;
    matched_credits: string;
    unmatched_credits: string;
    total_debits: string;
  }>(
    `SELECT
       COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0) AS total_credits,
       COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit' AND match_status IN ('auto_matched', 'manual_matched')), 0) AS matched_credits,
       COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit' AND match_status = 'unmatched'), 0) AS unmatched_credits,
       COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0) AS total_debits
     FROM finance_bank_statement_lines
     WHERE tenant_id = $1 AND statement_id = $2`,
    [input.tenantId, input.statementId],
  );
  const agg = aggRes.rows[0]!;

  return {
    statement: mapStatement(stmtRes.rows[0]),
    summary: {
      total_credits_minor: toMinor(agg.total_credits),
      matched_credits_minor: toMinor(agg.matched_credits),
      unmatched_credits_minor: toMinor(agg.unmatched_credits),
      total_debits_minor: toMinor(agg.total_debits),
    },
    lines: linesRes.rows.map(mapLine),
  };
}

/**
 * Manually reconcile a bank statement line either by linking it to an existing payment (`payment_id`)
 * OR by recording a brand-new `bank` payment against `invoice_id` in the same transaction.
 */
export async function matchBankStatementLine(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    lineId: string;
    payment_id?: string | null;
    invoice_id?: string | null;
    note?: string | null;
    ip?: string | null;
  },
): Promise<{ line: PublicBankStatementLine; statement: PublicBankStatement; created_payment?: PublicPayment }> {
  const lineRes = await tx.query<LineRow>(
    `SELECT ${LINE_COLS} FROM finance_bank_statement_lines WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.lineId],
  );
  const line = lineRes.rows[0];
  if (!line) throw notFound("Bank statement line not found");
  if (line.match_status === "auto_matched" || line.match_status === "manual_matched") {
    throw conflict("This bank statement line is already matched");
  }
  if (line.direction !== "credit") {
    throw validationError("Only credit transactions can be matched to fee payments; use ignore for debits");
  }

  let matchedPaymentId: string;
  let matchedInvoiceId: string;
  let createdPayment: PublicPayment | undefined;

  if (input.payment_id) {
    const pay = await tx.query<{ id: string; invoice_id: string; status: string }>(
      `SELECT id, invoice_id, status FROM finance_payments WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.payment_id],
    );
    if (!pay.rows[0]) throw notFound("Payment not found");
    if (pay.rows[0].status !== "success") throw conflict("Only confirmed payments can be matched");
    matchedPaymentId = pay.rows[0].id;
    matchedInvoiceId = pay.rows[0].invoice_id;
  } else if (input.invoice_id) {
    const ref = line.reference ?? `BANK-${line.txn_date}-${line.line_no}`;
    const recorded = await recordPayment(tx, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      invoice_id: input.invoice_id,
      amount_minor: toMinor(line.amount_minor),
      method: "bank",
      reference: ref.slice(0, 60),
      ip: input.ip,
    });
    matchedPaymentId = recorded.payment.id;
    matchedInvoiceId = input.invoice_id;
    createdPayment = recorded.payment;
  } else {
    throw validationError("Either payment_id or invoice_id is required to match a bank statement line");
  }

  const updated = await tx.query<LineRow>(
    `UPDATE finance_bank_statement_lines
        SET match_status = 'manual_matched',
            matched_payment_id = $3,
            matched_invoice_id = $4,
            matched_by = $5,
            matched_at = now(),
            match_note = $6
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${LINE_COLS}`,
    [input.tenantId, input.lineId, matchedPaymentId, matchedInvoiceId, input.actorUserId, input.note?.trim() || "Manually matched"],
  );

  const statement = await refreshStatementCounters(tx, input.tenantId, line.statement_id);

  await recordSecurityEvent(tx, {
    eventType: "finance.bank_line.matched",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      statementId: line.statement_id,
      lineId: input.lineId,
      paymentId: matchedPaymentId,
      invoiceId: matchedInvoiceId,
      createdNewPayment: Boolean(createdPayment),
    },
    ip: input.ip,
  });

  return { line: mapLine(updated.rows[0]!), statement, ...(createdPayment ? { created_payment: createdPayment } : {}) };
}

export async function ignoreBankStatementLine(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; lineId: string; note: string; ip?: string | null },
): Promise<{ line: PublicBankStatementLine; statement: PublicBankStatement }> {
  const note = input.note.trim();
  if (note.length < 3 || note.length > 300) throw validationError("note must be 3–300 characters");

  const lineRes = await tx.query<LineRow>(
    `SELECT ${LINE_COLS} FROM finance_bank_statement_lines WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.lineId],
  );
  const line = lineRes.rows[0];
  if (!line) throw notFound("Bank statement line not found");
  if (line.match_status === "auto_matched" || line.match_status === "manual_matched") {
    throw conflict("A matched bank statement line cannot be ignored");
  }

  const updated = await tx.query<LineRow>(
    `UPDATE finance_bank_statement_lines
        SET match_status = 'ignored', matched_by = $3, matched_at = now(), match_note = $4
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${LINE_COLS}`,
    [input.tenantId, input.lineId, input.actorUserId, note],
  );

  const statement = await refreshStatementCounters(tx, input.tenantId, line.statement_id);

  await recordSecurityEvent(tx, {
    eventType: "finance.bank_line.ignored",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { statementId: line.statement_id, lineId: input.lineId, note },
    ip: input.ip,
  });

  return { line: mapLine(updated.rows[0]!), statement };
}
