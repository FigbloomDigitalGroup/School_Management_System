import { useState } from "react";
import {
  LEVELS, PATHWAY_LABEL, fetchLearningAreas, isValidYear, levelsForTenant, supabase, yearLabel, yearRangeLabel,
  type ClassLevel, type LearningArea, type Pathway, type Subject,
} from "@figbloom/shared";
import { Modal } from "../../components/ui/Modal";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast, type ToastFn } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

async function fetchSubjects(tenantId: string): Promise<Subject[]> {
  const { data, error } = await supabase().from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Quotes a field only if it needs it — a plain "History" or "CRE" stays bare. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function subjectsCsv(subjects: Subject[], unit: string): string {
  const rows = subjects.map((s) => [
    csvField(s.name),
    csvField(s.code),
    s.min_form_level ?? "",
    s.max_form_level ?? "",
    csvField(rangeLabel(s, unit)),
  ].join(","));
  return ["name,code,min_form_level,max_form_level,applies_to", ...rows].join("\n");
}

function downloadSubjectsCsv(subjects: Subject[], unit: string): void {
  const blob = new Blob([subjectsCsv(subjects, unit)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "subjects.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function rangeLabel(s: Subject, unit: string): string {
  if (s.level) {
    const lvl = s.level;
    const label = (n: number) => yearLabel(lvl, n);
    if (s.min_form_level == null && s.max_form_level == null) return `All of ${LEVELS[lvl].label.toLowerCase()}`;
    if (s.min_form_level != null && s.max_form_level != null) {
      return s.min_form_level === s.max_form_level ? `${label(s.min_form_level)} only` : yearRangeLabel(lvl, s.min_form_level, s.max_form_level);
    }
    return s.min_form_level != null ? `${label(s.min_form_level)} and up` : `Up to ${label(s.max_form_level!)}`;
  }
  if (s.min_form_level == null && s.max_form_level == null) return `Every ${unit.toLowerCase()}`;
  if (s.min_form_level != null && s.max_form_level != null) {
    return s.min_form_level === s.max_form_level ? `${unit} ${s.min_form_level} only` : `${unit} ${s.min_form_level}-${s.max_form_level}`;
  }
  return s.min_form_level != null ? `${unit} ${s.min_form_level} and up` : `Up to ${unit.toLowerCase()} ${s.max_form_level}`;
}

/**
 * The subject list itself, school-wide (FIG-406) — one shared list, not
 * duplicated per class. Until now the only place to create one was inside
 * a specific class's Subjects modal, which made a school-wide list feel
 * class-scoped even though it never was. Assigning who teaches a subject
 * IN a given class still happens there (Classes -> Subjects) — this screen
 * is only about the subject itself: its name, code, and which forms/grades
 * actually offer it (a class outside that range won't show it at all).
 */
export function AdminSubjects() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const unit = tenant.level === "primary" ? "Grade" : "Form";
  const [reloadKey, setReloadKey] = useState(0);
  const { data: subjects, loading, error } = useAsync(() => fetchSubjects(tenant.id), [tenant.id, reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [minForm, setMinForm] = useState("");
  const [maxForm, setMaxForm] = useState("");
  // "" = any level: the subject's bounds are compared against every class's year.
  const [level, setLevel] = useState<ClassLevel | "">("");
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkCreating, setBulkCreating] = useState(false);
  const [kicdOpen, setKicdOpen] = useState(false);

  function parseFormBound(raw: string): number | null {
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  async function createSubject() {
    if (!name.trim() || !code.trim()) { toast("Give the subject a name and a short code.", "error"); return; }
    const lo = parseFormBound(minForm), hi = parseFormBound(maxForm);
    if (level && [lo, hi].some((n) => n != null && !isValidYear(level, n))) {
      const { min, max } = LEVELS[level];
      toast(`${LEVELS[level].label} runs ${yearLabel(level, min)} to ${yearLabel(level, max)} — pick years in that range.`, "error");
      return;
    }
    setCreating(true);
    try {
      const { error: err } = await supabase().from("subjects").insert({
        tenant_id: tenant.id, name: name.trim(), code: code.trim().toUpperCase(), is_core: true,
        level: level || null, min_form_level: lo, max_form_level: hi,
      });
      if (err) throw err;
      toast(`${name.trim()} added.`);
      setName(""); setCode(""); setMinForm(""); setMaxForm(""); setLevel("");
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not add the subject: ${err.message}` : "Could not add the subject.", "error");
    } finally {
      setCreating(false);
    }
  }

  /** One per line: "Name", "Name,CODE", or "Name,CODE,MIN-MAX" (a single
   *  number instead of a range means "only that one form/grade"). */
  async function createBulkSubjects() {
    const takenCodes = new Set((subjects ?? []).map((s) => s.code.toUpperCase()));
    const takenNames = new Set((subjects ?? []).map((s) => s.name.trim().toLowerCase()));
    const uniqueCode = (base: string) => {
      const stem = base.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "SUBJ";
      let candidate = stem;
      let n = 2;
      while (takenCodes.has(candidate)) { candidate = `${stem}${n}`; n++; }
      takenCodes.add(candidate);
      return candidate;
    };

    const toCreate: { name: string; code: string; min: number | null; max: number | null }[] = [];
    for (const raw of bulkText.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const [rawName, rawCode, rawRange] = line.split(",").map((p) => p.trim());
      const subjName = rawName ?? "";
      if (!subjName || takenNames.has(subjName.toLowerCase())) continue;
      takenNames.add(subjName.toLowerCase());
      let min: number | null = null;
      let max: number | null = null;
      if (rawRange) {
        const [a, b] = rawRange.split("-").map((p) => parseFormBound(p.trim()));
        min = a ?? null;
        max = b ?? a ?? null;
      }
      toCreate.push({ name: subjName, code: rawCode ? uniqueCode(rawCode) : uniqueCode(subjName), min, max });
    }
    if (toCreate.length === 0) { toast("Nothing new to add — check the names aren't already on file.", "error"); return; }

    setBulkCreating(true);
    try {
      const { error: err } = await supabase().from("subjects").insert(
        toCreate.map((s) => ({ tenant_id: tenant.id, name: s.name, code: s.code, is_core: true, min_form_level: s.min, max_form_level: s.max })),
      );
      if (err) throw err;
      toast(`${toCreate.length} subject${toCreate.length === 1 ? "" : "s"} added.`);
      setBulkText("");
      setBulkOpen(false);
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not add those subjects: ${err.message}` : "Could not add those subjects.", "error");
    } finally {
      setBulkCreating(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="School · subjects"
        title="Subjects"
        blurb={
          subjects
            ? `${subjects.length} subject${subjects.length === 1 ? "" : "s"} offered at this school. Assign who teaches one in a specific class under Classes → Subjects.`
            : "Loading subjects…"
        }
        actions={
          <>
            {subjects && subjects.length > 0 && <Button onClick={() => downloadSubjectsCsv(subjects, unit)}>Export CSV</Button>}
            <Button variant="accent" onClick={() => setKicdOpen(true)} disabled={!subjects}>Add from KICD</Button>
          </>
        }
      />
      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load subjects: {error.message}
          </p>
        ) : loading || !subjects ? (
          <TableSkeleton rows={6} />
        ) : (
          <div className="grid max-w-[720px] gap-4">
            {subjects.length === 0 ? (
              <p className="text-[12.5px] text-ink-muted">No subjects yet — add the school's first one below.</p>
            ) : (
              <ul className="grid gap-1.5">
                {subjects.map((s) => (
                  <SubjectRow key={s.id} subject={s} unit={unit} onSaved={reload} toast={toast} />
                ))}
              </ul>
            )}

            <div className="grid gap-2.5 rounded-lg border border-line-soft bg-white p-3.5">
              <h2 className="text-[13px] font-semibold">New subject</h2>
              <div className="grid gap-2.5" style={{ gridTemplateColumns: "1.6fr 0.8fr 1.2fr 0.8fr 0.8fr" }}>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-semibold">Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Computer Studies"
                    className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-semibold">Code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="COMP"
                    className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 font-mono text-[13px] outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-semibold">Level</span>
                  <select value={level} onChange={(e) => setLevel(e.target.value as ClassLevel | "")}
                    className="w-full rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5 text-[13px]">
                    <option value="">Any level</option>
                    {levelsForTenant(tenant.level).map((l) => <option key={l} value={l}>{LEVELS[l].label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-semibold">From {level ? "year" : unit.toLowerCase()}</span>
                  <input value={minForm} onChange={(e) => setMinForm(e.target.value)} placeholder="Any" inputMode="numeric"
                    className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-semibold">To {level ? "year" : unit.toLowerCase()}</span>
                  <input value={maxForm} onChange={(e) => setMaxForm(e.target.value)} placeholder="Any" inputMode="numeric"
                    className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
                </label>
              </div>
              <p className="text-[11px] text-ink-faint">
                {level
                  ? `Years are numbered as ${LEVELS[level].label.toLowerCase()} numbers them (${yearLabel(level, LEVELS[level].min)} is ${LEVELS[level].min}). Leave blank for all of ${LEVELS[level].label.toLowerCase()}.`
                  : `Leave "From"/"To" blank for a subject every class offers, regardless of ${unit.toLowerCase()}.`}
              </p>
              <Button className="justify-self-start" onClick={() => void createSubject()} disabled={creating}>
                {creating ? "Adding…" : "Add subject"}
              </Button>
            </div>

            <button
              type="button"
              onClick={() => setBulkOpen((v) => !v)}
              className="justify-self-start text-[12px] font-semibold text-leaf hover:underline"
            >
              {bulkOpen ? "Hide bulk add" : "Bulk add multiple subjects"}
            </button>

            {bulkOpen && (
              <div className="grid gap-2 rounded-lg border border-line-soft bg-white p-3.5">
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-semibold">One subject per line</span>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder={"Chemistry\nHistory,HIST\nComputer Studies,COMP,1-2"}
                    rows={5}
                    className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none"
                  />
                  <span className="mt-1 block text-[11px] text-ink-faint">
                    "Name", "Name,CODE", or "Name,CODE,{unit.toUpperCase()}RANGE" (e.g. "1-2", or just "3" for one {unit.toLowerCase()} only) — a code
                    left out is generated from the name, a range left out means every {unit.toLowerCase()}.
                  </span>
                </label>
                <Button variant="primary" className="justify-self-start" onClick={() => void createBulkSubjects()} disabled={bulkCreating || !bulkText.trim()}>
                  {bulkCreating ? "Adding…" : "Add these subjects"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {kicdOpen && subjects && (
        <AddFromKicdModal
          existing={subjects}
          onClose={() => setKicdOpen(false)}
          onAdded={(n) => { setKicdOpen(false); toast(`${n} learning area${n === 1 ? "" : "s"} added.`); reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

/**
 * Picks KICD learning areas (Platform > Curriculum) into this school's
 * subjects, linked by learning_area_id so strands and CBE assessment can
 * find them. Only the bands this kind of school runs are offered; areas
 * already added are shown ticked and locked.
 */
function AddFromKicdModal({ existing, onClose, onAdded, toast }: {
  existing: Subject[]; onClose: () => void; onAdded: (count: number) => void; toast: ToastFn;
}) {
  const { tenant } = useTenantSession();
  const levels = levelsForTenant(tenant.level).filter((l) => LEVELS[l].track === "cbe");
  const { data: areas, loading, error } = useAsync(() => fetchLearningAreas(), []);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const linked = new Set(existing.map((s) => s.learning_area_id).filter(Boolean));
  const offered = (areas ?? []).filter((a) => levels.includes(a.level));

  function toggle(id: string) {
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function add() {
    const chosen = offered.filter((a) => picked.has(a.id));
    if (!chosen.length) return;
    const taken = new Set(existing.map((s) => s.code.toUpperCase()));
    const codeFor = (base: string) => { let c = base, n = 2; while (taken.has(c)) c = `${base}-${n++}`; taken.add(c); return c; };
    setSaving(true);
    try {
      const { error: err } = await supabase().from("subjects").insert(chosen.map((a) => ({
        tenant_id: tenant.id, name: a.name, code: codeFor(a.code), is_core: a.is_core,
        level: a.level, min_form_level: a.min_grade, max_form_level: a.max_grade, learning_area_id: a.id,
      })));
      if (err) throw err;
      onAdded(chosen.length);
    } catch (err) {
      toast(err instanceof Error ? `Could not add those learning areas: ${err.message}` : "Could not add those learning areas.", "error");
    } finally {
      setSaving(false);
    }
  }

  const groups: { key: string; title: string; items: LearningArea[] }[] = [];
  for (const level of levels) {
    const inLevel = offered.filter((a) => a.level === level);
    const bands = [...new Set(inLevel.map((a) => `${a.min_grade}-${a.max_grade}`))];
    for (const band of bands) {
      const inBand = inLevel.filter((a) => `${a.min_grade}-${a.max_grade}` === band);
      const [lo, hi] = band.split("-").map(Number) as [number, number];
      const core = inBand.filter((a) => !a.pathway);
      if (core.length) groups.push({ key: `${level}-${band}`, title: `${LEVELS[level].label} · ${yearRangeLabel(level, lo, hi)}`, items: core });
      for (const p of Object.keys(PATHWAY_LABEL) as Pathway[]) {
        const electives = inBand.filter((a) => a.pathway === p);
        if (electives.length) groups.push({ key: `${level}-${band}-${p}`, title: `${LEVELS[level].label} electives · ${PATHWAY_LABEL[p]}`, items: electives });
      }
    }
  }
  const unverified = offered.some((a) => !a.verified_at);

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Subjects"
      title="Add from the KICD curriculum"
      blurb="Tick the learning areas your school teaches. Each becomes a subject for the right grades, linked to KICD's strands for CBE assessment."
      width={680}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void add()} disabled={saving || picked.size === 0}>
            {saving ? "Adding…" : picked.size ? `Add ${picked.size} learning area${picked.size === 1 ? "" : "s"}` : "Add learning areas"}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load the catalogue: {error.message}</p>
      ) : loading || !areas ? (
        <TableSkeleton rows={6} />
      ) : !levels.length || !groups.length ? (
        <p className="text-[12.5px] text-ink-muted">The KICD catalogue has nothing for the levels this school runs yet.</p>
      ) : (
        <div className="grid gap-4">
          {unverified && (
            <p className="rounded-md bg-sunken px-3 py-2 text-[12px] text-ink-muted">
              Parts of this list are still being checked against KICD's official curriculum designs, so a name may change. Anything you add stays linked and picks up corrections.
            </p>
          )}
          {groups.map((g) => (
            <section key={g.key}>
              <h3 className="mb-1.5 text-[12.5px] font-semibold">{g.title}</h3>
              <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                {g.items.map((a) => {
                  const done = linked.has(a.id);
                  return (
                    <label key={a.id} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${done ? "text-ink-faint" : "hover:bg-page"}`}>
                      <input type="checkbox" checked={done || picked.has(a.id)} disabled={done} onChange={() => toggle(a.id)} style={{ accentColor: "#17402A" }} />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      {done ? <span className="text-[11px]">added</span> : !a.is_core && !a.pathway ? <span className="text-[11px] text-ink-faint">alternative</span> : null}
                    </label>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

function SubjectRow({ subject, unit, onSaved, toast }: {
  subject: Subject; unit: string; onSaved: () => void; toast: ToastFn;
}) {
  const [name, setName] = useState(subject.name);
  const [code, setCode] = useState(subject.code);
  const [minForm, setMinForm] = useState(subject.min_form_level != null ? String(subject.min_form_level) : "");
  const [maxForm, setMaxForm] = useState(subject.max_form_level != null ? String(subject.max_form_level) : "");
  const [saving, setSaving] = useState(false);

  const dirty = name.trim() !== subject.name
    || code.trim().toUpperCase() !== subject.code
    || minForm !== (subject.min_form_level != null ? String(subject.min_form_level) : "")
    || maxForm !== (subject.max_form_level != null ? String(subject.max_form_level) : "");

  async function save() {
    if (!name.trim() || !code.trim()) { toast("A subject needs both a name and a code.", "error"); return; }
    setSaving(true);
    try {
      const parse = (raw: string) => { const n = parseInt(raw.trim(), 10); return Number.isFinite(n) ? n : null; };
      const { error: err } = await supabase().from("subjects").update({
        name: name.trim(), code: code.trim().toUpperCase(),
        min_form_level: parse(minForm), max_form_level: parse(maxForm),
      }).eq("id", subject.id);
      if (err) throw err;
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line-soft px-3 py-2">
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Subject name"
        className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-1 text-[13px] font-medium outline-none hover:border-[#D3DAD5] focus:border-[#D3DAD5]" />
      <input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Subject code"
        className="w-16 rounded-md border border-transparent px-1.5 py-1 font-mono text-[11px] uppercase text-ink-faint outline-none hover:border-[#D3DAD5] focus:border-[#D3DAD5]" />
      <input value={minForm} onChange={(e) => setMinForm(e.target.value)} placeholder="Any" inputMode="numeric" aria-label={`From ${unit.toLowerCase()}`}
        className="w-14 rounded-md border border-[#D3DAD5] px-1.5 py-1 text-center text-[11.5px] outline-none" />
      <span className="text-ink-faint">–</span>
      <input value={maxForm} onChange={(e) => setMaxForm(e.target.value)} placeholder="Any" inputMode="numeric" aria-label={`To ${unit.toLowerCase()}`}
        className="w-14 rounded-md border border-[#D3DAD5] px-1.5 py-1 text-center text-[11.5px] outline-none" />
      <span className="text-[11px] text-ink-faint">{rangeLabel({ ...subject, min_form_level: parseInt(minForm, 10) || null, max_form_level: parseInt(maxForm, 10) || null }, unit)}</span>
      {dirty && (
        <button type="button" onClick={() => void save()} disabled={saving} className="text-[11.5px] font-semibold text-leaf hover:underline disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      )}
    </li>
  );
}
