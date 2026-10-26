import { useState } from "react";
import { signatureProblem, type SignatureMark, type SignatureStyle, type Stroke } from "@figbloom/shared";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { SignatureInk } from "./SignatureMark";
import { SignaturePad } from "./SignaturePad";

/**
 * Sign something: draw or type the signature, give your full name, and agree
 * that this is your signature. The date saved is the server's; the one shown
 * here is today's, for the signer to see. Callers do the signing (onSign),
 * since what's signed differs: one file, a class of report cards, a term's
 * invoices.
 */
export function SignDocumentModal({ title, what, capacityLabel, defaultName, onSign, onClose }: {
  title: string;
  /** "the permission slip", read in the agreement: "... the same as signing the permission slip by hand." */
  what: string;
  capacityLabel: string;
  defaultName: string;
  onSign: (mark: SignatureMark) => Promise<void>;
  onClose: () => void;
}) {
  const [style, setStyle] = useState<SignatureStyle>("drawn");
  const [fullName, setFullName] = useState(defaultName);
  const [strokes, setStrokes] = useState<Stroke[] | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mark: SignatureMark = { fullName, style, strokes: style === "drawn" ? strokes : null };
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  async function sign() {
    const problem = signatureProblem(mark) ?? (agreed ? null : "Tick the box to agree.");
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await onSign(mark);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign.");
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      eyebrow="Electronic signature"
      title={title}
      width={560}
      footNote="A signature can't be changed once made. If something is wrong, ask the school office to void it."
      actions={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="accent" onClick={() => void sign()} disabled={saving}>{saving ? "Signing…" : "Sign"}</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="flex gap-1 rounded-md bg-sunken p-1 text-[12.5px] font-medium" role="tablist" aria-label="How to sign">
          {(["drawn", "typed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={style === s}
              onClick={() => setStyle(s)}
              className={`flex-1 rounded px-3 py-1.5 ${style === s ? "bg-white shadow-sm" : "text-ink-muted"}`}
            >
              {s === "drawn" ? "Draw" : "Type"}
            </button>
          ))}
        </div>

        <TextField id="sig-name" label="Your full name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} autoComplete="name" />

        {style === "drawn" ? (
          <SignaturePad onChange={setStrokes} disabled={saving} />
        ) : (
          <div className="grid h-24 place-items-center rounded-md border border-[#D3DAD5] bg-white">
            {fullName.trim()
              ? <SignatureInk signature={{ style: "typed", strokes: null, fullName: fullName.trim() }} height={56} />
              : <span className="text-[12px] text-ink-faint">Your name appears here</span>}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 text-[12.5px]">
          <div><dt className="text-ink-faint">Signing as</dt><dd className="font-medium">{capacityLabel}</dd></div>
          <div><dt className="text-ink-faint">Date</dt><dd className="font-medium">{today}</dd></div>
        </dl>

        <label className="flex items-start gap-2 text-[12.5px] leading-relaxed">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
          <span>I agree that this electronic signature is mine and means the same as signing {what} by hand.</span>
        </label>

        {error && <p className="flex items-start gap-1.5 text-[12px] text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
      </div>
    </Modal>
  );
}
