import { useState, type FormEvent } from "react";
import {
  KES, PAYMENT_FAILURES, againstMean, gradeFor, itemsForStudent, normaliseMsisdn, payableSuggestions, supabase,
} from "@figbloom/shared";
import { formatPhone, formatShortDate, loadParentData } from "@figbloom/shared";
import { PhoneFrame, TabBar } from "../../components/PhoneFrame";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { listPaymentProofs, privateDocUrl, uploadPaymentProof, type PaymentProof } from "../../lib/uploads";

const PROOF_STYLE: Record<PaymentProof["status"], string> = {
  pending: "bg-app-line-soft text-app-muted",
  confirmed: "bg-ok-bg text-ok-ink",
  rejected: "bg-warn-bg text-warn-ink",
};
const PROOF_LABEL: Record<PaymentProof["status"], string> = { pending: "Pending", confirmed: "Confirmed", rejected: "Rejected" };

/** The current-term invoice id for a child — same lookup used by the desktop
 *  parent Fees screen, duplicated here since this is a standalone preview. */
async function fetchCurrentInvoiceId(studentId: string): Promise<string | null> {
  const { data: term } = await supabase().from("terms").select("id").eq("is_current", true).maybeSingle();
  if (!term) return null;
  const { data: invoice } = await supabase()
    .from("fee_invoices")
    .select("id")
    .eq("student_id", studentId)
    .eq("term_id", term.id)
    .maybeSingle();
  return invoice?.id ?? null;
}

/**
 * The parent app. One phone, one or more children, four things they came to do:
 * see how the child is doing, pay the fee, read the school's message, and know
 * an absence was noticed.
 *
 * Children are told apart by depth of the school accent, not by unrelated hues —
 * the school's branding still leads, and every screen title names the child.
 */

type Screen = "home" | "fees" | "pay" | "results" | "inbox" | "message" | "settings";

export function ParentApp({ accent = "#7A1F2B", deep = "#4E1520" }: { accent?: string; deep?: string }) {
  const { profile, tenant } = useTenantSession();
  const { data, loading } = useAsync(() => loadParentData(profile.id), [profile.id]);
  const toast = useToast();

  const [screen, setScreen] = useState<Screen>("home");
  const [kid, setKid] = useState(0);
  const [msgId, setMsgId] = useState<string | null>(null);
  const [read, setRead] = useState<Record<string, boolean>>({});
  const [amount, setAmount] = useState(0);
  const [phone, setPhone] = useState(formatPhone(profile.phone).replace("+254 ", "0") || "0722 118 004");
  const [payState, setPayState] = useState<"idle" | "prompting" | "failed" | "done">("idle");
  const [error, setError] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofNote, setProofNote] = useState("");
  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofReload, setProofReload] = useState(0);

  const tint = kid === 0 ? deep : accent;

  // Computed ahead of the loading early-return below so these hooks still run
  // on every render, in the same order, regardless of load state.
  const childId = data ? (data.children[Math.min(kid, Math.max(data.children.length - 1, 0))]?.id ?? null) : null;
  const { data: invoiceId } = useAsync(
    () => (childId ? fetchCurrentInvoiceId(childId) : Promise.resolve(null)),
    [childId],
  );
  const { data: proofs, loading: proofsLoading } = useAsync(
    () => (invoiceId ? listPaymentProofs(invoiceId) : Promise.resolve([] as PaymentProof[])),
    [invoiceId, proofReload],
  );

  if (loading || !data) {
    return (
      <PhoneFrame accent={tint}>
        <header className="shrink-0 px-4 pb-4 pt-3" style={{ background: tint, color: "#fff" }}>
          <Skeleton className="h-6 w-32 bg-white/20" />
          <Skeleton className="mt-2 h-3 w-40 bg-white/10" />
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-app-page px-4 pb-6 pt-4">
          <Skeleton className="h-28 rounded-2xl" />
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </div>
          <Skeleton className="mt-5 h-4 w-32" />
          <div className="mt-2 grid gap-2">
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" />
          </div>
        </div>
        <TabBar
          items={[
            { label: "Home", icon: "◈", active: true, onPress: () => {} },
            { label: "Fees", icon: "▦", active: false, onPress: () => {} },
            { label: "Results", icon: "▤", active: false, onPress: () => {} },
            { label: "Inbox", icon: "◉", active: false, onPress: () => {} },
            { label: "Account", icon: "⚙", active: false, onPress: () => {} },
          ]}
        />
      </PhoneFrame>
    );
  }

  const children = data.children;
  const child = children[Math.min(kid, Math.max(children.length - 1, 0))];
  const messages = data.messages;
  const msg = messages.find((m) => m.id === msgId) ?? messages[0] ?? null;
  const unread = messages.filter((m) => m.unread && !read[m.id]).length;

  if (!child) {
    return (
      <PhoneFrame accent={tint}>
        <header className="shrink-0 px-4 pb-4 pt-3" style={{ background: tint, color: "#fff" }}>
          <div className="text-[21px] font-semibold tracking-tight">No child linked</div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-app-page px-4 pb-6 pt-6 text-center text-[13px] text-app-muted">
          This account is not yet linked to a learner. Contact the school office.
        </div>
      </PhoneFrame>
    );
  }

  const feeItems = itemsForStudent(data.feeItems as never, { boarding: child.boarding }, child.formLevel);
  const statCards = [
    {
      label: "Attendance",
      value: child.attendancePct === null ? "—" : `${child.attendancePct}%`,
      note: child.attendancePct === null ? "No attendance recorded yet" : "this term",
    },
    {
      label: "Mean grade",
      value: child.mean === null ? "—" : gradeFor(child.mean),
      note: child.mean === null ? "Not published yet" : `${child.mean} marks${child.examName ? `, ${child.examName}` : ""}`,
    },
  ];

  function startPay() {
    const p = normaliseMsisdn(phone);
    if (!p.ok) { setError(p.message); return; }
    if (amount <= 0) { setError("Enter how much you are paying."); return; }
    setError("");
    setPayState("prompting");
    // Daraja STK push: the prompt appears on the handset, we wait for the callback.
    window.setTimeout(() => setPayState(amount > child!.balance ? "failed" : "done"), 1800);
  }

  async function handleUploadProof(e: FormEvent) {
    e.preventDefault();
    if (!invoiceId || !proofFile) return;
    setUploadingProof(true);
    try {
      await uploadPaymentProof({
        tenantId: tenant.id,
        invoiceId,
        uploadedBy: profile.id,
        note: proofNote.trim() || undefined,
        file: proofFile,
      });
      toast("Payment proof uploaded — the bursar will review it.");
      setProofFile(null);
      setProofNote("");
      setProofReload((n) => n + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not upload proof: ${err.message}` : "Could not upload proof.");
    } finally {
      setUploadingProof(false);
    }
  }

  async function openProof(path: string) {
    try {
      const url = await privateDocUrl(path);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open that file.");
    }
  }

  return (
    <PhoneFrame accent={tint}>
      <header className="shrink-0 px-4 pb-4 pt-3" style={{ background: tint, color: "#fff" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[21px] font-semibold tracking-tight">
              {screen === "home" ? `${child.first}` : screen === "fees" || screen === "pay" ? "Fees" : screen === "results" ? "Results" : screen === "inbox" || screen === "message" ? "Inbox" : "Account"}
            </div>
            <div className="mt-0.5 text-[12.5px] text-white/75">{child.cls} · ADM {child.adm}</div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {children.map((c, i) => (
              <button key={c.id} onClick={() => { setKid(i); setPayState("idle"); }}
                aria-pressed={i === kid} aria-label={c.name}
                className="grid h-9 w-9 place-items-center rounded-xl text-[12px] font-bold"
                style={{
                  background: i === kid ? "#fff" : "rgba(255,255,255,0.18)",
                  color: i === kid ? tint : "#fff",
                }}>
                {c.first[0]}{c.name.split(" ")[1]?.[0] ?? ""}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-app-page px-4 pb-6">
        {screen === "home" && (
          <>
            <div className="-mt-2.5 rounded-2xl border border-app-line bg-white p-4 shadow-sm">
              <div className="font-mono text-[9.5px] tracking-[0.12em] text-app-faint">FEE BALANCE{data.termLabel ? ` · ${data.termLabel.toUpperCase()}` : ""}</div>
              <div className="mt-1.5 text-[30px] font-bold tracking-tight" style={{ color: child.balance > 0 ? tint : "#1B4D2E" }}>
                {child.balance > 0 ? KES(child.balance) : "Cleared"}
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-app-muted">
                {child.balance > 0
                  ? `Of ${KES(child.billed)} billed. Part payment is fine — many families pay across the term.`
                  : `All ${KES(child.billed)} paid. Nothing due until the next term.`}
              </p>
              {child.balance > 0 && (
                <button onClick={() => { setScreen("pay"); setAmount(child.balance); }}
                  className="hit mt-3 w-full rounded-xl py-3.5 text-[15px] font-semibold text-white"
                  style={{ background: tint }}>
                  Pay with M-Pesa
                </button>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5">
              {statCards.map((s) => (
                <div key={s.label} className="rounded-2xl border border-app-line bg-white p-3.5">
                  <div className="font-mono text-[9.5px] tracking-[0.12em] text-app-faint">{s.label.toUpperCase()}</div>
                  <div className="mt-1 text-[24px] font-semibold tracking-tight">{s.value}</div>
                  <div className="text-[11.5px] text-app-faint">{s.note}</div>
                </div>
              ))}
            </div>

            {child.attendancePct !== null && child.attendancePct < 90 && (
              <div className="mt-4 flex gap-3 rounded-2xl border border-orange-line bg-orange-soft p-3.5">
                <div className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-orange text-[13px] font-bold text-white">!</div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-orange-ink">
                    {child.absentDates.length > 0
                      ? `${child.first} missed ${child.absentDates.length} day${child.absentDates.length === 1 ? "" : "s"} this term`
                      : `${child.first}'s attendance is below 90% this term`}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-orange-ink">
                    {child.absentDates.length > 0
                      ? `${child.absentDates.slice(-2).map(formatShortDate).join(" and ")}, unexplained. If there was a reason, telling the class teacher clears it from the record.`
                      : "Mostly lateness rather than full absence. Worth a word with the class teacher if there is a reason."}
                  </p>
                </div>
              </div>
            )}

            <h2 className="mb-2 mt-5 text-[15px] font-semibold">From the school</h2>
            <div className="grid gap-2">
              {messages.slice(0, 2).map((m) => (
                <button key={m.id} onClick={() => { setMsgId(m.id); setRead((r) => ({ ...r, [m.id]: true })); setScreen("message"); }}
                  className="flex gap-3 rounded-2xl border border-app-line bg-white p-3.5 text-left">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[13px] text-white" style={{ background: m.who === "school" ? tint : "#F1EDEC", color: m.who === "school" ? "#fff" : "#6B605F" }}>
                    {m.who === "school" ? "◈" : "✎"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13.5px]" style={{ fontWeight: m.unread && !read[m.id] ? 700 : 500 }}>{m.subject}</span>
                      <span className="shrink-0 text-[11px] text-app-faint">{m.when}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-app-muted">{m.body.split("\n")[0]}</p>
                  </div>
                </button>
              ))}
              {messages.length === 0 && (
                <div className="rounded-2xl border border-app-line bg-white px-4 py-5 text-center text-[12.5px] text-app-faint">
                  Nothing from the school yet.
                </div>
              )}
            </div>
          </>
        )}

        {screen === "fees" && (
          <div className="pt-4">
            <div className="rounded-2xl border border-app-line bg-white p-4">
              <div className="font-mono text-[9.5px] tracking-[0.12em] text-app-faint">{child.first.toUpperCase()}{data.termLabel ? ` · ${data.termLabel.toUpperCase()}` : ""}</div>
              <div className="mt-1.5 flex items-baseline justify-between">
                <span className="text-[26px] font-bold tracking-tight">{KES(child.balance)}</span>
                <span className="text-[12.5px] text-app-muted">{child.dueOn ? `due ${formatShortDate(child.dueOn)}` : ""}</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded bg-app-line-soft">
                <div className="h-2 rounded" style={{ width: `${child.billed > 0 ? (1 - child.balance / child.billed) * 100 : 100}%`, background: tint }} />
              </div>
              <div className="mt-2 text-[12px] text-app-faint">
                {KES(child.billed - child.balance)} paid of {KES(child.billed)}
              </div>
            </div>

            <h2 className="mb-2 mt-5 text-[15px] font-semibold">What this term covers</h2>
            <div className="overflow-hidden rounded-2xl border border-app-line bg-white">
              {feeItems.length === 0 && (
                <div className="px-4 py-5 text-center text-[12.5px] text-app-faint">Fee structure not published yet.</div>
              )}
              {feeItems.map((i) => (
                <div key={i.id} className="flex justify-between border-b border-app-line-soft px-4 py-2.5 last:border-0">
                  <span className="text-[13px]">{i.name}</span>
                  <span className="font-mono text-[13px]">{KES(i.amount_cents)}</span>
                </div>
              ))}
            </div>

            <h2 className="mb-2 mt-5 text-[15px] font-semibold">Receipts</h2>
            <div className="overflow-hidden rounded-2xl border border-app-line bg-white">
              {child.receipts.length === 0 ? (
                <div className="px-4 py-5 text-center text-[12.5px] text-app-faint">No receipts yet. Payments made through M-Pesa appear here once confirmed.</div>
              ) : child.receipts.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 border-b border-app-line-soft px-4 py-3 last:border-0">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{KES(r.amount)}</div>
                    <div className="font-mono text-[10.5px] text-app-faint">{r.when} · {r.ref}</div>
                  </div>
                  <span className="rounded-full bg-ok-bg px-2.5 py-0.5 text-[11.5px] font-semibold text-ok-ink">Received</span>
                </div>
              ))}
            </div>

            <h2 className="mb-2 mt-5 text-[15px] font-semibold">Payment proof</h2>
            <div className="overflow-hidden rounded-2xl border border-app-line bg-white p-4">
              <p className="text-[12px] leading-relaxed text-app-muted">
                Paid by bank slip or cash at the office? Upload evidence for the bursar to confirm.
              </p>
              <form onSubmit={handleUploadProof} className="mt-3 grid gap-2.5">
                <input
                  key={proofReload}
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
                  className="block text-[12px]"
                />
                <input
                  value={proofNote}
                  onChange={(e) => setProofNote(e.target.value)}
                  placeholder="Note (optional) — e.g. Paid at the school office"
                  className="w-full rounded-xl border border-app-line px-3.5 py-2.5 text-[12.5px] outline-none"
                />
                <button
                  type="submit"
                  disabled={!proofFile || !invoiceId || uploadingProof}
                  className="hit w-full rounded-xl py-3 text-[13.5px] font-semibold text-white disabled:opacity-50"
                  style={{ background: tint }}
                >
                  {uploadingProof ? "Uploading…" : "Upload proof"}
                </button>
              </form>

              {!proofsLoading && proofs && proofs.length > 0 && (
                <div className="mt-3 grid gap-2">
                  {proofs.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => openProof(p.file_path)}
                      className="flex items-center justify-between gap-2 rounded-xl border border-app-line-soft px-3 py-2 text-left"
                    >
                      <span className="min-w-0 truncate text-[12px] font-medium">{p.file_name}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${PROOF_STYLE[p.status]}`}>
                        {PROOF_LABEL[p.status]}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {child.balance > 0 && (
              <button onClick={() => { setScreen("pay"); setAmount(child.balance); }}
                className="hit mt-5 w-full rounded-xl py-3.5 text-[15px] font-semibold text-white" style={{ background: tint }}>
                Pay {KES(child.balance)}
              </button>
            )}
          </div>
        )}

        {screen === "pay" && (
          <div className="pt-4">
            {payState === "done" ? (
              <div className="pt-6 text-center">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-ok-bg text-2xl text-ok-ink">✓</div>
                <h2 className="text-[19px] font-semibold">{KES(amount)} received</h2>
                <p className="mx-auto mt-2 max-w-[280px] text-[13px] leading-relaxed text-app-muted">
                  {child.first}'s balance is now {KES(Math.max(child.balance - amount, 0))}. The receipt will appear
                  below once the school's system confirms it.
                </p>
                <div className="mx-auto mt-5 max-w-[300px] rounded-2xl border border-app-line bg-white p-4 text-left">
                  {[["Paid", KES(amount)], ["For", child.name], ["Method", "M-Pesa " + phone]].map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-app-line-soft py-2 text-[12.5px] last:border-0">
                      <span className="text-app-muted">{k}</span><span className="font-medium">{v}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-5 grid gap-2">
                  <Button block onClick={() => { setPayState("idle"); setScreen("fees"); }}>Back to fees</Button>
                </div>
              </div>
            ) : payState === "failed" ? (
              <div className="pt-6 text-center">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-warn-bg text-2xl text-warn-ink">!</div>
                <h2 className="text-[19px] font-semibold">The payment did not go through</h2>
                <p className="mx-auto mt-2 max-w-[300px] text-[13px] leading-relaxed text-app-muted">
                  {PAYMENT_FAILURES.timeout}
                </p>
                <div className="mt-5 grid gap-2">
                  <button onClick={() => setPayState("idle")} className="hit w-full rounded-xl py-3.5 text-[15px] font-semibold text-white" style={{ background: tint }}>
                    Try again
                  </button>
                  <Button block onClick={() => { setPayState("idle"); setScreen("fees"); }}>Pay at the school office instead</Button>
                </div>
              </div>
            ) : payState === "prompting" ? (
              <div className="pt-10 text-center">
                <div className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-[3px] border-app-line" style={{ borderTopColor: tint }} />
                <h2 className="text-[17px] font-semibold">Check your phone</h2>
                <p className="mx-auto mt-2 max-w-[280px] text-[13px] leading-relaxed text-app-muted">
                  An M-Pesa prompt has been sent to {phone}. Enter your PIN when it appears. Do not close this screen.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-2xl border border-app-line bg-white p-4">
                  <div className="font-mono text-[9.5px] tracking-[0.12em] text-app-faint">PAYING FOR</div>
                  <div className="mt-1 text-[16px] font-semibold">{child.name}</div>
                  <div className="text-[12.5px] text-app-muted">{child.cls} · balance {KES(child.balance)}</div>
                </div>

                <h2 className="mb-2 mt-4 text-[15px] font-semibold">How much?</h2>
                <div className="grid gap-2">
                  {payableSuggestions(child.balance).map((s) => {
                    const on = s.cents > 0 && amount === s.cents;
                    return (
                      <button key={s.label} onClick={() => setAmount(s.cents)}
                        className="flex items-center justify-between rounded-2xl border-[1.5px] bg-white px-4 py-3 text-left"
                        style={{ borderColor: on ? tint : "#EAE6E5" }}>
                        <span className="text-[13.5px] font-medium">{s.label}</span>
                        {s.cents > 0 && <span className="font-mono text-[13px]">{KES(s.cents)}</span>}
                      </button>
                    );
                  })}
                </div>

                <label className="mt-4 block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">Amount</span>
                  <input value={amount ? String(amount / 100) : ""} inputMode="numeric"
                    onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9]/g, "")) * 100)}
                    className="w-full rounded-xl border border-app-line px-3.5 py-3 font-mono text-[15px] outline-none" />
                </label>

                <label className="mt-3.5 block">
                  <span className="mb-1.5 block text-[12.5px] font-semibold">M-Pesa number</span>
                  <input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)}
                    className="w-full rounded-xl border px-3.5 py-3 font-mono text-[15px] outline-none"
                    style={{ borderColor: error ? "#B8460A" : "#EAE6E5" }} />
                  {error && <span className="mt-1.5 block text-[11.5px] text-warn-ink">{error}</span>}
                </label>

                <button onClick={startPay} className="hit mt-5 w-full rounded-xl py-3.5 text-[15px] font-semibold text-white" style={{ background: tint }}>
                  Send M-Pesa prompt
                </button>
                <p className="mt-3 text-center text-[12px] leading-relaxed text-app-faint">
                  You will get a prompt on {phone}. Nothing leaves your account until you enter your PIN.
                </p>
              </>
            )}
          </div>
        )}

        {screen === "results" && (
          <div className="pt-4">
            {child.mean === null ? (
              <div className="py-14 text-center">
                <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-app-line-soft text-lg text-app-faint">▤</div>
                <div className="text-[15px] font-semibold">Not published yet</div>
                <p className="mx-auto mt-1.5 max-w-[260px] text-[13px] leading-relaxed text-app-muted">
                  {child.first}'s results will appear here as soon as the school publishes them.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-2xl p-4 text-white" style={{ background: tint }}>
                  <div className="font-mono text-[9.5px] tracking-[0.12em] text-white/70">MEAN GRADE{child.examName ? ` · ${child.examName.toUpperCase()}` : ""}</div>
                  <div className="mt-1.5 flex items-baseline gap-3">
                    <span className="text-[38px] font-bold tracking-tight">{gradeFor(child.mean)}</span>
                    <span className="font-mono text-[14px] text-white/80">{child.mean} marks</span>
                  </div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-white/85">
                    {child.subjects.length > 0 && (() => {
                      const sorted = [...child.subjects].sort((a, b) => b.score - a.score);
                      const strongest = sorted[0]!.name;
                      const weakest = sorted[sorted.length - 1]!.name;
                      return `${strongest} is the strongest; ${weakest} is the one to watch.`;
                    })()}
                  </p>
                </div>

                <div className="mt-4 grid gap-2">
                  {child.subjects.map((s) => (
                    <div key={s.name} className="flex items-center gap-3 rounded-2xl border border-app-line bg-white px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium">{s.name}</div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-app-line-soft">
                          <div className="h-1.5 rounded" style={{ width: `${s.score}%`, background: s.score >= 80 ? "#1B4D2E" : s.score >= 65 ? "#2E7D4F" : "#F9A05C" }} />
                        </div>
                        <div className="mt-1.5 text-[11.5px] text-app-faint">
                          {s.classMean !== null ? againstMean(s.score, s.classMean) : "Class mean not available"}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-[18px]">{s.score}</div>
                        <div className="text-[12px] font-bold" style={{ color: s.score >= 75 ? "#1B4D2E" : s.score >= 65 ? "#2E7D4F" : "#8A3D08" }}>{gradeFor(s.score)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {screen === "inbox" && (
          <div className="grid gap-2 pt-4">
            {messages.map((m) => {
              const isUnread = m.unread && !read[m.id];
              return (
                <button key={m.id} onClick={() => { setMsgId(m.id); setRead((r) => ({ ...r, [m.id]: true })); setScreen("message"); }}
                  className="flex gap-3 rounded-2xl border border-app-line bg-white p-3.5 text-left">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[13px]"
                    style={{ background: isUnread ? tint : "#F1EDEC", color: isUnread ? "#fff" : "#6B605F" }}>
                    {m.who === "school" ? "◈" : "✎"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13.5px]" style={{ fontWeight: isUnread ? 700 : 500 }}>{m.from}</span>
                      <span className="shrink-0 text-[11px] text-app-faint">{m.when}</span>
                    </div>
                    <div className="truncate text-[13px]" style={{ fontWeight: isUnread ? 600 : 400 }}>{m.subject}</div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-app-muted">{m.body.split("\n")[0]}</p>
                  </div>
                </button>
              );
            })}
            {messages.length === 0 && (
              <div className="rounded-2xl border border-app-line bg-white px-4 py-8 text-center text-[12.5px] text-app-faint">
                Nothing here yet.
              </div>
            )}
          </div>
        )}

        {screen === "message" && msg && (
          <div className="pt-4">
            <button onClick={() => setScreen("inbox")} className="text-[13px] font-semibold" style={{ color: tint }}>‹ Inbox</button>
            <h2 className="mt-3 text-[19px] font-semibold leading-snug tracking-tight">{msg.subject}</h2>
            <div className="mt-1.5 text-[12.5px] text-app-muted">{msg.from} · {msg.when}</div>
            <p className="mt-4 whitespace-pre-line text-[14.5px] leading-relaxed">{msg.body}</p>
            {msg.who === "teacher" && (
              <button className="hit mt-5 w-full rounded-xl py-3.5 text-[15px] font-semibold text-white" style={{ background: tint }}>
                Reply to {msg.from}
              </button>
            )}
          </div>
        )}

        {screen === "settings" && (
          <div className="pt-4">
            <div className="rounded-2xl border border-app-line bg-white p-4">
              <div className="text-[16px] font-semibold">{profile.full_name}</div>
              <div className="mt-0.5 font-mono text-[12px] text-app-muted">{formatPhone(profile.phone)}</div>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-app-muted">
                {children.length} {children.length === 1 ? "child" : "children"} at {tenant.name}. To add or remove a
                child, the school office has to do it — that is deliberate.
              </p>
            </div>

            <h2 className="mb-2 mt-5 font-mono text-[9.5px] tracking-[0.12em] text-app-faint">HOW WE REACH YOU</h2>
            <div className="overflow-hidden rounded-2xl border border-app-line bg-white px-4">
              {[
                ["Fee reminders", "SMS and in the app", true],
                ["Absence on the day", "SMS at 09:00", true],
                ["Results published", "In the app only", true],
                ["General school notices", "In the app only", false],
              ].map(([label, note, on]) => (
                <div key={label as string} className="flex items-center gap-3 border-b border-app-line-soft py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{label}</div>
                    <div className="mt-0.5 text-[11.5px] text-app-faint">{note}</div>
                  </div>
                  <div className="flex h-6 w-11 shrink-0 items-center rounded-full p-0.5" style={{ background: on ? tint : "#DAD5D4", justifyContent: on ? "flex-end" : "flex-start" }}>
                    <div className="h-5 w-5 rounded-full bg-white" />
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-4 text-[12px] leading-relaxed text-app-faint">
              Fee reminders and same-day absences always go by SMS as well, because they are the two things a parent
              cannot afford to miss.
            </p>
          </div>
        )}
      </div>

      <TabBar
        items={[
          { label: "Home", icon: "◈", active: screen === "home", onPress: () => setScreen("home") },
          { label: "Fees", icon: "▦", active: screen === "fees" || screen === "pay", onPress: () => setScreen("fees") },
          { label: "Results", icon: "▤", active: screen === "results", onPress: () => setScreen("results") },
          { label: unread ? `Inbox (${unread})` : "Inbox", icon: "◉", active: screen === "inbox" || screen === "message", onPress: () => setScreen("inbox") },
          { label: "Account", icon: "⚙", active: screen === "settings", onPress: () => setScreen("settings") },
        ]}
      />
    </PhoneFrame>
  );
}
