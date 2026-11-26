import { useState, type FormEvent } from "react";
import {
  apiCreatePlatformInvoice,
  apiFetchPlatformInvoices,
  apiFetchPlatformSchools,
  apiMarkPlatformInvoicePaid,
  formatMoney,
  formatShortDate,
  userMessage,
  type PlatformSchoolItem,
} from "@figbloom/shared";
import { Modal } from "../../components/ui/Modal";
import { SelectField, TextField } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { Badge, Button, Cell, Mono, RecordsPage, type RecordsSpec } from "./RecordsPage";

function todayInNairobi(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return [part("year"), part("month"), part("day")].join("-");
}

function isOverdue(status: "due" | "paid", dueDate: string, today: string): boolean {
  return status === "due" && dueDate < today;
}

export function ApiPlatformInvoices() {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const { data, loading, error } = useAsync(
    async () => {
      const [invoices, schools] = await Promise.all([apiFetchPlatformInvoices(), apiFetchPlatformSchools()]);
      return { invoices, schools };
    },
    [reloadKey],
  );

  const today = todayInNairobi();
  const invoices = data?.invoices ?? [];
  const outstanding = invoices.filter((invoice) => invoice.status === "due");
  const overdue = outstanding.filter((invoice) => isOverdue(invoice.status, invoice.dueDate, today));
  const paid = invoices.filter((invoice) => invoice.status === "paid");
  const outstandingCents = outstanding.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const collectedCents = paid.reduce((sum, invoice) => sum + invoice.amountCents, 0);

  async function markPaid(invoiceId: string) {
    setMarkingPaid(invoiceId);
    try {
      const changed = await apiMarkPlatformInvoicePaid(invoiceId);
      toast(changed ? "Recorded the invoice as paid." : "This invoice was already marked paid.");
      setReloadKey((key) => key + 1);
    } catch (err) {
      toast("Could not mark the invoice paid: " + userMessage(err), "error");
    } finally {
      setMarkingPaid(null);
    }
  }

  const spec: RecordsSpec = {
    eyebrow: "Platform | billing",
    title: "Invoices",
    blurb: "Figbloom invoices for schools. Overdue status is derived from the due date; payments are recorded after manual reconciliation.",
    actions: [
      { label: "New invoice", primary: true, onClick: () => setCreating(true) },
      { label: loading ? "Refreshing..." : "Refresh", onClick: () => setReloadKey((key) => key + 1) },
    ],
    stats: [
      { label: "Outstanding", value: formatMoney(outstandingCents, "KE"), sub: "Across " + outstanding.length + " due invoices" },
      { label: "Overdue", value: String(overdue.length), sub: "Past their due date", alarming: overdue.length > 0 },
      { label: "Collected", value: formatMoney(collectedCents, "KE"), sub: "Paid invoices" },
      { label: "Invoices", value: String(invoices.length), sub: "All recorded invoices" },
    ],
    chips: [
      { label: "All" },
      { label: "Overdue", match: ["overdue"] },
      { label: "Paid", match: ["paid"] },
    ],
    columns: [
      { key: "invoice", header: "Invoice", width: "1fr" },
      { key: "school", header: "School", width: "1.5fr" },
      { key: "amount", header: "Amount", align: "right" },
      { key: "due", header: "Due", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "action", header: "", align: "right", width: "1.2fr" },
    ],
    minWidth: "840px",
    empty: {
      title: "No invoices yet",
      body: "Create an invoice when a school's Figbloom billing charge is ready.",
      action: <Button variant="accent" onClick={() => setCreating(true)}>New invoice</Button>,
    },
    rows: invoices.map((invoice) => {
      const pastDue = isOverdue(invoice.status, invoice.dueDate, today);
      const tag = invoice.status === "paid" ? "paid" : pastDue ? "overdue" : "due";
      const label = invoice.status === "paid" ? "Paid" : pastDue ? "Overdue" : "Due";
      return {
        id: invoice.invoiceId,
        tags: [tag],
        cells: [
          <Mono key="invoice">{invoice.invoiceId.slice(0, 8).toUpperCase()}</Mono>,
          <Cell key="school">{invoice.tenantName}</Cell>,
          <Mono key="amount">{formatMoney(invoice.amountCents, "KE")}</Mono>,
          <span key="due" className="font-mono text-[12.5px] text-ink-muted">{formatShortDate(invoice.dueDate)}</span>,
          <Badge key="status" tone={invoice.status === "paid" ? "ok" : pastDue ? "warn" : "muted"}>{label}</Badge>,
          invoice.status === "paid" ? (
            <span key="action" className="text-[11.5px] text-ink-faint">--</span>
          ) : (
            <div key="action" className="flex justify-end">
              <button
                type="button"
                disabled={markingPaid === invoice.invoiceId}
                onClick={() => void markPaid(invoice.invoiceId)}
                className="text-[11.5px] font-semibold text-leaf hover:underline disabled:opacity-50"
              >
                {markingPaid === invoice.invoiceId ? "Recording..." : "Mark paid"}
              </button>
            </div>
          ),
        ],
      };
    }),
  };

  if (loading && !data) return <RecordsPage spec={spec} loading />;
  if (error && !data) return <RecordsPage spec={spec} error={userMessage(error)} />;

  return (
    <>
      <RecordsPage spec={spec} />
      {creating && data && (
        <NewPlatformInvoiceModal
          schools={data.schools}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setReloadKey((key) => key + 1);
          }}
        />
      )}
    </>
  );
}

function NewPlatformInvoiceModal({ schools, onClose, onCreated }: {
  schools: PlatformSchoolItem[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [schoolId, setSchoolId] = useState(schools[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(todayInNairobi);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function createInvoice() {
    if (!schoolId) {
      setValidationError("Choose a school.");
      return;
    }
    if (!dueDate) {
      setValidationError("Choose a due date.");
      return;
    }
    const match = amount.trim().match(/^([0-9]+)(?:\.([0-9]{1,2}))?$/);
    const amountCents = match
      ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
      : Number.NaN;
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 2_147_483_647) {
      setValidationError("Enter a positive KES amount with up to two decimal places.");
      return;
    }

    setValidationError(null);
    setSaving(true);
    try {
      await apiCreatePlatformInvoice({ tenantId: schoolId, amountCents, dueDate });
      toast("Invoice created.");
      onCreated();
    } catch (err) {
      toast("Could not create the invoice: " + userMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void createInvoice();
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Invoices"
      title="New invoice"
      blurb="Create a Figbloom billing invoice for a school."
      footNote="Payments are recorded after bank reconciliation. The API may ask you to confirm your password."
      actions={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="accent" onClick={() => void createInvoice()} disabled={saving || schools.length === 0}>
            {saving ? "Creating..." : "Create invoice"}
          </Button>
        </>
      }
      width={560}
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        {validationError && (
          <p role="alert" className="rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2 text-[12.5px] text-warn-ink">
            {validationError}
          </p>
        )}
        {schools.length === 0 ? (
          <p className="rounded-lg border border-line bg-sunken/50 px-3 py-2 text-small text-ink-muted">
            There are no schools available for invoicing.
          </p>
        ) : (
          <>
            <SelectField
              id="api-platform-invoice-school"
              label="School"
              value={schoolId}
              onChange={(event) => setSchoolId(event.target.value)}
              options={[
                { value: "", label: "Select a school" },
                ...schools.map((school) => ({ value: school.id, label: school.name })),
              ]}
            />
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField
                id="api-platform-invoice-amount"
                label="Amount (KES)"
                inputMode="decimal"
                placeholder="e.g. 120000"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                hint="Use up to two decimal places."
              />
              <TextField
                id="api-platform-invoice-due-date"
                label="Due date"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}