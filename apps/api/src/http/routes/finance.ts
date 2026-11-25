import type { FastifyInstance } from "fastify";
import { calendarDateString } from "../schemas.js";
import { z } from "zod";
import type { AppPool } from "../../db/pool.js";
import { withSystemTenantTransaction } from "../../db/systemTenantTransaction.js";
import { parseIdempotencyKey, runIdempotent } from "../../modules/idempotency/idempotency.js";
import { hasPermission, requirePermission } from "../../modules/rbac/authorize.js";
import { archiveFeeItem, createFeeItem, getFeeItem, listFeeItems, updateFeeItem } from "../../modules/finance/feeItems.js";
import {
  addCharge,
  adjustInvoiceTotal,
  billTerm,
  getInvoice,
  getInvoiceDetail,
  listInvoices,
  setDueDate,
  voidCharge,
  voidInvoice,
} from "../../modules/finance/invoices.js";
import { buildInvoicePdfForTenant } from "../../modules/finance/invoicePdf.js";
import {
  dispatchExternalInvoiceDelivery,
  prepareInvoiceDelivery,
  recordInvoiceDeliveryAudit,
  type InvoiceDeliveryChannel,
} from "../../modules/finance/invoiceDelivery.js";
import { getPayment, listPayments, recordPayment } from "../../modules/finance/payments.js";
import { createPrompt, recordPushOutcome } from "../../modules/finance/mpesa.js";
import { callbackUrlWithToken } from "../../modules/finance/mpesaProvider.js";
import { getProof, listProofs, rejectProof, submitProof } from "../../modules/finance/proofs.js";
import { listFindings, listRuns, resolveFinding, runReconciliation } from "../../modules/finance/reconciliation.js";
import {
  getBankStatementDetail,
  ignoreBankStatementLine,
  importBankStatement,
  listBankStatements,
  matchBankStatementLine,
} from "../../modules/finance/bankReconciliation.js";
import { assertRecentAuth } from "../../modules/auth/reauth.js";
import { assignFinding, withdrawUnacknowledgedPrompt } from "../../modules/finance/reconciliationCases.js";
import { getAiHelperSettings, listAiHelperOptins, putAiHelperSettings, setAiHelperOptin } from "../../modules/finance/aiHelper.js";
import { assertMayPayFor } from "../../modules/finance/payer.js";
import { cancelSettlementJob } from "../../modules/finance/settlementJobs.js";
import { listMpesaEvents, operatorReconcile, type ProviderView } from "../../modules/finance/mpesaReconcile.js";
import { AppError, notFound, serviceUnavailable, validationError } from "../errors.js";
import { assertUuid, inTenant, optionalBool, optionalUuid, pageFrom } from "../routeKit.js";
import { parseOrThrow } from "../validation.js";

const DateString = calendarDateString;
const Minor = z.number().int().positive().max(100_000_000_000);

const FeeItemBody = z.strictObject({
  term_id: z.guid(),
  name: z.string().min(1).max(120),
  amount_minor: Minor,
  applies_to: z.enum(["all", "boarders", "day", "form_level"]),
  form_level: z.number().int().min(1).max(12).nullable().optional(),
});
const FeeItemPatch = z
  .strictObject({
    name: z.string().min(1).max(120).optional(),
    amount_minor: Minor.optional(),
    applies_to: z.enum(["all", "boarders", "day", "form_level"]).optional(),
    form_level: z.number().int().min(1).max(12).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field" });
const BillingRunBody = z.strictObject({ term_id: z.guid(), due_on: DateString });
const DueDateBody = z.strictObject({ due_on: DateString });
const ReasonBody = z.strictObject({ reason: z.string().min(3).max(300) });
const ChargeBody = z.strictObject({ amount_minor: Minor, reason: z.string().min(1).max(200) });
const AdjustBody = z.strictObject({
  expected_total_minor: z.number().int().min(0).max(100_000_000_000),
  new_total_minor: z.number().int().min(0).max(100_000_000_000),
  reason: z.string().min(3).max(300),
});
const PaymentBody = z.strictObject({
  invoice_id: z.guid(),
  amount_minor: Minor,
  method: z.enum(["mpesa", "bank", "cash", "cheque"]),
  reference: z.string().min(1).max(60).nullable().optional(),
  proof_id: z.guid().nullable().optional(),
});
const PromptBody = z.strictObject({
  invoice_id: z.guid(),
  amount_minor: Minor,
  msisdn: z.string().regex(/^254[17]\d{8}$/),
});
const ProofBody = z.strictObject({
  invoice_id: z.guid(),
  note: z.string().min(1).max(500).nullable().optional(),
  file: z
    .strictObject({
      file_name: z.string().min(1).max(200),
      content_type: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
      byte_size: z.number().int().min(1).max(10_485_760),
    })
    .nullable()
    .optional(),
  sms_text: z.string().min(10).max(2000).nullable().optional(),
  txn_source: z.enum(["mpesa", "airtel", "bank", "unknown"]).nullable().optional(),
  txn_code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{3,40}$/).nullable().optional(),
  txn_amount_minor: Minor.nullable().optional(),
  txn_at: z.iso.datetime({ offset: true }).nullable().optional(),
  txn_payee: z.string().max(120).nullable().optional(),
  txn_payee_number: z.string().max(30).nullable().optional(),
  txn_account: z.string().max(60).nullable().optional(),
});
const ReconBody = z.strictObject({ stale_after_minutes: z.number().int().min(5).max(10_080).optional() });
const ResolveBody = z.strictObject({ note: z.string().min(3).max(500), evidence: z.string().min(3).max(1000).optional() });
const AssignBody = z.strictObject({ owner_user_id: z.guid().nullable() });
const WithdrawBody = z.strictObject({ reason: z.string().min(3).max(300), evidence: z.string().min(3).max(1000) });
const CancelJobBody = z.strictObject({ reason: z.string().min(10).max(300) });
const ReconcileBody = z.strictObject({
  action: z.enum(["refresh", "settle_success", "mark_failed"]),
  receipt: z.string().min(6).max(40).optional(),
  note: z.string().min(10).max(500),
});
const AiSettingsBody = z.strictObject({
  access_mode: z.enum(["all", "opt_in"]),
  price_minor: z.number().int().min(0).max(10_000_000),
  cancel_days: z.number().int().min(0).max(60),
});
const OptinBody = z.strictObject({ learner_id: z.guid(), term_id: z.guid(), opted_in: z.boolean() });
const InvoiceDeliveryChannelEnum = z.enum(["in_app", "push", "email", "sms", "whatsapp"]);
const SendInvoiceBody = z.strictObject({
  channels: z.array(InvoiceDeliveryChannelEnum).min(1).max(5).optional(),
  custom_message: z.string().max(500).nullable().optional(),
});
const SendTermInvoicesBody = z.strictObject({
  channels: z.array(InvoiceDeliveryChannelEnum).min(1).max(5).optional(),
  status_filter: z.enum(["unpaid_only", "all"]).optional(),
  custom_message: z.string().max(500).nullable().optional(),
});
const BankStatementImportBody = z.strictObject({
  bank_name: z.string().min(1).max(120),
  account_number: z.string().min(1).max(60),
  opening_balance_minor: z.number().int().nullable().optional(),
  closing_balance_minor: z.number().int().nullable().optional(),
  csv_text: z.string().min(10).max(500_000).optional(),
  lines: z
    .array(
      z.strictObject({
        txn_date: DateString,
        reference: z.string().max(80).nullable(),
        description: z.string().max(300),
        amount_minor: Minor,
        direction: z.enum(["credit", "debit"]),
        balance_minor: z.number().int().nullable(),
      }),
    )
    .min(1)
    .max(5_000)
    .optional(),
});
const BankLineMatchBody = z.strictObject({
  payment_id: z.guid().nullable().optional(),
  invoice_id: z.guid().nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});
const BankLineIgnoreBody = z.strictObject({
  note: z.string().min(3).max(300),
});

const T = "/v1/tenants/{tenantId}/finance";
/** Request bodies by OpenAPI operation key; test/openapi.stage11.contract.test.ts compares them with the spec. */
export const FINANCE_REQUEST_SCHEMAS = {
  [`POST ${T}/fee-items`]: FeeItemBody,
  [`PATCH ${T}/fee-items/{feeItemId}`]: FeeItemPatch,
  [`POST ${T}/billing-runs`]: BillingRunBody,
  [`PUT ${T}/invoices/{invoiceId}/due-date`]: DueDateBody,
  [`POST ${T}/invoices/{invoiceId}/void`]: ReasonBody,
  [`POST ${T}/invoices/{invoiceId}/charges`]: ChargeBody,
  [`POST ${T}/invoices/{invoiceId}/charges/{chargeId}/void`]: ReasonBody,
  [`POST ${T}/invoices/{invoiceId}/adjustments`]: AdjustBody,
  [`POST ${T}/payments`]: PaymentBody,
  [`POST ${T}/mpesa/prompts`]: PromptBody,
  [`POST ${T}/proofs`]: ProofBody,
  [`POST ${T}/proofs/{proofId}/reject`]: ReasonBody,
  [`POST ${T}/reconciliation-runs`]: ReconBody,
  [`POST ${T}/reconciliation-findings/{findingId}/resolve`]: ResolveBody,
  [`POST ${T}/reconciliation-findings/{findingId}/assign`]: AssignBody,
  [`POST ${T}/payments/{paymentId}/withdraw-unacknowledged-prompt`]: WithdrawBody,
  [`POST ${T}/payments/{paymentId}/settlement-job/cancel`]: CancelJobBody,
  [`POST ${T}/payments/{paymentId}/mpesa-reconciliation`]: ReconcileBody,
  [`PUT ${T}/ai-helper/settings`]: AiSettingsBody,
  [`PUT ${T}/ai-helper/optins`]: OptinBody,
  [`POST ${T}/invoices/{invoiceId}/send`]: SendInvoiceBody,
  [`POST ${T}/terms/{termId}/invoices/send`]: SendTermInvoicesBody,
  [`POST ${T}/bank-reconciliation/statements`]: BankStatementImportBody,
  [`POST ${T}/bank-reconciliation/lines/{lineId}/match`]: BankLineMatchBody,
  [`POST ${T}/bank-reconciliation/lines/{lineId}/ignore`]: BankLineIgnoreBody,
} as const;

const P = "/v1/tenants/:tenantId/finance";
const READ = "resource.finance.read" as const;
const WRITE = "resource.finance.write" as const;
const ADMIN = "resource.finance.administer" as const;

const INVOICE_STATUS = ["paid", "overdue", "part_paid", "unpaid", "voided"] as const;
const PAYMENT_STATUS = ["pending", "success", "failed", "cancelled", "timeout"] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw validationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Resolve an invoice for a FAMILY payer. A missing invoice answers exactly like an unauthorized one, so a
 * caller without finance access cannot tell real invoice ids from fake ones (same rule as A9-9).
 */
async function invoiceForPayer(tx: Parameters<typeof getInvoice>[0], authz: Parameters<typeof assertMayPayFor>[1], tenantId: string, invoiceId: string) {
  const invoice = await getInvoice(tx, { tenantId, invoiceId }).catch((err: unknown) => {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  });
  await assertMayPayFor(tx, authz, invoice?.learner_id ?? "00000000-0000-0000-0000-000000000000");
  if (!invoice) throw notFound("Invoice not found");
  return invoice;
}

export async function registerFinanceRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  // ------------------------------------------------------------------ fee items
  app.post(`${P}/fee-items`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(FeeItemBody, request.body, "term_id, name, amount_minor and applies_to are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: `POST ${P}/fee-items`,
        fingerprintInput: { params, body },
        status: 201,
        execute: async () => {
          const fee_item = await createFeeItem(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body, ip });
          return { value: { fee_item }, resourceType: "fee_item", resourceId: fee_item.id };
        },
        replay: async (_t, id) => ({ fee_item: await getFeeItem(tx, { tenantId: params.tenantId, feeItemId: id }) }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get(`${P}/fee-items`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listFeeItems(tx, {
        tenantId: params.tenantId,
        termId: optionalUuid(q.termId, "termId"),
        active: optionalBool(q.active, "active"),
        page,
      });
      return { fee_items: out.items, page: out.page };
    });
  });

  app.get(`${P}/fee-items/:feeItemId`, async (request) => {
    const params = request.params as { tenantId: string; feeItemId: string };
    assertUuid(params.feeItemId, "feeItemId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      return { fee_item: await getFeeItem(tx, { tenantId: params.tenantId, feeItemId: params.feeItemId }) };
    });
  });

  app.patch(`${P}/fee-items/:feeItemId`, async (request) => {
    const params = request.params as { tenantId: string; feeItemId: string };
    assertUuid(params.feeItemId, "feeItemId");
    const body = parseOrThrow(FeeItemPatch, request.body, "at least one field is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return {
        fee_item: await updateFeeItem(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, feeItemId: params.feeItemId, ...body, ip }),
      };
    });
  });

  app.post(`${P}/fee-items/:feeItemId/archive`, async (request) => {
    const params = request.params as { tenantId: string; feeItemId: string };
    assertUuid(params.feeItemId, "feeItemId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return { fee_item: await archiveFeeItem(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, feeItemId: params.feeItemId, ip }) };
    });
  });

  // ------------------------------------------------------------------ billing and invoices
  // Naturally idempotent: a second run bills only learners not yet billed (none, if nothing changed).
  app.post(`${P}/billing-runs`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(BillingRunBody, request.body, "term_id and due_on are required");
    const result = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return billTerm(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body, ip });
    });
    return reply.status(201).send({ billing_run: result });
  });

  app.get(`${P}/invoices`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const status = oneOf(q.status, INVOICE_STATUS, "status");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listInvoices(tx, {
        tenantId: params.tenantId,
        termId: optionalUuid(q.termId, "termId"),
        learnerId: optionalUuid(q.learnerId, "learnerId"),
        status,
        page,
      });
      return { invoices: out.items, page: out.page };
    });
  });

  app.get(`${P}/invoices/:invoiceId`, async (request) => {
    const params = request.params as { tenantId: string; invoiceId: string };
    assertUuid(params.invoiceId, "invoiceId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      return getInvoiceDetail(tx, { tenantId: params.tenantId, invoiceId: params.invoiceId });
    });
  });

  app.get(`${P}/invoices/:invoiceId/pdf`, async (request, reply) => {
    const params = request.params as { tenantId: string; invoiceId: string };
    assertUuid(params.invoiceId, "invoiceId");
    const { filename, pdf } = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const canRead = await hasPermission(tx, auth.authz, READ);
      if (!canRead) await invoiceForPayer(tx, auth.authz, params.tenantId, params.invoiceId);
      return buildInvoicePdfForTenant(tx, { tenantId: params.tenantId, invoiceId: params.invoiceId });
    });
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(pdf);
  });

  app.post(`${P}/invoices/:invoiceId/send`, async (request, reply) => {
    const params = request.params as { tenantId: string; invoiceId: string };
    assertUuid(params.invoiceId, "invoiceId");

    const { prepared, userId, ip } = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip: reqIp }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip: reqIp, deferAudit: true });
      const body = parseOrThrow(SendInvoiceBody, request.body ?? {}, "Invalid invoice delivery options");
      const channels: InvoiceDeliveryChannel[] = body.channels ?? ["in_app", "push", "email", "sms"];
      const prep = await prepareInvoiceDelivery(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        invoiceId: params.invoiceId,
        channels,
        customMessage: body.custom_message ?? null,
      });
      return { prepared: prep, userId: auth.user.id, ip: reqIp };
    });

    const external_outcomes = await dispatchExternalInvoiceDelivery(prepared);

    await withSystemTenantTransaction(pool, { tenantId: params.tenantId, userId }, (tx) =>
      recordInvoiceDeliveryAudit(tx, {
        tenantId: params.tenantId,
        actorUserId: userId,
        prepared,
        outcomes: external_outcomes,
        ip,
      }),
    );

    return reply.status(200).send({
      delivery: {
        invoice_id: prepared.invoiceId,
        reference: prepared.reference,
        filename: prepared.filename,
        recipients_count: prepared.recipients.length,
        in_app_queued: prepared.inAppQueued,
        outbox_id: prepared.outboxId,
        external_outcomes,
      },
    });
  });

  app.post(`${P}/terms/:termId/invoices/send`, async (request, reply) => {
    const params = request.params as { tenantId: string; termId: string };
    assertUuid(params.termId, "termId");

    const { preparedList, userId, ip } = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip: reqIp }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip: reqIp, deferAudit: true });
      const body = parseOrThrow(SendTermInvoicesBody, request.body ?? {}, "Invalid bulk invoice delivery options");
      const channels: InvoiceDeliveryChannel[] = body.channels ?? ["in_app", "push", "email", "sms"];
      const unpaidOnly = (body.status_filter ?? "unpaid_only") === "unpaid_only";
      const invRows = await tx.query<{ id: string }>(
        `SELECT id FROM finance_invoices
          WHERE tenant_id = $1 AND term_id = $2 AND voided_at IS NULL
            ${unpaidOnly ? "AND paid_minor < total_minor" : ""}
          ORDER BY created_at, id
          LIMIT 500`,
        [params.tenantId, params.termId],
      );
      const list = [];
      for (const row of invRows.rows) {
        list.push(
          await prepareInvoiceDelivery(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            invoiceId: row.id,
            channels,
            customMessage: body.custom_message ?? null,
          }),
        );
      }
      return { preparedList: list, userId: auth.user.id, ip: reqIp };
    });

    let totalExternalSent = 0;
    let totalExternalFailed = 0;
    let totalExternalNotConfigured = 0;
    let totalInAppQueued = 0;

    for (const prepared of preparedList) {
      totalInAppQueued += prepared.inAppQueued;
      const outcomes = await dispatchExternalInvoiceDelivery(prepared);
      totalExternalSent += outcomes.filter((o) => o.status === "sent").length;
      totalExternalFailed += outcomes.filter((o) => o.status === "failed").length;
      totalExternalNotConfigured += outcomes.filter((o) => o.status === "not_configured").length;
      await withSystemTenantTransaction(pool, { tenantId: params.tenantId, userId }, (tx) =>
        recordInvoiceDeliveryAudit(tx, { tenantId: params.tenantId, actorUserId: userId, prepared, outcomes, ip }),
      );
    }

    return reply.status(200).send({
      bulk_delivery: {
        term_id: params.termId,
        invoices_processed: preparedList.length,
        in_app_queued: totalInAppQueued,
        external_sent: totalExternalSent,
        external_failed: totalExternalFailed,
        external_not_configured: totalExternalNotConfigured,
      },
    });
  });

  app.put(`${P}/invoices/:invoiceId/due-date`, async (request) => {
    const params = request.params as { tenantId: string; invoiceId: string };
    assertUuid(params.invoiceId, "invoiceId");
    const body = parseOrThrow(DueDateBody, request.body, "due_on is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return { invoice: await setDueDate(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, invoiceId: params.invoiceId, ...body, ip }) };
    });
  });

  const invoiceMutation = (
    path: string,
    schema: z.ZodType<Record<string, unknown>>,
    message: string,
    resourceType: string,
    run: (
      ctx: { tx: Parameters<typeof getInvoice>[0]; tenantId: string; actorUserId: string; params: Record<string, string>; ip: string | null },
      body: Record<string, unknown>,
    ) => Promise<unknown>,
  ) => {
    app.post(path, async (request, reply) => {
      const params = request.params as Record<string, string>;
      assertUuid(params.invoiceId!, "invoiceId");
      if (params.chargeId !== undefined) assertUuid(params.chargeId, "chargeId");
      const body = parseOrThrow(schema, request.body, message);
      const out = await inTenant(app, pool, request, params.tenantId!, async ({ tx, auth, ip }) => {
        await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
        return runIdempotent(tx, {
          key: parseIdempotencyKey(request.headers["idempotency-key"]),
          config: app.appConfig,
          routeTemplate: `POST ${path}`,
          fingerprintInput: { params, body },
          status: 200,
          execute: async () => {
            await run({ tx, tenantId: params.tenantId!, actorUserId: auth.user.id, params, ip }, body);
            return { value: { invoice: await getInvoice(tx, { tenantId: params.tenantId!, invoiceId: params.invoiceId! }) }, resourceType, resourceId: params.invoiceId! };
          },
          replay: async (_t, id) => ({ invoice: await getInvoice(tx, { tenantId: params.tenantId!, invoiceId: id }) }),
        });
      });
      if (out.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.status(out.status).send(out.value);
    });
  };

  invoiceMutation(`${P}/invoices/:invoiceId/void`, ReasonBody, "reason is required", "invoice_void", (c, b) =>
    voidInvoice(c.tx, { tenantId: c.tenantId, actorUserId: c.actorUserId, invoiceId: c.params.invoiceId!, reason: b.reason as string, ip: c.ip }),
  );
  invoiceMutation(`${P}/invoices/:invoiceId/charges`, ChargeBody, "amount_minor and reason are required", "invoice_charge", (c, b) =>
    addCharge(c.tx, {
      tenantId: c.tenantId,
      actorUserId: c.actorUserId,
      invoiceId: c.params.invoiceId!,
      amount_minor: b.amount_minor as number,
      reason: b.reason as string,
      ip: c.ip,
    }),
  );
  invoiceMutation(`${P}/invoices/:invoiceId/charges/:chargeId/void`, ReasonBody, "reason is required", "invoice_charge_void", (c, b) =>
    voidCharge(c.tx, {
      tenantId: c.tenantId,
      actorUserId: c.actorUserId,
      invoiceId: c.params.invoiceId!,
      chargeId: c.params.chargeId!,
      reason: b.reason as string,
      ip: c.ip,
    }),
  );
  invoiceMutation(
    `${P}/invoices/:invoiceId/adjustments`,
    AdjustBody,
    "expected_total_minor, new_total_minor and reason are required",
    "invoice_adjustment",
    (c, b) =>
      adjustInvoiceTotal(c.tx, {
        tenantId: c.tenantId,
        actorUserId: c.actorUserId,
        invoiceId: c.params.invoiceId!,
        expected_total_minor: b.expected_total_minor as number,
        new_total_minor: b.new_total_minor as number,
        reason: b.reason as string,
        ip: c.ip,
      }),
  );

  // ------------------------------------------------------------------ payments
  app.post(`${P}/payments`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(PaymentBody, request.body, "invoice_id, amount_minor and method are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: `POST ${P}/payments`,
        fingerprintInput: { params, body },
        status: 201,
        execute: async () => {
          const done = await recordPayment(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body, ip });
          return { value: done, resourceType: "payment", resourceId: done.payment.id };
        },
        replay: async (_t, id) => {
          const payment = await getPayment(tx, { tenantId: params.tenantId, paymentId: id });
          return { payment, invoice: await getInvoice(tx, { tenantId: params.tenantId, invoiceId: payment.invoice_id }) };
        },
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get(`${P}/payments`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const status = oneOf(q.status, PAYMENT_STATUS, "status");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listPayments(tx, { tenantId: params.tenantId, invoiceId: optionalUuid(q.invoiceId, "invoiceId"), status, hasUnapplied: optionalBool(q.unapplied, "unapplied") ?? undefined, page });
      return { payments: out.items, page: out.page };
    });
  });

  app.get(`${P}/payments/:paymentId`, async (request) => {
    const params = request.params as { tenantId: string; paymentId: string };
    assertUuid(params.paymentId, "paymentId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      return { payment: await getPayment(tx, { tenantId: params.tenantId, paymentId: params.paymentId }) };
    });
  });

  // ------------------------------------------------------------------ M-Pesa prompt (family payer)
  // Duplicate protection: one pending prompt per invoice; the same phone and amount within 2 minutes returns
  // the existing prompt (legacy). The provider is called BETWEEN transactions, never inside one.
  app.post(`${P}/mpesa/prompts`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(PromptBody, request.body, "invoice_id, amount_minor and msisdn are required");
    const provider = app.mpesaProvider;
    const started = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await invoiceForPayer(tx, auth.authz, params.tenantId, body.invoice_id);
      if (!provider.configured) throw serviceUnavailable("M-Pesa payments are not available right now");
      const prompt = await createPrompt(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        ...body,
        settleDelaySeconds: app.appConfig.mpesaSettleDelaySeconds,
        ip,
      });
      return { ...prompt, userId: auth.user.id };
    });
    if (started.reused) return reply.status(200).send({ payment: started.payment, reused: true });
    let pushResult: Awaited<ReturnType<typeof provider.stkPush>> | { error: true };
    try {
      pushResult = await provider.stkPush({
        amountMinor: started.payment.amount_minor,
        msisdn: body.msisdn,
        accountReference: `FIG-${started.payment.invoice_id.slice(0, 8)}`,
        description: "School fees",
        callbackUrl: callbackUrlWithToken(app.appConfig),
      });
    } catch {
      pushResult = { error: true };
    }
    const payment = await withSystemTenantTransaction(pool, { tenantId: params.tenantId, userId: started.userId }, (tx) =>
      recordPushOutcome(tx, { tenantId: params.tenantId, paymentId: started.payment.id, result: pushResult, actorUserId: started.userId }),
    );
    if (payment.status === "failed") return reply.status(502).send({ payment, reused: false });
    return reply.status(201).send({ payment, reused: false });
  });

  // ------------------------------------------------------------------ proofs
  // The office (finance administer) records a proof for a family (legacy insert-by-office); a family
  // member submits through the payer link (assertMayPayFor: a live account link to the invoice's learner), and a learner
  // with a login for their own invoice (submitted_via 'learner', docs/STUDENT-ACCOUNTS.md).
  app.post(`${P}/proofs`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(ProofBody, request.body, "invoice_id and a message or file are required");
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      const office = await hasPermission(tx, auth.authz, ADMIN);
      if (!office) await invoiceForPayer(tx, auth.authz, params.tenantId, body.invoice_id);
      return runIdempotent(tx, {
        key: parseIdempotencyKey(request.headers["idempotency-key"]),
        config: app.appConfig,
        routeTemplate: `POST ${P}/proofs`,
        fingerprintInput: { params, body },
        status: 201,
        execute: async () => {
          const proof = await submitProof(tx, {
            tenantId: params.tenantId,
            actorUserId: auth.user.id,
            via: office ? "office" : auth.authz.membership?.role === "student" ? "learner" : "guardian",
            ...body,
            ip,
          });
          return { value: { proof }, resourceType: "payment_proof", resourceId: proof.id };
        },
        replay: async (_t, id) => ({ proof: await getProof(tx, { tenantId: params.tenantId, proofId: id }) }),
      });
    });
    if (out.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(out.status).send(out.value);
  });

  app.get(`${P}/proofs`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const status = oneOf(q.status, ["pending", "confirmed", "rejected"] as const, "status");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listProofs(tx, { tenantId: params.tenantId, invoiceId: optionalUuid(q.invoiceId, "invoiceId"), status, page });
      return { proofs: out.items, page: out.page };
    });
  });

  app.get(`${P}/proofs/:proofId`, async (request) => {
    const params = request.params as { tenantId: string; proofId: string };
    assertUuid(params.proofId, "proofId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      return { proof: await getProof(tx, { tenantId: params.tenantId, proofId: params.proofId }) };
    });
  });

  app.post(`${P}/proofs/:proofId/reject`, async (request) => {
    const params = request.params as { tenantId: string; proofId: string };
    assertUuid(params.proofId, "proofId");
    const body = parseOrThrow(ReasonBody, request.body, "reason is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      return { proof: await rejectProof(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, proofId: params.proofId, reason: body.reason, ip }) };
    });
  });

  // ------------------------------------------------------------------ reconciliation
  app.post(`${P}/reconciliation-runs`, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(ReconBody, request.body ?? {}, "invalid reconciliation request");
    const result = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      return runReconciliation(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, stale_after_minutes: body.stale_after_minutes ?? 30, ip });
    });
    return reply.status(201).send(result);
  });

  app.get(`${P}/reconciliation-runs`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listRuns(tx, { tenantId: params.tenantId, page });
      return { runs: out.items, page: out.page };
    });
  });

  app.get(`${P}/reconciliation-findings`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const page = pageFrom(request);
    const status = oneOf(q.status, ["open", "resolved"] as const, "status");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listFindings(tx, { tenantId: params.tenantId, runId: optionalUuid(q.runId, "runId"), status, page });
      return { findings: out.items, page: out.page };
    });
  });

  app.post(`${P}/reconciliation-findings/:findingId/resolve`, async (request) => {
    const params = request.params as { tenantId: string; findingId: string };
    assertUuid(params.findingId, "findingId");
    const body = parseOrThrow(ResolveBody, request.body, "note is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      // Resolving permanently suppresses re-raising of financial alarms; Fees-area write is not enough.
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      return { finding: await resolveFinding(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, findingId: params.findingId, note: body.note, evidence: body.evidence ?? null, ip }) };
    });
  });

  // Case ownership (acceptance 6.3): who is responsible for an open reconciliation case.
  app.post(`${P}/reconciliation-findings/:findingId/assign`, async (request) => {
    const params = request.params as { tenantId: string; findingId: string };
    assertUuid(params.findingId, "findingId");
    const body = parseOrThrow(AssignBody, request.body, "owner_user_id is required (or null)");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      return { finding: await assignFinding(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, findingId: params.findingId, ownerUserId: body.owner_user_id, ip }) };
    });
  });

  // Recovery for a prompt the provider never acknowledged (no checkout id): attested, evidenced, audited (FIN-1).
  app.post(`${P}/payments/:paymentId/withdraw-unacknowledged-prompt`, async (request) => {
    const params = request.params as { tenantId: string; paymentId: string };
    assertUuid(params.paymentId, "paymentId");
    const body = parseOrThrow(WithdrawBody, request.body, "reason and evidence are required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      return { result: await withdrawUnacknowledgedPrompt(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, paymentId: params.paymentId, reason: body.reason, evidence: body.evidence, ip }) };
    });
  });

  // The provider evidence ledger of one M-Pesa payment (what an operator inspects before reconciling).
  app.get(`${P}/payments/:paymentId/mpesa-events`, async (request) => {
    const params = request.params as { tenantId: string; paymentId: string };
    assertUuid(params.paymentId, "paymentId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      // operator notes are free text: only a finance administrator sees them
      const includeNotes = await hasPermission(tx, auth.authz, ADMIN);
      return listMpesaEvents(tx, { tenantId: params.tenantId, paymentId: params.paymentId, includeNotes });
    });
  });

  // Operator reconciliation of a pending M-Pesa prompt (finance administrator). The provider is asked BETWEEN
  // transactions; the decision is made by the system from evidence, never by the operator alone (see mpesaReconcile.ts).
  app.post(`${P}/payments/:paymentId/mpesa-reconciliation`, async (request) => {
    const params = request.params as { tenantId: string; paymentId: string };
    assertUuid(params.paymentId, "paymentId");
    const body = parseOrThrow(ReconcileBody, request.body, "action and a note of 10–500 characters are required");
    const started = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      await assertRecentAuth(tx, app.appConfig, auth.session.id);
      const found = await tx.query<{ checkout_request_id: string | null; status: string }>(
        `SELECT checkout_request_id, status FROM finance_payments WHERE tenant_id = $1 AND id = $2 AND method = 'mpesa'`,
        [params.tenantId, params.paymentId],
      );
      if (!found.rows[0]) throw notFound("Payment not found");
      return { userId: auth.user.id, ip, checkout: found.rows[0].checkout_request_id, status: found.rows[0].status };
    });
    let provider: ProviderView = { kind: "unavailable" };
    if (started.status === "pending" && started.checkout && app.mpesaProvider.configured) {
      try {
        provider = { kind: "query", result: await app.mpesaProvider.stkQuery(started.checkout) };
      } catch {
        provider = { kind: "unavailable" }; // an unreachable provider is not evidence of anything
      }
    }
    // The session and the administer permission are checked AGAIN after the provider call (a permission revoked while the
    // provider was being asked is honoured). The settlement itself then runs in a system tenant transaction because the
    // duplicate-receipt guard needs a savepoint, which user-session transactions refuse; the tenant and the acting user are
    // the values that were just re-authorised. M-9: the authority is verified ONCE MORE inside the settlement transaction itself
    // (finance_assert_administer_actor, row-locked), so no check-to-use window remains between authorization and the mutation.
    // Everything the operator can do is additionally bounded by the evidence rules in mpesaReconcile.ts.
    const actor = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      return { userId: auth.user.id, ip };
    });
    return withSystemTenantTransaction(pool, { tenantId: params.tenantId, userId: actor.userId }, async (tx) => {
      // M-9: the authority is re-checked INSIDE this transaction, with row locks on the actor's account, membership and the
      // school, so a revocation either committed before (refused here) or waits until the settlement commits.
      await tx.query(`SELECT public.finance_assert_administer_actor($1::uuid)`, [params.tenantId]);
      return operatorReconcile(tx, {
        tenantId: params.tenantId,
        actorUserId: actor.userId,
        paymentId: params.paymentId,
        action: body.action,
        receipt: body.receipt ?? null,
        note: body.note,
        provider,
        ip: actor.ip,
      });
    });
  });

  // Operator cancellation of a queued settlement job. The job is a system obligation, so this is an explicit,
  // reasoned, audited administrator act; the database refuses it while the payment is still pending.
  app.post(`${P}/payments/:paymentId/settlement-job/cancel`, async (request) => {
    const params = request.params as { tenantId: string; paymentId: string };
    assertUuid(params.paymentId, "paymentId");
    const body = parseOrThrow(CancelJobBody, request.body, "reason of 10–300 characters is required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      return cancelSettlementJob(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, paymentId: params.paymentId, reason: body.reason, ip });
    });
  });

  // ------------------------------------------------------------------ AI helper billing foundations
  app.get(`${P}/ai-helper/settings`, async (request) => {
    const params = request.params as { tenantId: string };
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      return { settings: await getAiHelperSettings(tx, { tenantId: params.tenantId }) };
    });
  });

  app.put(`${P}/ai-helper/settings`, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(AiSettingsBody, request.body, "access_mode, price_minor and cancel_days are required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, ADMIN, { ip, deferAudit: true });
      return { settings: await putAiHelperSettings(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body, ip }) };
    });
  });

  app.get(`${P}/ai-helper/optins`, async (request) => {
    const params = request.params as { tenantId: string };
    const q = request.query as Record<string, unknown>;
    const termId = optionalUuid(q.termId, "termId");
    if (!termId) throw validationError("termId is required");
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listAiHelperOptins(tx, { tenantId: params.tenantId, termId, page });
      return { optins: out.items, page: out.page };
    });
  });

  app.put(`${P}/ai-helper/optins`, async (request) => {
    const params = request.params as { tenantId: string };
    const body = parseOrThrow(OptinBody, request.body, "learner_id, term_id and opted_in are required");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth }) => {
      await assertMayPayFor(tx, auth.authz, body.learner_id);
      return { optin: await setAiHelperOptin(tx, { tenantId: params.tenantId, actorUserId: auth.user.id, ...body }) };
    });
  });

  // ------------------------------------------------------------------ bank statement reconciliation
  app.post(`${P}/bank-reconciliation/statements`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const params = request.params as { tenantId: string };
    const out = await inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      const body = parseOrThrow(BankStatementImportBody, request.body, "bank_name, account_number and csv_text or lines are required");
      return importBankStatement(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        ...body,
        ip,
      });
    });
    return reply.status(201).send(out);
  });

  app.get(`${P}/bank-reconciliation/statements`, async (request) => {
    const params = request.params as { tenantId: string };
    const page = pageFrom(request);
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const out = await listBankStatements(tx, { tenantId: params.tenantId, page });
      return { statements: out.items, page: out.page };
    });
  });

  app.get(`${P}/bank-reconciliation/statements/:statementId`, async (request) => {
    const params = request.params as { tenantId: string; statementId: string };
    assertUuid(params.statementId, "statementId");
    const q = request.query as Record<string, unknown>;
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, READ, { ip, deferAudit: true });
      const matchStatus = oneOf(q.status, ["unmatched", "auto_matched", "manual_matched", "ignored"] as const, "status");
      return getBankStatementDetail(tx, { tenantId: params.tenantId, statementId: params.statementId, matchStatus });
    });
  });

  app.post(`${P}/bank-reconciliation/lines/:lineId/match`, async (request) => {
    const params = request.params as { tenantId: string; lineId: string };
    assertUuid(params.lineId, "lineId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      const body = parseOrThrow(BankLineMatchBody, request.body, "payment_id or invoice_id is required");
      return matchBankStatementLine(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        lineId: params.lineId,
        ...body,
        ip,
      });
    });
  });

  app.post(`${P}/bank-reconciliation/lines/:lineId/ignore`, async (request) => {
    const params = request.params as { tenantId: string; lineId: string };
    assertUuid(params.lineId, "lineId");
    return inTenant(app, pool, request, params.tenantId, async ({ tx, auth, ip }) => {
      await requirePermission(tx, auth.authz, WRITE, { ip, deferAudit: true });
      const body = parseOrThrow(BankLineIgnoreBody, request.body, "note of 3–300 characters is required");
      return ignoreBankStatementLine(tx, {
        tenantId: params.tenantId,
        actorUserId: auth.user.id,
        lineId: params.lineId,
        note: body.note,
        ip,
      });
    });
  });
}
