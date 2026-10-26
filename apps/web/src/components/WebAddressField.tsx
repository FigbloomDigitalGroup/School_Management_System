import { useState } from "react";
import { validateSlug } from "@figbloom/shared";
import type { SlugAvailability } from "../lib/slugAvailability";
import { SlugAvailabilityNote } from "./SlugAvailabilityNote";

/**
 * The web address a name turns into, shown the way a browser shows it
 * ("schoolmanagement.figbloom.org/org/kijani-schools") and filled in live as
 * the name is typed, with whether it's free. Most people never touch it;
 * "Edit" turns the last part into a field for the few who want a different
 * one. Used by organization signup and the org console's "Add a school".
 */
export function WebAddressField({ id, base, slug, editing, onEdit, onChange, availability, noun, disabled }: {
  id: string;
  /** Everything before the slug, e.g. "schoolmanagement.figbloom.org/org/". */
  base: string;
  /** The slug as it will be saved (already normalized). */
  slug: string;
  /** Whether the slug has been edited by hand: shows the field instead of the read-only bar. */
  editing: boolean;
  /** Switches to editing, starting from the slug shown. */
  onEdit: () => void;
  onChange: (slug: string) => void;
  availability: SlugAvailability;
  /** What else could own the address: "school" or "organization". */
  noun: string;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const check = slug ? validateSlug(slug) : null;
  const status = availability.status;
  const mark = !slug ? null
    : check && !check.ok ? { text: "✕", tone: "text-warn-ink", label: "Not a valid address" }
    : status === "free" ? { text: "✓", tone: "text-ok-ink", label: "Free" }
    : status === "taken" ? { text: "✕", tone: "text-warn-ink", label: "Taken" }
    : status === "checking" ? { text: "…", tone: "text-ink-faint", label: "Checking" }
    : null;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={id} className="text-small font-semibold">Web address</label>
        {!editing && !disabled && slug && (
          <button type="button" onClick={onEdit} className="text-[11.5px] font-semibold text-forest hover:underline">Edit</button>
        )}
      </div>
      <div
        className={`flex items-center gap-2 rounded-lg border bg-page px-3 py-2.5 font-mono text-[13px] ${focused ? "border-forest" : "border-[#D3DAD5]"}`}
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-ink-faint">{base}</span>
          {editing && !disabled ? (
            <input
              id={id}
              value={slug}
              onChange={(e) => onChange(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!check && !check.ok}
              className="w-[min(22ch,100%)] border-b border-dashed border-forest bg-transparent font-semibold text-ink outline-none"
            />
          ) : (
            <span id={id} className={slug ? "font-semibold text-ink" : "text-ink-faint"}>{slug || "your-name"}</span>
          )}
        </span>
        {mark && <span aria-label={mark.label} title={mark.label} className={`shrink-0 font-sans text-[13px] font-semibold ${mark.tone}`}>{mark.text}</span>}
      </div>
      {slug && check && !check.ok ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{check.message}</p>
      ) : !disabled ? (
        <SlugAvailabilityNote slug={slug} noun={noun} base={base} availability={availability} onPick={(s) => { onEdit(); onChange(s); }} />
      ) : null}
    </div>
  );
}
