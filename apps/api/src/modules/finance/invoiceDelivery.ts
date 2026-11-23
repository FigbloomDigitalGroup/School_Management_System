import type { Tx } from "../../db/sql.js";
import { conflict } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { enqueueNotificationEvent, type NotificationChannel } from "../notifications/service.js";
import { buildInvoicePdfForTenant, formatKesMinor, invoiceReference, type InvoicePdfData } from "./invoicePdf.js";

export type InvoiceDeliveryChannel = "in_app" | "push" | "email" | "sms" | "whatsapp";

export interface GuardianRecipient {
  guardianId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  userId: string | null;
  isPrimaryPayer: boolean;
}

export interface ChannelDispatchOutcome {
  channel: "email" | "sms" | "whatsapp";
  guardianId: string;
  target: string;
  status: "sent" | "failed" | "not_configured";
  provider: string;
  messageId?: string | null;
  error?: string | null;
}

export interface EmailSendRequest {
  to: string;
  subject: string;
  text: string;
  attachment?: { filename: string; contentBase64: string; contentType: string };
}

export interface SmsSendRequest {
  to: string;
  message: string;
}

export interface WhatsAppSendRequest {
  to: string;
  message: string;
}

export interface InvoiceDispatchProviders {
  sendEmail(req: EmailSendRequest): Promise<{ status: "sent" | "failed" | "not_configured"; provider: string; messageId?: string | null; error?: string | null }>;
  sendSms(req: SmsSendRequest): Promise<{ status: "sent" | "failed" | "not_configured"; provider: string; messageId?: string | null; error?: string | null }>;
  sendWhatsApp(req: WhatsAppSendRequest): Promise<{ status: "sent" | "failed" | "not_configured"; provider: string; messageId?: string | null; error?: string | null }>;
}

/**
 * Env-backed multi-channel dispatcher (Resend for email, Africa's Talking for SMS,
 * Webhook/Meta Cloud API for WhatsApp). Honest `not_configured` when credentials are absent.
 */
export function invoiceDispatchProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): InvoiceDispatchProviders {
  const resendKey = env.RESEND_API_KEY?.trim();
  const emailFrom = env.EMAIL_FROM?.trim() || "billing@figbloom.co.ke";
  const smsKey = env.SMS_API_KEY?.trim();
  const smsUsername = env.SMS_USERNAME?.trim();
  const smsSenderId = env.SMS_SENDER_ID?.trim();
  const smsEndpoint = env.SMS_ENDPOINT_URL?.trim() || "https://api.africastalking.com/version1/messaging";
  const waWebhookUrl = env.WHATSAPP_WEBHOOK_URL?.trim();
  const waApiToken = env.WHATSAPP_API_TOKEN?.trim();

  return {
    async sendEmail(req) {
      if (!resendKey) return { status: "not_configured", provider: "not_configured" };
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: emailFrom,
            to: [req.to],
            subject: req.subject,
            text: req.text,
            ...(req.attachment
              ? { attachments: [{ filename: req.attachment.filename, content: req.attachment.contentBase64 }] }
              : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (res.ok) return { status: "sent", provider: "resend", messageId: body.id ?? null };
        return { status: "failed", provider: "resend", error: body.message ?? `HTTP_${res.status}` };
      } catch {
        return { status: "failed", provider: "resend", error: "network_error" };
      }
    },

    async sendSms(req) {
      if (!smsKey || !smsUsername) return { status: "not_configured", provider: "not_configured" };
      try {
        const form = new URLSearchParams({
          username: smsUsername,
          to: req.to,
          message: req.message,
          ...(smsSenderId ? { from: smsSenderId } : {}),
        });
        const res = await fetch(smsEndpoint, {
          method: "POST",
          headers: {
            apiKey: smsKey,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          SMSMessageData?: { Recipients?: Array<{ messageId?: string; status?: string }> };
        };
        const first = body.SMSMessageData?.Recipients?.[0];
        if (res.ok && (!first || first.status === "Success")) {
          return { status: "sent", provider: "africastalking", messageId: first?.messageId ?? null };
        }
        return { status: "failed", provider: "africastalking", error: first?.status ?? `HTTP_${res.status}` };
      } catch {
        return { status: "failed", provider: "africastalking", error: "network_error" };
      }
    },

    async sendWhatsApp(req) {
      if (!waWebhookUrl) return { status: "not_configured", provider: "not_configured" };
      try {
        const res = await fetch(waWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(waApiToken ? { Authorization: `Bearer ${waApiToken}` } : {}),
          },
          body: JSON.stringify({ to: req.to, text: req.message }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message_id?: string };
        if (res.ok) return { status: "sent", provider: "whatsapp_webhook", messageId: body.id ?? body.message_id ?? null };
        return { status: "failed", provider: "whatsapp_webhook", error: `HTTP_${res.status}` };
      } catch {
        return { status: "failed", provider: "whatsapp_webhook", error: "network_error" };
      }
    },
  };
}

let testOverrideProviders: InvoiceDispatchProviders | null = null;
export function setInvoiceDispatchProvidersForTesting(p: InvoiceDispatchProviders | null): void {
  testOverrideProviders = p;
}
export function getInvoiceDispatchProviders(): InvoiceDispatchProviders {
  return testOverrideProviders ?? invoiceDispatchProvidersFromEnv();
}

export interface PreparedInvoiceDelivery {
  invoiceId: string;
  reference: string;
  filename: string;
  pdfBase64: string;
  subject: string;
  summaryText: string;
  smsText: string;
  recipients: GuardianRecipient[];
  inAppQueued: number;
  outboxId: string | null;
  channels: InvoiceDeliveryChannel[];
}

export function buildInvoiceMessages(data: InvoicePdfData, customMessage?: string | null): { subject: string; summaryText: string; smsText: string } {
  const inv = data.detail.invoice;
  const ref = invoiceReference(inv.id);
  const total = formatKesMinor(inv.total_minor, inv.currency);
  const balance = formatKesMinor(inv.balance_minor, inv.currency);
  const subject = `${data.schoolName}: Fee Invoice ${ref} (${data.termName}) - ${data.learnerName}`;
  const noteLine = customMessage?.trim() ? `\nNote from school: ${customMessage.trim()}\n` : "";
  const summaryText = [
    `Dear Parent/Guardian,`,
    ``,
    `Please find attached the fee invoice for ${data.learnerName} (Adm: ${data.admissionNo}) for ${data.termName}.`,
    `Invoice Ref: ${ref}`,
    `Total Billed: ${total}`,
    `Balance Due: ${balance}`,
    `Due Date: ${inv.due_on}`,
    noteLine,
    `Use reference ${ref} when making payment via M-Pesa / PayHero or bank transfer.`,
    ``,
    `Regards,`,
    data.schoolName,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const smsText = `${data.schoolName}: Fee invoice ${ref} for ${data.learnerName} (${data.termName}). Balance: ${balance}, due ${inv.due_on}. Ref: ${ref}.`;
  return { subject, summaryText, smsText };
}

/**
 * Step 1 (inside tenant DB transaction): validates invoice, builds PDF, resolves linked guardians
 * (and any linked user accounts), and enqueues in-app/push notifications via the central outbox.
 */
export async function prepareInvoiceDelivery(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    invoiceId: string;
    channels: InvoiceDeliveryChannel[];
    customMessage?: string | null;
  },
): Promise<PreparedInvoiceDelivery> {
  const { filename, pdf, data } = await buildInvoicePdfForTenant(tx, {
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
  });
  if (data.detail.invoice.voided_at) {
    throw conflict("Cannot send a voided invoice");
  }

  const gRows = await tx.query<{
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    is_primary_payer: boolean;
    user_id: string | null;
  }>(
    `SELECT g.id, g.full_name, g.email, g.phone, gl.is_primary_payer,
            (SELECT ga.user_id FROM guardian_accounts ga
              WHERE ga.tenant_id = g.tenant_id AND ga.guardian_id = g.id AND ga.revoked_at IS NULL
              LIMIT 1) AS user_id
       FROM guardian_links gl
       JOIN guardians g ON g.tenant_id = gl.tenant_id AND g.id = gl.guardian_id
      WHERE gl.tenant_id = $1 AND gl.learner_id = $2 AND gl.archived_at IS NULL AND g.active
      ORDER BY gl.is_primary_payer DESC, g.full_name`,
    [input.tenantId, data.detail.invoice.learner_id],
  );

  const recipients: GuardianRecipient[] = gRows.rows.map((r) => ({
    guardianId: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    userId: r.user_id,
    isPrimaryPayer: r.is_primary_payer,
  }));

  const ref = invoiceReference(input.invoiceId);
  const { subject, summaryText, smsText } = buildInvoiceMessages(data, input.customMessage);

  // Enqueue in-app / push notifications inside the transaction for guardians who have linked accounts.
  const notifChannels: NotificationChannel[] = [];
  if (input.channels.includes("in_app")) notifChannels.push("in_app");
  if (input.channels.includes("push")) notifChannels.push("push");

  const accountUserIds = recipients.map((r) => r.userId).filter((u): u is string => Boolean(u));
  let outboxId: string | null = null;
  let inAppQueued = 0;

  if (notifChannels.length > 0 && accountUserIds.length > 0) {
    const outbox = await enqueueNotificationEvent(tx, {
      tenantId: input.tenantId,
      eventType: "finance.invoice.sent",
      category: "finance",
      idempotencyKey: `invoice-send:${input.invoiceId}:${Date.now()}`,
      recipientUserIds: accountUserIds,
      title: `Fee Invoice ${ref} - ${data.learnerName}`,
      body: smsText,
      channels: notifChannels,
      metadata: {
        invoice_id: input.invoiceId,
        learner_id: data.detail.invoice.learner_id,
        reference: ref,
        balance_minor: data.detail.invoice.balance_minor,
        due_on: data.detail.invoice.due_on,
      },
      createdBy: input.actorUserId,
    });
    outboxId = outbox.outboxId;
    inAppQueued = accountUserIds.length;
  }

  return {
    invoiceId: input.invoiceId,
    reference: ref,
    filename,
    pdfBase64: pdf.toString("base64"),
    subject,
    summaryText,
    smsText,
    recipients,
    inAppQueued,
    outboxId,
    channels: input.channels,
  };
}

/**
 * Step 2 (OUTSIDE any DB transaction): dispatches external email (with PDF attachment),
 * SMS, and WhatsApp messages to each guardian with matching contact info.
 */
export async function dispatchExternalInvoiceDelivery(
  prepared: PreparedInvoiceDelivery,
  providers: InvoiceDispatchProviders = getInvoiceDispatchProviders(),
): Promise<ChannelDispatchOutcome[]> {
  const outcomes: ChannelDispatchOutcome[] = [];

  for (const r of prepared.recipients) {
    if (prepared.channels.includes("email") && r.email) {
      const res = await providers.sendEmail({
        to: r.email,
        subject: prepared.subject,
        text: prepared.summaryText,
        attachment: {
          filename: prepared.filename,
          contentBase64: prepared.pdfBase64,
          contentType: "application/pdf",
        },
      });
      outcomes.push({ channel: "email", guardianId: r.guardianId, target: r.email, ...res });
    }

    if (prepared.channels.includes("sms") && r.phone) {
      const res = await providers.sendSms({ to: r.phone, message: prepared.smsText });
      outcomes.push({ channel: "sms", guardianId: r.guardianId, target: r.phone, ...res });
    }

    if (prepared.channels.includes("whatsapp") && r.phone) {
      const res = await providers.sendWhatsApp({ to: r.phone, message: prepared.summaryText });
      outcomes.push({ channel: "whatsapp", guardianId: r.guardianId, target: r.phone, ...res });
    }
  }

  return outcomes;
}

export async function recordInvoiceDeliveryAudit(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    prepared: PreparedInvoiceDelivery;
    outcomes: ChannelDispatchOutcome[];
    ip?: string | null;
  },
): Promise<void> {
  await recordSecurityEvent(tx, {
    eventType: "finance.invoice.sent",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      invoiceId: input.prepared.invoiceId,
      reference: input.prepared.reference,
      channels: input.prepared.channels,
      recipientCount: input.prepared.recipients.length,
      inAppQueued: input.prepared.inAppQueued,
      externalSent: input.outcomes.filter((o) => o.status === "sent").length,
      externalFailed: input.outcomes.filter((o) => o.status === "failed").length,
      externalNotConfigured: input.outcomes.filter((o) => o.status === "not_configured").length,
    },
    ip: input.ip,
  });
}
