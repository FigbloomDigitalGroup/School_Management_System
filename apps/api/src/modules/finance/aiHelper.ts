import type { Tx } from "../../db/sql.js";
import { validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getTermById } from "../academics/structure.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { CURRENCY, toMinor } from "./money.js";

/**
 * AI helper billing foundations (legacy 20261101100000_ai_helper_optin.sql). Billing is NOT available:
 * the database holds billing_enabled false, and no charge is ever created here. Pricing, turning billing
 * on, refunds and the opt-in-to-charge rule are owner decisions. AI execution and token usage are a
 * separate domain (Stage 13).
 */
export const AI_HELPER_BILLING_AVAILABLE = false as const;

export interface AiHelperSettings {
  tenantId: string;
  access_mode: "all" | "opt_in";
  price_minor: number;
  currency: typeof CURRENCY;
  cancel_days: number;
  billing_available: false;
  billing_enabled: false;
  updated_by: string | null;
  updated_at: string | null;
}

export async function getAiHelperSettings(tx: Tx, input: { tenantId: string }): Promise<AiHelperSettings> {
  const res = await tx.query<{ access_mode: "all" | "opt_in"; price_minor: string; cancel_days: number; updated_by: string | null; updated_at: Date }>(
    `SELECT access_mode, price_minor, cancel_days, updated_by, updated_at FROM finance_ai_helper_settings WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const r = res.rows[0];
  return {
    tenantId: input.tenantId,
    access_mode: r?.access_mode ?? "all",
    price_minor: r ? toMinor(r.price_minor) : 0,
    currency: CURRENCY,
    cancel_days: r?.cancel_days ?? 7,
    billing_available: AI_HELPER_BILLING_AVAILABLE,
    billing_enabled: false,
    updated_by: r?.updated_by ?? null,
    updated_at: r ? r.updated_at.toISOString() : null,
  };
}

export async function putAiHelperSettings(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; access_mode: "all" | "opt_in"; price_minor: number; cancel_days: number; ip?: string | null },
): Promise<AiHelperSettings> {
  if (!Number.isSafeInteger(input.price_minor) || input.price_minor < 0 || input.price_minor > 10_000_000 || input.price_minor % 100 !== 0) {
    throw validationError("price_minor must be whole shillings from 0 to 10,000,000 cents");
  }
  if (!Number.isInteger(input.cancel_days) || input.cancel_days < 0 || input.cancel_days > 60) {
    throw validationError("cancel_days must be 0–60");
  }
  const before = await getAiHelperSettings(tx, input);
  await tx.query(
    `INSERT INTO finance_ai_helper_settings (tenant_id, access_mode, price_minor, cancel_days, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET access_mode = EXCLUDED.access_mode, price_minor = EXCLUDED.price_minor,
       cancel_days = EXCLUDED.cancel_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [input.tenantId, input.access_mode, input.price_minor, input.cancel_days, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.ai_helper.settings_updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      from: { accessMode: before.access_mode, priceMinor: before.price_minor, cancelDays: before.cancel_days },
      to: { accessMode: input.access_mode, priceMinor: input.price_minor, cancelDays: input.cancel_days },
    },
    ip: input.ip,
  });
  return getAiHelperSettings(tx, input);
}

export interface AiHelperOptin {
  learner_id: string;
  term_id: string;
  opted_in: boolean;
  changed_by: string;
  changed_at: string;
}

/** Roster of opt-in choices for a term (legacy ai_helper_roster; office: finance read). */
export async function listAiHelperOptins(tx: Tx, input: { tenantId: string; termId: string; page: PageInput }): Promise<Page<AiHelperOptin>> {
  await getTermById(tx, { tenantId: input.tenantId, termId: input.termId });
  const out = await pageQuery<{ id: string; learner_id: string; term_id: string; opted_in: boolean; changed_by: string; changed_at: Date }>(
    tx,
    `SELECT learner_id AS id, learner_id, term_id, opted_in, changed_by, changed_at
       FROM finance_ai_helper_optins WHERE tenant_id = $1 AND term_id = $2`,
    [input.tenantId, input.termId],
    { name: "ai_helper_optins", expr: "q.learner_id::text", type: "text", dir: "asc" },
    input.page,
  );
  return {
    items: out.rows.map((r) => ({
      learner_id: r.learner_id,
      term_id: r.term_id,
      opted_in: r.opted_in,
      changed_by: r.changed_by,
      changed_at: r.changed_at.toISOString(),
    })),
    page: out.page,
  };
}

/** Record a family's opt-in choice (the route authorizes the payer first). Never creates a charge. */
export async function setAiHelperOptin(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; learner_id: string; term_id: string; opted_in: boolean },
): Promise<AiHelperOptin> {
  await getTermById(tx, { tenantId: input.tenantId, termId: input.term_id });
  const res = await tx.query<{ changed_at: Date }>(
    `INSERT INTO finance_ai_helper_optins (tenant_id, learner_id, term_id, opted_in, changed_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, learner_id, term_id) DO UPDATE SET opted_in = EXCLUDED.opted_in, changed_by = EXCLUDED.changed_by, changed_at = now()
     RETURNING changed_at`,
    [input.tenantId, input.learner_id, input.term_id, input.opted_in, input.actorUserId],
  );
  await tx.query(
    `INSERT INTO finance_ai_helper_optin_log (tenant_id, learner_id, term_id, opted_in, changed_by) VALUES ($1, $2, $3, $4, $5)`,
    [input.tenantId, input.learner_id, input.term_id, input.opted_in, input.actorUserId],
  );
  return {
    learner_id: input.learner_id,
    term_id: input.term_id,
    opted_in: input.opted_in,
    changed_by: input.actorUserId,
    changed_at: res.rows[0]!.changed_at.toISOString(),
  };
}
