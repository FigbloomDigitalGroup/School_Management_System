import { useState } from "react";
import { draftMessage, translateMessage, type MessageLanguage, type MessageTone } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { SelectField, TextArea } from "./ui/Field";
import { AI_DRAFT_NOTE, useAiStatus } from "../lib/useAi";

/**
 * "Write with AI" for an announcement or class message: rough notes in, a
 * subject and message out, put into the composer's own boxes for the sender
 * to edit. Also translates what's in the boxes into Kiswahili or English.
 * Renders nothing when the school has AI turned off.
 */
export function AiWriteHelper({ audience, schoolName, subject, body, onUse, disabled }: {
  /** Who it's for, in words, e.g. "parents of Form 2 West". */
  audience: string;
  schoolName?: string;
  subject: string;
  body: string;
  onUse: (draft: { subject: string; body: string }) => void;
  disabled?: boolean;
}) {
  const ai = useAiStatus();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [tone, setTone] = useState<MessageTone>("warm");
  const [language, setLanguage] = useState<MessageLanguage>("en");
  const [busy, setBusy] = useState<"draft" | "sw" | "en" | null>(null);
  const [error, setError] = useState("");
  if (!ai?.aiEnabled) return null;

  async function run(kind: "draft" | "sw" | "en") {
    setBusy(kind);
    setError("");
    try {
      onUse(kind === "draft"
        ? await draftMessage({ notes: notes.trim(), audience, tone, language, schoolName })
        : await translateMessage(subject, body, kind));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not draft the message.");
    } finally {
      setBusy(null);
    }
  }

  const hasText = !!body.trim();
  return (
    <div className="rounded-lg border border-line-soft bg-page px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-small font-semibold">Write with Bloom</span>
        <Button disabled={disabled || !!busy} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "From notes"}</Button>
        <Button disabled={disabled || !!busy || !hasText} onClick={() => void run("sw")} title={hasText ? undefined : "Write the message first."}>
          {busy === "sw" ? "Translating…" : "Translate to Kiswahili"}
        </Button>
        <Button disabled={disabled || !!busy || !hasText} onClick={() => void run("en")} title={hasText ? undefined : "Write the message first."}>
          {busy === "en" ? "Translating…" : "To English"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 grid gap-3">
          <TextArea id="ai-notes" label="Your notes" placeholder="e.g. half term fri 12 sept, closing 12:30, boarders collect travel passes from deputy thurs"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
            <SelectField id="ai-tone" label="Tone" value={tone} onChange={(e) => setTone(e.target.value as MessageTone)}
              options={[{ value: "warm", label: "Warm" }, { value: "formal", label: "Formal" }, { value: "brief", label: "Brief" }]} />
            <SelectField id="ai-language" label="Language" value={language} onChange={(e) => setLanguage(e.target.value as MessageLanguage)}
              options={[{ value: "en", label: "English" }, { value: "sw", label: "Kiswahili" }, { value: "both", label: "English and Kiswahili" }]} />
            <div className="flex items-end">
              <Button variant="accent" disabled={disabled || !!busy || !notes.trim()} onClick={() => void run("draft")}>{busy === "draft" ? "Drafting…" : "Draft"}</Button>
            </div>
          </div>
        </div>
      )}
      <p className="mt-2 text-[11.5px] text-ink-faint">
        Puts the draft in the subject and message boxes{hasText ? ", replacing what's there" : ""}. {AI_DRAFT_NOTE}
      </p>
      {error && <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
    </div>
  );
}
