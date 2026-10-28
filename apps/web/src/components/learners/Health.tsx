import { useEffect, useRef, useState } from "react";
import {
  BLOOD_GROUPS, COMMON_ALLERGIES, COMMON_CONDITIONS, describeHealthConsent, fetchHealthConsent, fetchStudentHealth,
  HEALTH_CONSENT_NO_PRESSURE, HEALTH_CONSENT_PURPOSE, HEALTH_CONSENT_WITHDRAW_WARNING, healthFlags, healthToInput, isHealthEmpty,
  localDay, normaliseList, saveStudentHealth, setHealthConsent, splitList, type HealthConsent, type HealthFlags, type StudentHealthInput,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import type { ToastFn } from "../ui/Toast";
import { HEALTH_CONSENT_EVENT } from "./HealthConsentRequests";

/**
 * Health and bio details (student_health): the form, the Manage learner /
 * parent editor around it, and the small red chip a teacher sees on a class
 * list. Nothing here is required. Health details need a parent's or
 * guardian's consent first (healthConsent.ts); contacts don't.
 */

const input = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none";
const label = "mb-1 block text-[11.5px] font-semibold";

/**
 * The form. healthLocked (no consent on file) leaves only the family doctor
 * and emergency contact, which consent doesn't cover.
 */
export function HealthFields({ value, onChange, healthLocked }: {
  value: StudentHealthInput; onChange: (v: StudentHealthInput) => void; healthLocked?: boolean;
}) {
  const set = (patch: Partial<StudentHealthInput>) => onChange({ ...value, ...patch });
  const text = (k: keyof StudentHealthInput) => ({
    value: (value[k] as string | null) ?? "",
    onChange: (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<StudentHealthInput>),
  });

  const contacts = (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
  );
  if (healthLocked) return contacts;

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
      </div>
      <label className="block">
        <span className={label}>Anything else the school should know</span>
        <textarea {...text("notes")} maxLength={2000} rows={2} className={`${input} resize-y`} />
      </label>
      {contacts}
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

/**
 * Load, edit and save one learner's record, behind the family's consent:
 * mode "office" is the Manage learner section, "parent" the parent's child
 * profile. Without consent only the doctor and emergency contact can be
 * edited, and details saved before consent was asked for show read-only.
 */
export function HealthEditor({ tenantId, studentId, toast, title = "Health and bio", blurb, mode = "office" }: {
  tenantId: string; studentId: string; toast: ToastFn; title?: string; blurb?: string; mode?: "office" | "parent";
}) {
  const [value, setValue] = useState<StudentHealthInput | null>(null);
  const [consent, setConsent] = useState<HealthConsent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setValue(null);
    Promise.all([fetchStudentHealth(studentId), fetchHealthConsent(studentId)])
      .then(([h, c]) => { if (alive) { setValue(healthToInput(h)); setUpdatedAt(h?.updated_at ?? null); setConsent(c); } })
      .catch((err: Error) => { if (alive) setLoadError(err.message); });
    return () => { alive = false; };
  }, [studentId, reload]);

  const given = consent?.status === "given";

  async function save(next: StudentHealthInput, done = "Health details saved.") {
    setSaving(true);
    try {
      const saved = await saveStudentHealth(tenantId, studentId, next);
      setValue(healthToInput(saved));
      setUpdatedAt(saved.updated_at);
      toast(done);
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function decide(give: boolean, paper?: { signedBy: string; formDate?: string | null }) {
    if (!give && !window.confirm(`${HEALTH_CONSENT_WITHDRAW_WARNING} Continue?`)) return;
    setSaving(true);
    try {
      await setHealthConsent(studentId, give, paper);
      toast(give ? "Consent recorded. Health details can be added now." : "Consent withdrawn. The health details were deleted.");
      setReload((n) => n + 1);
      window.dispatchEvent(new Event(HEALTH_CONSENT_EVENT));
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  function withdrawForParent() {
    const who = window.prompt("Which parent or guardian asked to withdraw consent?");
    if (who?.trim()) void decide(false, { signedBy: who.trim() });
  }

  const flags = value ? healthFlags(value) : null;
  const legacy = !given && !!consent?.hasDetails && value;

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
            {consent && !given && (
              mode === "parent"
                ? <ParentConsentAsk hasDetails={consent.hasDetails} busy={saving} onAgree={() => void decide(true)} onRemove={() => void decide(false)} />
                : <OfficeConsentRecord consent={consent} busy={saving} onRecord={(paper) => void decide(true, paper)} />
            )}
            {legacy && (
              <div className="mb-3 rounded-md border border-[#F0DDB8] bg-[#FDF3E1] px-3 py-2 text-[12.5px] text-[#5c4a14]">
                <p className="font-semibold">On file from before consent was recorded</p>
                <p className="mt-0.5">{flags ? flags.summary : "Notes or a blood group only."}{value.blood_group ? ` · Blood group ${value.blood_group}` : ""}</p>
                {mode === "office" && (
                  <button type="button" disabled={saving} className="mt-1 text-[12px] font-semibold underline"
                    onClick={() => {
                      if (window.confirm("Delete these health details? The family doctor and emergency contact are kept.")) {
                        void save({ ...value, allergies: [], medical_conditions: [], medications: null, blood_group: null, dietary_needs: null, special_needs: null, notes: null }, "Health details deleted.").then(() => setReload((n) => n + 1));
                      }
                    }}>
                    Delete these details
                  </button>
                )}
              </div>
            )}
            {given && consent && (
              <p className="mb-2 text-[11.5px] text-ink-faint">
                Consent: {describeHealthConsent(consent)}.{" "}
                <button type="button" disabled={saving} className="font-semibold text-ink-muted underline"
                  onClick={() => (mode === "parent" ? void decide(false) : withdrawForParent())}>
                  Withdraw consent
                </button>
              </p>
            )}
            <HealthFields value={value} onChange={setValue} healthLocked={!given} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => void save(value, given ? "Health details saved." : "Contacts saved.")} disabled={saving}>
                {saving ? "Saving…" : given ? "Save health details" : "Save contacts"}
              </Button>
              {updatedAt && <span className="text-[11.5px] text-ink-faint">Last updated {new Date(updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The parent's choice, before any health details can be added. */
function ParentConsentAsk({ hasDetails, busy, onAgree, onRemove }: {
  hasDetails: boolean; busy: boolean; onAgree: () => void; onRemove: () => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-line bg-sunken px-3 py-3 text-[12.5px] leading-relaxed">
      <p className="font-semibold">
        {hasDetails ? "The school has health details on file for your child. Do you agree to the school keeping them?" : "Would you like to share your child's health details with the school?"}
      </p>
      <p className="mt-1 text-ink-muted">{HEALTH_CONSENT_PURPOSE}</p>
      <p className="mt-1 text-ink-muted">{HEALTH_CONSENT_NO_PRESSURE}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onAgree} disabled={busy}>I agree</Button>
        {hasDetails && <Button onClick={onRemove} disabled={busy}>No, delete them</Button>}
      </div>
    </div>
  );
}

/** The office records consent from a signed form; a parent can also agree in their app. */
function OfficeConsentRecord({ consent, busy, onRecord }: {
  consent: HealthConsent; busy: boolean; onRecord: (paper: { signedBy: string; formDate: string }) => void;
}) {
  const [signedBy, setSignedBy] = useState("");
  const [formDate, setFormDate] = useState(localDay(new Date()));
  return (
    <div className="mb-3 rounded-md border border-line bg-sunken px-3 py-3 text-[12.5px] leading-relaxed">
      <p className="font-semibold">{consent.status === "withdrawn" ? `Consent ${describeHealthConsent(consent).toLowerCase()}.` : "No consent on file for health details."}</p>
      <p className="mt-0.5 text-ink-muted">
        A parent or guardian can agree in their app, or you can record a signed consent form here. Families who say no are treated the same.
      </p>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "1.4fr 1fr auto" }}>
        <label className="block">
          <span className={label}>Signed by</span>
          <input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} maxLength={120} placeholder="Parent or guardian's name" className={input} />
        </label>
        <label className="block">
          <span className={label}>Date on the form</span>
          <input type="date" value={formDate} max={localDay(new Date())} onChange={(e) => setFormDate(e.target.value)} className={input} />
        </label>
        <div className="flex items-end">
          <Button onClick={() => onRecord({ signedBy: signedBy.trim(), formDate })} disabled={busy || !signedBy.trim() || !formDate}>Record consent</Button>
        </div>
      </div>
    </div>
  );
}

/** What adding a learner records when the family has signed a consent form. */
export interface PaperConsent { signedBy: string; formDate: string }

/**
 * For adding a learner: the fields folded away until wanted. Health details
 * need a signed consent form (paper non-null); the doctor and emergency
 * contact don't.
 */
export function OptionalHealthSection({ value, onChange, paper, onPaper }: {
  value: StudentHealthInput; onChange: (v: StudentHealthInput) => void; paper: PaperConsent | null; onPaper: (p: PaperConsent | null) => void;
}) {
  const [open, setOpen] = useState(!isHealthEmpty(value));
  return (
    <div className="rounded-lg border border-line-soft">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left">
        <span>
          <span className="block text-[13px] font-semibold">Health and bio (optional)</span>
          <span className="block text-[11.5px] text-ink-muted">Emergency contact, and health details if the family has signed a consent form. Parents can also agree and fill this in later.</span>
        </span>
        <span aria-hidden className="text-ink-faint">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-line-soft px-3 py-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={!!paper} style={{ accentColor: "#17402A" }} className="mt-0.5"
              onChange={(e) => {
                if (e.target.checked) onPaper({ signedBy: "", formDate: localDay(new Date()) });
                else {
                  onPaper(null);
                  onChange({ ...value, allergies: [], medical_conditions: [], medications: null, blood_group: null, dietary_needs: null, special_needs: null, notes: null });
                }
              }} />
            <span className="text-[12.5px]">A parent or guardian has signed a form agreeing to the school keeping health details</span>
          </label>
          {paper && (
            <div className="grid gap-2" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
              <label className="block">
                <span className={label}>Signed by</span>
                <input value={paper.signedBy} onChange={(e) => onPaper({ ...paper, signedBy: e.target.value })} maxLength={120} placeholder="Parent or guardian's name" className={input} />
              </label>
              <label className="block">
                <span className={label}>Date on the form</span>
                <input type="date" value={paper.formDate} max={localDay(new Date())} onChange={(e) => onPaper({ ...paper, formDate: e.target.value })} className={input} />
              </label>
            </div>
          )}
          <HealthFields value={value} onChange={onChange} healthLocked={!paper} />
        </div>
      )}
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
