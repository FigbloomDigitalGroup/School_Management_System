import { useEffect, useRef, useState } from "react";
import {
  BLOOD_GROUPS, COMMON_ALLERGIES, COMMON_CONDITIONS, fetchStudentHealth, healthFlags, healthToInput, isHealthEmpty,
  normaliseList, saveStudentHealth, splitList, type HealthFlags, type StudentHealthInput,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import type { ToastFn } from "../ui/Toast";

/**
 * Health and bio details (student_health): the form, the Manage learner /
 * parent editor around it, and the small red chip a teacher sees on a class
 * list. Nothing here is required; a school fills in what it knows.
 */

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none";
const label = "mb-1 block text-[11.5px] font-semibold";

export function HealthFields({ value, onChange }: { value: StudentHealthInput; onChange: (v: StudentHealthInput) => void }) {
  const set = (patch: Partial<StudentHealthInput>) => onChange({ ...value, ...patch });
  const text = (k: keyof StudentHealthInput) => ({
    value: (value[k] as string | null) ?? "",
    onChange: (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<StudentHealthInput>),
  });

  return (
    <div className="grid gap-3">
      <ChipList
        title="Allergies"
        items={value.allergies}
        suggestions={COMMON_ALLERGIES}
        onChange={(allergies) => set({ allergies })}
        placeholder="Type an allergy and press Enter"
        danger
      />
      <ChipList
        title="Medical conditions"
        items={value.medical_conditions}
        suggestions={COMMON_CONDITIONS}
        onChange={(medical_conditions) => set({ medical_conditions })}
        placeholder="Type a condition and press Enter"
      />
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block">
          <span className={label}>Medication</span>
          <input {...text("medications")} maxLength={1000} placeholder="e.g. Inhaler, kept in their bag" className={input} />
        </label>
        <label className="block">
          <span className={label}>Blood group</span>
          <select value={value.blood_group ?? ""} onChange={(e) => set({ blood_group: (e.target.value || null) as StudentHealthInput["blood_group"] })} className={input}>
            <option value="">Not known</option>
            {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={label}>Diet</span>
          <input {...text("dietary_needs")} maxLength={500} placeholder="e.g. Vegetarian, no pork" className={input} />
        </label>
        <label className="block">
          <span className={label}>Support needs</span>
          <input {...text("special_needs")} maxLength={1000} placeholder="e.g. Sits near the front (hearing)" className={input} />
        </label>
        <label className="block">
          <span className={label}>Family doctor</span>
          <input {...text("doctor_name")} maxLength={120} placeholder="Name or clinic" className={input} />
        </label>
        <label className="block">
          <span className={label}>Doctor's phone</span>
          <input {...text("doctor_phone")} maxLength={40} placeholder="e.g. 0712 345 678" className={input} />
        </label>
        <label className="block">
          <span className={label}>Emergency contact</span>
          <input {...text("emergency_name")} maxLength={120} placeholder="If parents can't be reached" className={input} />
        </label>
        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className={label}>Relationship</span>
            <input {...text("emergency_relationship")} maxLength={60} placeholder="e.g. Aunt" className={input} />
          </label>
          <label className="block">
            <span className={label}>Phone</span>
            <input {...text("emergency_phone")} maxLength={40} className={input} />
          </label>
        </div>
      </div>
      <label className="block">
        <span className={label}>Anything else the school should know</span>
        <textarea {...text("notes")} maxLength={2000} rows={2} className={`${input} resize-y`} />
      </label>
    </div>
  );
}

/** Chips with one-tap suggestions and free typing (Enter or comma adds). */
function ChipList({ title, items, suggestions, onChange, placeholder, danger }: {
  title: string; items: string[]; suggestions: string[]; onChange: (items: string[]) => void; placeholder: string; danger?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = (v: string) => { onChange(normaliseList([...items, ...splitList(v)])); setDraft(""); };
  const has = (v: string) => items.some((i) => i.toLowerCase() === v.toLowerCase());
  const chip = danger ? "bg-[#FBE9E6] text-[#9B2C1C]" : "bg-sunken text-ink";
  return (
    <div>
      <span className={label}>{title}</span>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5">
        {items.map((it) => (
          <span key={it} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold ${chip}`}>
            {it}
            <button type="button" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((x) => x !== it))} className="opacity-70 hover:opacity-100">×</button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && draft.trim()) { e.preventDefault(); add(draft); }
            if (e.key === "Backspace" && !draft && items.length) onChange(items.slice(0, -1));
          }}
          onBlur={() => { if (draft.trim()) add(draft); }}
          placeholder={items.length ? "" : placeholder}
          aria-label={title}
          className="min-w-[120px] flex-1 border-0 px-1 py-0.5 text-[13px] outline-none"
        />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {suggestions.filter((sg) => !has(sg)).map((sg) => (
          <button key={sg} type="button" onClick={() => add(sg)}
            className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-muted hover:border-forest hover:text-ink">
            + {sg}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Load, edit and save one learner's record: the Manage learner section, and the parent's child profile. */
export function HealthEditor({ tenantId, studentId, toast, title = "Health and bio", blurb }: {
  tenantId: string; studentId: string; toast: ToastFn; title?: string; blurb?: string;
}) {
  const [value, setValue] = useState<StudentHealthInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setValue(null);
    fetchStudentHealth(studentId)
      .then((h) => { if (alive) { setValue(healthToInput(h)); setUpdatedAt(h?.updated_at ?? null); } })
      .catch((err: Error) => { if (alive) setLoadError(err.message); });
    return () => { alive = false; };
  }, [studentId]);

  async function save() {
    if (!value) return;
    setSaving(true);
    try {
      const saved = await saveStudentHealth(tenantId, studentId, value);
      setValue(healthToInput(saved));
      setUpdatedAt(saved.updated_at);
      toast("Health details saved.");
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {blurb && <p className="mt-0.5 text-[12px] text-ink-muted">{blurb}</p>}
      <div className="mt-2">
        {loadError ? (
          <p className="text-[12.5px] text-warn-ink">Could not load health details: {loadError}</p>
        ) : !value ? (
          <p className="text-small text-ink-faint">Loading…</p>
        ) : (
          <>
            <HealthFields value={value} onChange={setValue} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save health details"}</Button>
              {updatedAt && <span className="text-[11.5px] text-ink-faint">Last updated {new Date(updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** For adding a learner: the fields folded away until wanted. */
export function OptionalHealthSection({ value, onChange }: { value: StudentHealthInput; onChange: (v: StudentHealthInput) => void }) {
  const [open, setOpen] = useState(!isHealthEmpty(value));
  return (
    <div className="rounded-lg border border-line-soft">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left">
        <span>
          <span className="block text-[13px] font-semibold">Health and bio (optional)</span>
          <span className="block text-[11.5px] text-ink-muted">Allergies, conditions, medication, emergency contact. Parents can fill this in later too.</span>
        </span>
        <span aria-hidden className="text-ink-faint">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="border-t border-line-soft px-3 py-3"><HealthFields value={value} onChange={onChange} /></div>}
    </div>
  );
}


/**
 * The chip on a class list: red "Allergy" (or amber "Medical") with the
 * details on click, so a teacher sees it while marking the register.
 */
export function HealthChip({ flags, name }: { flags: HealthFlags | null; name?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!flags) return null;
  const tone = flags.allergy ? "bg-[#FBE9E6] text-[#9B2C1C] border-[#F1C7BF]" : "bg-[#FDF3E1] text-[#8A5A0B] border-[#F0DDB8]";
  return (
    <span ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={flags.summary}
        aria-expanded={open}
        className={`rounded-full border px-1.5 py-px text-[10.5px] font-bold uppercase tracking-wide ${tone}`}
      >
        {flags.allergy ? "Allergy" : flags.medical ? "Medical" : "Diet"}
      </button>
      {open && (
        <span role="dialog" className="absolute right-0 top-full z-30 mt-1 block w-[260px] rounded-lg border border-line bg-white p-3 text-left text-[12px] font-normal normal-case leading-relaxed text-ink shadow-lg">
          {name && <span className="mb-1 block text-[12.5px] font-semibold">{name}</span>}
          {flags.summary.split(" · ").map((line) => <span key={line} className="block">{line}</span>)}
        </span>
      )}
    </span>
  );
}

/** healthFlags for a map of records, by student id. */
export function flagsById(records: Map<string, Parameters<typeof healthFlags>[0]>): Map<string, HealthFlags> {
  const out = new Map<string, HealthFlags>();
  for (const [id, h] of records) { const f = healthFlags(h); if (f) out.set(id, f); }
  return out;
}
