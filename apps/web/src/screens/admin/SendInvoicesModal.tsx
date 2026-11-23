import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TextField } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

type DeliveryChannel = "in_app" | "push" | "email" | "sms" | "whatsapp";

const ALL_CHANNELS: Array<{ id: DeliveryChannel; label: string }> = [
  { id: "email", label: "Email (with PDF invoice)" },
  { id: "sms", label: "SMS summary" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "push", label: "Push notification" },
  { id: "in_app", label: "In-app notification" },
];

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

export async function downloadInvoicePdf(tenantId: string, invoiceId: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/v1/tenants/${tenantId}/finance/invoices/${invoiceId}/pdf`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Could not download invoice PDF.");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-${invoiceId.slice(0, 8)}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Modal for sending either a single invoice (`invoiceId`) or all unpaid term invoices (`termId`)
 * to parents via Email (PDF), SMS, WhatsApp, Push, and In-app notifications.
 */
export function SendInvoicesModal({
  open,
  onClose,
  invoiceId,
  termId,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId?: string;
  termId?: string;
}) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [channels, setChannels] = useState<Set<DeliveryChannel>>(new Set(["email", "sms", "in_app", "push"]));
  const [customMessage, setCustomMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function toggle(ch: DeliveryChannel) {
    setChannels((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return next;
    });
  }

  async function send() {
    if (channels.size === 0) {
      toast("Select at least one delivery channel.", "error");
      return;
    }
    const base = apiBaseUrl();
    if (!base) {
      toast("API URL is not configured.", "error");
      return;
    }
    const endpoint = invoiceId
      ? `${base}/v1/tenants/${tenant.id}/finance/invoices/${invoiceId}/send`
      : termId
        ? `${base}/v1/tenants/${tenant.id}/finance/terms/${termId}/invoices/send`
        : null;
    if (!endpoint) return;

    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          channels: [...channels],
          ...(customMessage.trim() ? { custom_message: customMessage.trim() } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        toast(json.error?.message ?? "Could not send invoices.", "error");
        return;
      }
      toast(invoiceId ? "Invoice sent to parent(s)." : "Term invoices queued & dispatched to parents.");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={invoiceId ? "Send invoice to parents" : "Send term invoices to parents"}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={busy} onClick={() => void send()}>
            {busy ? "Sending…" : "Send now"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[12.5px] font-semibold text-ink">Delivery channels</p>
          <div className="space-y-1.5">
            {ALL_CHANNELS.map((ch) => (
              <label key={ch.id} className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={channels.has(ch.id)}
                  onChange={() => toggle(ch.id)}
                />
                <span>{ch.label}</span>
              </label>
            ))}
          </div>
        </div>
        <TextField
          id="invoice-custom-note"
          label="Optional note to parents"
          placeholder="e.g. Please clear balances before mid-term break."
          value={customMessage}
          onChange={(e) => setCustomMessage(e.target.value)}
        />
      </div>
    </Modal>
  );
}
