import { useEffect, useMemo, useRef, useState } from "react";
import { COUNTRIES } from "@figbloom/shared";

const OPTIONS = Object.entries(COUNTRIES).map(([value, p]) => ({ value, label: p.label }));

interface Props {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const BASE =
  "w-full rounded-md border border-[#D3DAD5] px-3 py-2.5 font-sans text-body outline-none focus:border-forest";

/**
 * A plain native <select> is unusable once it holds all ~194 countries in
 * one flat list on most platforms — no search, and OS-level scroll/typeahead
 * varies. This is a small combobox instead: a trigger button, a popover with
 * a live-filtered search box, and a scrollable option list. The trigger
 * itself still supports single-letter jump-to-country while closed, the way
 * a native <select> does, for anyone who reaches for that instead of typing
 * into the search box.
 */
export function CountrySelect({ id, label, hint, error, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = OPTIONS.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return OPTIONS;
    return OPTIONS.filter((o) => o.label.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlighted(Math.max(0, OPTIONS.findIndex((o) => o.value === value)));
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    // Capture phase + stopPropagation: this popover can open inside a Modal,
    // which has its own document-level Escape listener that closes the whole
    // modal. Without this, Escape here would bubble to that listener too and
    // close the modal behind the popover instead of just the popover.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, { capture: true });
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey, { capture: true }); };
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.children[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = filtered[highlighted]; if (o) choose(o.value); }
  }

  // Native <select>-style behavior while the trigger is closed: pressing a
  // letter jumps to (and cycles through) the next country starting with it.
  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); setOpen(true); return; }
    if (e.key.length === 1 && /[a-z]/i.test(e.key)) {
      e.preventDefault();
      const letter = e.key.toLowerCase();
      const currentIndex = OPTIONS.findIndex((o) => o.value === value);
      const rotated = [...OPTIONS.slice(currentIndex + 1), ...OPTIONS.slice(0, currentIndex + 1)];
      const next = rotated.find((o) => o.label.toLowerCase().startsWith(letter));
      if (next) onChange(next.value);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <label htmlFor={id} className="mb-1.5 block text-small font-semibold">{label}</label>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className={`${BASE} flex items-center justify-between bg-white text-left ${disabled ? "opacity-60" : ""} ${error ? "border-warn-ink" : ""}`}
      >
        <span className={selected ? "" : "text-ink-faint"}>{selected?.label ?? "Select a country"}</span>
        <span aria-hidden className="text-ink-faint">▾</span>
      </button>

      {open && !disabled && (
        <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-md border border-line bg-white shadow-lg">
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlighted(0); }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search countries…"
            aria-label="Search countries"
            className="w-full border-b border-line-soft px-3 py-2 text-body outline-none"
          />
          <ul ref={listRef} role="listbox" className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-small text-ink-faint">No countries match "{query}"</li>
            ) : (
              filtered.map((o, i) => (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => choose(o.value)}
                  className={`cursor-pointer px-3 py-1.5 text-body ${i === highlighted ? "bg-sunken" : ""} ${o.value === value ? "font-semibold" : ""}`}
                >
                  {o.label}
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {error ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn-ink">
          <span aria-hidden>✕</span>{error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}
