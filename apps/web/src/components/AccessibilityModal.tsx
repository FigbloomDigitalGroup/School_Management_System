import { useState } from "react";
import { DEFAULT_A11Y, TEXT_SCALES, loadA11y, saveA11y, type A11yPrefs } from "../lib/a11y";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

/** Every change applies the moment it's made, so the person sees exactly what they're choosing. */
export function AccessibilityModal({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState<A11yPrefs>(loadA11y);

  function update(patch: Partial<A11yPrefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveA11y(next);
  }

  const isDefault =
    prefs.textScale === DEFAULT_A11Y.textScale && prefs.bold === DEFAULT_A11Y.bold &&
    prefs.contrast === DEFAULT_A11Y.contrast && prefs.reduceMotion === DEFAULT_A11Y.reduceMotion;

  return (
    <Modal
      open
      onClose={onClose}
      title="Accessibility"
      blurb="Saved on this device only, so a shared computer doesn't carry one person's settings to the next."
      width={520}
      actions={
        <>
          <Button onClick={() => update(DEFAULT_A11Y)} disabled={isDefault}>Reset to default</Button>
          <Button variant="accent" onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="grid gap-5">
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">Text size</legend>
          <div role="radiogroup" aria-label="Text size" className="grid grid-cols-4 gap-2">
            {TEXT_SCALES.map((s) => {
              const on = prefs.textScale === s.value;
              return (
                <button
                  key={s.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => update({ textScale: s.value })}
                  className="hit flex flex-col items-center justify-center rounded-lg border px-2 py-2"
                  style={on ? { borderColor: "var(--accent)", background: "var(--accent)", color: "#fff" } : { borderColor: "#D3DAD5" }}
                >
                  <span className="font-semibold leading-none" style={{ fontSize: 13 * s.value }}>Aa</span>
                  <span className="mt-1 text-[11.5px]">{s.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] text-ink-muted">Makes everything bigger — text, buttons and spacing together.</p>
        </fieldset>

        <div className="grid gap-1 border-t border-line-soft pt-3">
          <Toggle
            label="Bolder text"
            hint="Thicker letters that are easier to read at a glance."
            checked={prefs.bold}
            onChange={(bold) => update({ bold })}
          />
          <Toggle
            label="Higher contrast"
            hint="Darkens grey text and borders, and underlines links."
            checked={prefs.contrast}
            onChange={(contrast) => update({ contrast })}
          />
          <Toggle
            label="Reduce motion"
            hint="Turns off slide and fade animations."
            checked={prefs.reduceMotion}
            onChange={(reduceMotion) => update({ reduceMotion })}
          />
        </div>
      </div>
    </Modal>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold">{label}</span>
        <span className="block text-[12px] text-ink-muted">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#f26a1b]"
        style={{ background: checked ? "var(--accent)" : "#C9D1CB" }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]"
          style={{ left: checked ? 22 : 2 }}
        />
      </span>
    </label>
  );
}
