import { describe, expect, it } from "vitest";
import { buildInvoiceMessages, dispatchExternalInvoiceDelivery, type InvoiceDispatchProviders, type PreparedInvoiceDelivery } from "../src/modules/finance/invoiceDelivery.js";
import { formatKesMinor, invoiceReference, renderInvoicePdf, type InvoicePdfData } from "../src/modules/finance/invoicePdf.js";

function samplePdfData(): InvoicePdfData {
  return {
    schoolName: "FigBloom Academy",
    schoolCounty: "Nairobi",
    schoolMoeReg: "MOE-12345",
    schoolEmail: "accounts@figbloom.ac.ke",
    schoolPhone: "+254700000000",
    termName: "Term 1 2026",
    learnerName: "Amina Otieno",
    admissionNo: "ADM-0042",
    boarding: true,
    guardianNames: ["Grace Otieno"],
    detail: {
      invoice: {
        id: "12345678-1111-2222-3333-444455556666",
        tenantId: "99999999-1111-2222-3333-444455556666",
        learner_id: "aaaaaaaa-1111-2222-3333-444455556666",
        term_id: "bbbbbbbb-1111-2222-3333-444455556666",
        currency: "KES",
        due_on: "2026-02-15",
        lines_minor: 4_500_000,
        charges_minor: 200_000,
        adjustments_minor: -100_000,
        total_minor: 4_600_000,
        paid_minor: 1_600_000,
        balance_minor: 3_000_000,
        overpaid_minor: 0,
        unapplied_minor: 0,
        status: "part_paid",
        billing_run_id: null,
        created_at: "2026-01-10T08:00:00.000Z",
        voided_at: null,
        void_reason: null,
      },
      lines: [
        { id: "l1", fee_item_id: "f1", name: "Tuition", amount_minor: 3_000_000 },
        { id: "l2", fee_item_id: "f2", name: "Boarding", amount_minor: 1_500_000 },
      ],
      charges: [
        {
          id: "c1",
          inventory_issue_id: null,
          amount_minor: 200_000,
          reason: "Lab breakage",
          created_by: "u1",
          created_at: "2026-01-12T08:00:00.000Z",
          voided_at: null,
          void_reason: null,
        },
      ],
      adjustments: [
        {
          id: "a1",
          from_total_minor: 4_700_000,
          to_total_minor: 4_600_000,
          delta_minor: -100_000,
          reason: "Sibling correction",
          created_by: "u1",
          created_at: "2026-01-13T08:00:00.000Z",
        },
      ],
    },
  };
}

describe("Invoice PDF & Parent Delivery", () => {
  it("renders a valid PDF-1.4 invoice buffer with fee breakdown and payment reference", () => {
    const data = samplePdfData();
    const { filename, pdf } = renderInvoicePdf(data);
    expect(filename).toBe("invoice-ADM-0042-fig-12345678.pdf");
    const text = pdf.toString("utf8");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("FigBloom Academy - Fee Invoice");
    expect(text).toContain("FIG-12345678");
    expect(text).toContain("Amina Otieno");
    expect(text).toContain("Tuition");
    expect(text).toContain("Lab breakage");
    expect(text).toContain("Balance Due:");
    expect(invoiceReference(data.detail.invoice.id)).toBe("FIG-12345678");
    expect(formatKesMinor(3_000_000)).toContain("30,000.00");
  });

  it("builds clear email and SMS messages and dispatches across email, sms, and whatsapp", async () => {
    const data = samplePdfData();
    const msgs = buildInvoiceMessages(data, "Please clear before mid-term.");
    expect(msgs.subject).toContain("FIG-12345678");
    expect(msgs.summaryText).toContain("Please clear before mid-term.");
    expect(msgs.smsText).toContain("Amina Otieno");

    const calls: string[] = [];
    const mockProviders: InvoiceDispatchProviders = {
      async sendEmail(req) {
        calls.push(`email:${req.to}:${req.attachment?.filename}`);
        return { status: "sent", provider: "mock_email", messageId: "em-1" };
      },
      async sendSms(req) {
        calls.push(`sms:${req.to}`);
        return { status: "sent", provider: "mock_sms", messageId: "sm-1" };
      },
      async sendWhatsApp(req) {
        calls.push(`whatsapp:${req.to}`);
        return { status: "sent", provider: "mock_wa", messageId: "wa-1" };
      },
    };

    const prepared: PreparedInvoiceDelivery = {
      invoiceId: data.detail.invoice.id,
      reference: "FIG-12345678",
      filename: "invoice-ADM-0042-fig-12345678.pdf",
      pdfBase64: Buffer.from("pdf").toString("base64"),
      ...msgs,
      recipients: [
        {
          guardianId: "g1",
          fullName: "Grace Otieno",
          email: "grace@example.com",
          phone: "+254712345678",
          userId: null,
          isPrimaryPayer: true,
        },
      ],
      inAppQueued: 0,
      outboxId: null,
      channels: ["email", "sms", "whatsapp"],
    };

    const outcomes = await dispatchExternalInvoiceDelivery(prepared, mockProviders);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.status === "sent")).toBe(true);
    expect(calls).toEqual([
      "email:grace@example.com:invoice-ADM-0042-fig-12345678.pdf",
      "sms:+254712345678",
      "whatsapp:+254712345678",
    ]);
  });
});
