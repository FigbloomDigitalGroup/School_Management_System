import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";

export interface ConfirmOptions {
  /** The question, short: "Delete “Fractions”?" */
  title: string;
  /** What happens if they go ahead, in a sentence or two. */
  body?: string;
  /** Says what the button does — "Delete", "Send", "Withdraw" — never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Deletes or can't be taken back: the button is red and Cancel takes focus, so Enter is the safe choice. */
  danger?: boolean;
}

export interface AskOptions extends Omit<ConfirmOptions, "danger"> {
  /** The field's label. */
  label: string;
  placeholder?: string;
  /** Without it, an empty answer is allowed and comes back as "". */
  required?: boolean;
}

type Open =
  | { kind: "confirm"; o: ConfirmOptions; done: (v: boolean) => void }
  | { kind: "ask"; o: AskOptions; done: (v: string | null) => void };

// set by the mounted ConfirmHost; before it mounts every question is a no
let show: ((o: Open) => void) | null = null;

/** The app's confirm(): resolves true when they confirm; false on Cancel, Escape or a click outside. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => (show ? show({ kind: "confirm", o, done: resolve }) : resolve(false)));
}

/** The app's prompt(): resolves to the trimmed answer, or null if they cancel. */
export function promptDialog(o: AskOptions): Promise<string | null> {
  return new Promise((resolve) => (show ? show({ kind: "ask", o, done: resolve }) : resolve(null)));
}

/**
 * Shows confirmDialog and promptDialog, in place of the browser's confirm and
 * prompt: the browser's box is headed with the site's address, can't be
 * styled, and freezes the page. One question at a time; asking a second
 * cancels the first. Mount once, at the root.
 */
export function ConfirmHost() {
  const [open, setOpen] = useState<Open | null>(null);
  const current = useRef<Open | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    show = (next) => {
      seq.current += 1;
      const prev = current.current;
      if (prev?.kind === "confirm") prev.done(false);
      else if (prev) prev.done(null);
      current.current = next;
      setOpen(next);
    };
    return () => { show = null; };
  }, []);

  function finish(v: boolean | string | null) {
    const o = current.current;
    if (!o) return;
    current.current = null;
    setOpen(null);
    if (o.kind === "confirm") o.done(v === true);
    else o.done(typeof v === "string" ? v : null);
  }

  return open ? <ConfirmDialog key={seq.current} open={open} onFinish={finish} /> : null;
}

function ConfirmDialog({ open, onFinish }: { open: Open; onFinish: (v: boolean | string | null) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [answer, setAnswer] = useState("");
  const [missing, setMissing] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const fieldId = useId();
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const { o } = open;
  const danger = open.kind === "confirm" && !!open.o.danger;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (open.kind === "ask" ? field.current : danger ? cancelBtn.current : okBtn.current)?.focus();
    function onKey(e: KeyboardEvent) {
      // captured on window and stopped, so a Modal underneath doesn't also close on the same Escape
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onFinishRef.current(open.kind === "ask" ? null : false); return; }
      if (e.key !== "Tab") return;
      const all = Array.from(panel.current?.querySelectorAll<HTMLElement>("button, textarea") ?? []).filter((el) => !el.hasAttribute("disabled"));
      if (all.length === 0) return;
      const first = all[0]!;
      const last = all[all.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      before?.focus?.({ preventScroll: true });
    };
  }, [open.kind, danger]);

  function submit() {
    if (open.kind === "confirm") { onFinish(true); return; }
    const v = answer.trim();
    if (open.o.required && !v) { setMissing(true); field.current?.focus(); return; }
    onFinish(v);
  }

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center p-4"
      style={{ background: "rgba(12,26,18,0.5)" }}
      // a click outside cancels a yes/no, but never throws away a typed answer
      onMouseDown={(e) => { if (e.target === e.currentTarget && open.kind === "confirm") onFinish(false); }}
    >
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={o.body ? bodyId : undefined}
        className="animate-rise w-full max-w-[440px] overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="px-5 pb-4 pt-5">
            <h2 id={titleId} className="text-[16px] font-semibold leading-snug">{o.title}</h2>
            {o.body && <p id={bodyId} className="mt-1.5 text-small leading-relaxed text-ink-muted">{o.body}</p>}
            {open.kind === "ask" && (
              <div className="mt-3.5">
                <label htmlFor={fieldId} className="mb-1.5 block text-small font-semibold">{open.o.label}</label>
                <textarea
                  ref={field}
                  id={fieldId}
                  rows={3}
                  value={answer}
                  placeholder={open.o.placeholder}
                  aria-invalid={missing}
                  onChange={(e) => { setAnswer(e.target.value); setMissing(false); }}
                  // Enter sends, as in the browser's prompt; Shift+Enter for a new line
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                  className={`w-full resize-y rounded-md border px-3 py-2.5 font-sans text-body outline-none focus:border-forest ${missing ? "border-warn-ink" : "border-[#D3DAD5]"}`}
                />
                {missing && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn-ink">
                    <span aria-hidden>✕</span>This needs an answer.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2.5 border-t border-line bg-page px-5 py-3.5">
            <Button ref={cancelBtn} type="button" onClick={() => onFinish(open.kind === "ask" ? null : false)}>{o.cancelLabel ?? "Cancel"}</Button>
            <Button ref={okBtn} type="submit" variant={danger ? "danger" : "primary"}>{o.confirmLabel}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
