import type { Tx } from "../../db/sql.js";
import { notFound } from "../../http/errors.js";
import { renderSimplePdf } from "../reporting/exportFormat.js";
import { getInvoiceDetail, type InvoiceDetail } from "./invoices.js";

export interface InvoicePdfData {
  schoolName: string;
  schoolCounty: string | null;
  schoolMoeReg: string | null;
  schoolEmail: string | null;
  schoolPhone: string | null;
  termName: string;
  learnerName: string;
  admissionNo: string;
  boarding: boolean;
  guardianNames: string[];
  detail: InvoiceDetail;
}

export function formatKesMinor(amountMinor: number, currency = "KES"): string {
  const whole = (amountMinor / 100).toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${whole}`;
}

export function invoiceReference(invoiceId: string): string {
  return `FIG-${invoiceId.slice(0, 8).toUpperCase()}`;
}

/**
 * Pure PDF renderer for a school fee invoice. Produces a spec-compliant PDF 1.4 buffer
 * with zero external binary dependencies.
 */
export function renderInvoicePdf(data: InvoicePdfData): { filename: string; pdf: Buffer } {
  const { detail } = data;
  const inv = detail.invoice;
  const ref = invoiceReference(inv.id);
  const safeAdm = data.admissionNo.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "learner";
  const filename = `invoice-${safeAdm}-${ref.toLowerCase()}.pdf`;

  const lines: string[] = [];
  if (data.schoolCounty || data.schoolMoeReg) {
    lines.push([data.schoolCounty, data.schoolMoeReg ? `MOE: ${data.schoolMoeReg}` : null].filter(Boolean).join(" | "));
  }
  if (data.schoolPhone || data.schoolEmail) {
    lines.push([data.schoolPhone, data.schoolEmail].filter(Boolean).join(" | "));
  }
  lines.push("----------------------------------------------------------------");
  lines.push(`FEE INVOICE  #${ref}   Status: ${inv.status.toUpperCase()}`);
  lines.push(`Term: ${data.termName}   Due Date: ${inv.due_on}`);
  lines.push(`Learner: ${data.learnerName} (Adm: ${data.admissionNo}) [${data.boarding ? "Boarder" : "Day"}]`);
  if (data.guardianNames.length > 0) {
    lines.push(`Parent/Guardian: ${data.guardianNames.join(", ")}`);
  }
  lines.push("----------------------------------------------------------------");
  lines.push("FEE BREAKDOWN");

  for (const line of detail.lines) {
    lines.push(`  - ${line.name}: ${formatKesMinor(line.amount_minor, inv.currency)}`);
  }
  for (const charge of detail.charges) {
    if (charge.voided_at) continue;
    lines.push(`  + Charge (${charge.reason}): ${formatKesMinor(charge.amount_minor, inv.currency)}`);
  }
  for (const adj of detail.adjustments) {
    const sign = adj.delta_minor >= 0 ? "+" : "-";
    lines.push(`  * Adjustment (${adj.reason}): ${sign}${formatKesMinor(Math.abs(adj.delta_minor), inv.currency)}`);
  }

  lines.push("----------------------------------------------------------------");
  lines.push(`Total Billed:    ${formatKesMinor(inv.total_minor, inv.currency)}`);
  lines.push(`Amount Paid:     ${formatKesMinor(inv.paid_minor, inv.currency)}`);
  lines.push(`Balance Due:     ${formatKesMinor(inv.balance_minor, inv.currency)}`);
  if (inv.unapplied_minor > 0) {
    lines.push(`Unapplied Credit: ${formatKesMinor(inv.unapplied_minor, inv.currency)}`);
  }
  lines.push("----------------------------------------------------------------");
  lines.push(`Payment Reference: ${ref} (use when paying via M-Pesa / PayHero / Bank)`);

  const pdf = renderSimplePdf(`${data.schoolName} - Fee Invoice`, lines);
  return { filename, pdf };
}

/**
 * Loads all tenant-scoped invoice, learner, term, school, and guardian context
 * required to render a downloadable or emailable PDF invoice.
 */
export async function buildInvoicePdfForTenant(
  tx: Tx,
  input: { tenantId: string; invoiceId: string },
): Promise<{ filename: string; pdf: Buffer; data: InvoicePdfData }> {
  const detail = await getInvoiceDetail(tx, input);

  const [schoolRes, termRes, learnerRes, guardianRes] = await Promise.all([
    tx.query<{ name: string; county: string | null; moe_registration: string | null; contact_email: string | null; contact_phone: string | null }>(
      `SELECT t.name, p.county, p.moe_registration, p.contact_email, p.contact_phone
         FROM tenants t
         LEFT JOIN school_profiles p ON p.tenant_id = t.id
        WHERE t.id = $1`,
      [input.tenantId],
    ),
    tx.query<{ label: string }>(`SELECT label FROM academic_terms WHERE tenant_id = $1 AND id = $2`, [input.tenantId, detail.invoice.term_id]),
    tx.query<{ full_name: string; admission_no: string; boarding: boolean }>(
      `SELECT full_name, admission_no, boarding FROM learners WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, detail.invoice.learner_id],
    ),
    tx.query<{ full_name: string }>(
      `SELECT g.full_name
         FROM guardian_links gl
         JOIN guardians g ON g.tenant_id = gl.tenant_id AND g.id = gl.guardian_id
        WHERE gl.tenant_id = $1 AND gl.learner_id = $2 AND gl.archived_at IS NULL AND g.active
        ORDER BY gl.is_primary_payer DESC, g.full_name`,
      [input.tenantId, detail.invoice.learner_id],
    ),
  ]);

  const school = schoolRes.rows[0];
  const learner = learnerRes.rows[0];
  if (!school || !learner) throw notFound("Invoice context not found");

  const data: InvoicePdfData = {
    schoolName: school.name,
    schoolCounty: school.county,
    schoolMoeReg: school.moe_registration,
    schoolEmail: school.contact_email,
    schoolPhone: school.contact_phone,
    termName: termRes.rows[0]?.label ?? "Current Term",
    learnerName: learner.full_name,
    admissionNo: learner.admission_no,
    boarding: learner.boarding,
    guardianNames: guardianRes.rows.map((r) => r.full_name),
    detail,
  };

  const { filename, pdf } = renderInvoicePdf(data);
  return { filename, pdf, data };
}
