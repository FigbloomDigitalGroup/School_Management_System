import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  blurb?: string;
  footNote?: string;
  children: ReactNode;
  actions?: ReactNode;
  width?: number;
}

/** Escape closes, focus is trapped to the panel, and the backdrop is clickable. */
export function Modal({ open, onClose, eyebrow, title, blurb, footNote, children, actions, width = 620 }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose that gets a new identity on every render
  // (e.g. every keystroke in a field inside the modal) — a ref keeps Escape
  // and the backdrop click wired to the latest one without that re-running
  // the autofocus effect below and stealing focus back on every keystroke.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    content.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-8"
      style={{ background: "rgba(12,26,18,0.5)" }}
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="animate-rise flex max-h-full flex-col overflow-hidden rounded-xl bg-white"
        style={{ width, maxWidth: "100%" }}
      >
        <header className="flex items-start justify-between gap-3.5 border-b border-line-soft px-5 pb-3.5 pt-4">
          <div className="min-w-0">
            {eyebrow && <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">{eyebrow}</div>}
            <h2 className="mt-1.5 text-[17px] font-semibold">{title}</h2>
            {blurb && <p className="mt-1.5 text-small leading-relaxed text-ink-muted">{blurb}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="hit grid h-8 w-8 shrink-0 place-items-center rounded-md bg-sunken text-ink-muted"
          >
            ✕
          </button>
        </header>

        <div ref={content} className="flex-1 overflow-auto px-5 py-4">{children}</div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-page px-5 py-3.5">
          <span className="text-[12px] text-ink-faint">{footNote}</span>
          <div className="flex gap-2.5">{actions}</div>
        </footer>
      </div>
    </div>
  );
}
