import { useState, type ChangeEvent } from "react";
import {
  LEVELS, LEVEL_ORDER, PATHWAY_LABEL, STRAND_CSV_TEMPLATE, TRACK_LABEL, coverageKey, fetchLearningAreas,
  fetchOfficialStrandCoverage, importOfficialStrands, parseStrandCsv, setLearningAreaVerified, updateLearningArea,
  yearLabel, type ClassLevel, type LearningArea, type StrandCsvResult,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

type ToastFn = ReturnType<typeof useToast>;

async function fetchCurriculum() {
  const [areas, coverage] = await Promise.all([fetchLearningAreas(), fetchOfficialStrandCoverage()]);
  return { areas, coverage };
}

/**
 * The KICD catalogue every school picks its CBE learning areas from. Figbloom
 * staff keep it right: check each learning area against KICD's official
 * curriculum design and mark it verified, and load the strands and
 * sub-strands for each grade from those designs by CSV. Schools see
 * unverified areas flagged "catalogue under review".
 */
export function Curriculum() {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchCurriculum(), [reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);
  const [importing, setImporting] = useState(false);
  const [levelFilter, setLevelFilter] = useState<ClassLevel | "all">("all");

  const areas = data?.areas ?? [];
  const verified = areas.filter((a) => a.verified_at).length;
  const gradeSlots = areas.reduce((n, a) => n + (a.max_grade - a.min_grade + 1), 0);
  const coveredSlots = areas.reduce((n, a) => {
    for (let g = a.min_grade; g <= a.max_grade; g++) if (data?.coverage.get(coverageKey(a.id, g))?.strands) n++;
    return n;
  }, 0);

  const levels = LEVEL_ORDER.filter((l) => LEVELS[l].track === "cbe" && (levelFilter === "all" || levelFilter === l));

  return (
    <>
      <PageHead
        eyebrow="Platform · curriculum"
        title="KICD curriculum"
        blurb="The learning areas and strands every CBE school picks from. Check each area against KICD's official curriculum design before marking it verified — schools see anything unverified as “catalogue under review”."
        actions={<Button variant="accent" onClick={() => setImporting(true)} disabled={!data}>Import strands (CSV)</Button>}
      />
      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the catalogue: {error.message}
          </p>
        ) : loading || !data ? (
          <div className="grid gap-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
        ) : (
          <div className="grid gap-6">
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <Stat label="Learning areas verified" value={`${verified} of ${areas.length}`} sub={verified === areas.length ? "All checked" : "Check against the KICD designs"} />
              <Stat label="Grades with strands" value={`${coveredSlots} of ${gradeSlots}`} sub="learning area × grade" />
            </div>

            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Band">
              {(["all", ...LEVEL_ORDER.filter((l) => LEVELS[l].track === "cbe")] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="tab"
                  aria-selected={levelFilter === l}
                  onClick={() => setLevelFilter(l)}
                  className="rounded-full border px-3 py-1.5 text-small"
                  style={levelFilter === l
                    ? { borderColor: "var(--accent)", background: "var(--accent)", color: "#fff", fontWeight: 600 }
                    : { borderColor: "#D3DAD5", background: "#fff", color: "#5F6B62" }}
                >
                  {l === "all" ? "All bands" : LEVELS[l].label}
                </button>
              ))}
            </div>

            {levels.map((level) => {
              const inLevel = areas.filter((a) => a.level === level);
              if (!inLevel.length) return null;
              return (
                <section key={level}>
                  <h2 className="mb-2 text-[14px] font-semibold">
                    {LEVELS[level].label} <span className="font-normal text-ink-faint">· {yearLabel(level, LEVELS[level].min)}–{yearLabel(level, LEVELS[level].max)}</span>
                  </h2>
                  <ul className="grid gap-1.5">
                    {inLevel.map((a) => <AreaRow key={a.id} area={a} coverage={data.coverage} onChanged={reload} toast={toast} />)}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {importing && data && (
        <ImportStrandsModal areas={areas} onClose={() => setImporting(false)} onImported={() => { setImporting(false); reload(); }} toast={toast} />
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <div className="text-[12px] text-ink-muted">{label}</div>
      <div className="mt-1 text-[20px] font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-faint">{sub}</div>
    </div>
  );
}

function AreaRow({ area, coverage, onChanged, toast }: {
  area: LearningArea; coverage: Map<string, { strands: number; subStrands: number }>; onChanged: () => void; toast: ToastFn;
}) {
  const [name, setName] = useState(area.name);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== area.name;
  const grades = Array.from({ length: area.max_grade - area.min_grade + 1 }, (_, i) => area.min_grade + i);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try { await fn(); toast(done); onChanged(); }
    catch (err) { toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save."); }
    finally { setBusy(false); }
  }

  return (
    <li className="grid items-center gap-x-3 gap-y-1.5 rounded-lg border border-line-soft px-3 py-2.5" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1.4fr) auto" }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={`Name of ${area.code}`}
            className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-1 text-[13px] font-medium outline-none hover:border-[#D3DAD5] focus:border-[#D3DAD5]"
          />
          {dirty && (
            <button type="button" disabled={busy || !name.trim()} onClick={() => void run(() => updateLearningArea(area.id, { name: name.trim() }), "Name saved.")}
              className="text-[11.5px] font-semibold text-leaf hover:underline disabled:opacity-50">Save</button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-1.5 text-[11px] text-ink-faint">
          <span className="font-mono">{area.code}</span>
          <span>·</span>
          <span>{yearLabel(area.level, area.min_grade)}{area.max_grade !== area.min_grade ? `–${yearLabel(area.level, area.max_grade)}` : ""}</span>
          {area.pathway ? (
            <><span>·</span><span>{PATHWAY_LABEL[area.pathway]}{area.track ? ` · ${TRACK_LABEL[area.track] ?? area.track}` : ""}</span></>
          ) : !area.is_core ? <><span>·</span><span>Alternative</span></> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {grades.map((g) => {
          const c = coverage.get(coverageKey(area.id, g));
          return (
            <span key={g} title={c ? `${c.strands} strands, ${c.subStrands} sub-strands` : "No strands loaded yet"}
              className="rounded-md border px-1.5 py-0.5 font-mono text-[10.5px]"
              style={c?.strands ? { borderColor: "#BFD8C8", background: "#E3EFE7", color: "#1B4D2E" } : { borderColor: "#E2E6E2", color: "#7B877F" }}>
              {yearLabel(area.level, g)} · {c?.strands ?? 0}/{c?.subStrands ?? 0}
            </span>
          );
        })}
      </div>
      <div className="flex items-center gap-2 justify-self-end">
        {area.verified_at ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>}
        <button type="button" disabled={busy}
          onClick={() => void run(() => setLearningAreaVerified(area.id, !area.verified_at), area.verified_at ? `${area.name} marked unverified.` : `${area.name} verified.`)}
          className="text-[11.5px] font-semibold text-leaf hover:underline disabled:opacity-50">
          {area.verified_at ? "Unverify" : "Mark verified"}
        </button>
      </div>
      {area.source && <div className="col-span-3 px-1.5 text-[11px] text-ink-faint">Source: {area.source}</div>}
    </li>
  );
}

function ImportStrandsModal({ areas, onClose, onImported, toast }: {
  areas: LearningArea[]; onClose: () => void; onImported: () => void; toast: ToastFn;
}) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [parsed, setParsed] = useState<StrandCsvResult | null>(null);
  const [saving, setSaving] = useState(false);

  async function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    setParsed(null);
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([STRAND_CSV_TEMPLATE + "\n"], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "kicd-strands-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function doImport() {
    if (!parsed || !parsed.strands.length) return;
    if (!source.trim()) { toast("Say which KICD design these strands come from."); return; }
    setSaving(true);
    try {
      const r = await importOfficialStrands(parsed.strands, source.trim());
      toast(`Added ${r.strandsAdded} strand${r.strandsAdded === 1 ? "" : "s"} and ${r.subStrandsAdded} sub-strand${r.subStrandsAdded === 1 ? "" : "s"}.`);
      onImported();
    } catch (err) {
      toast(err instanceof Error ? `Could not import: ${err.message}` : "Could not import.");
    } finally {
      setSaving(false);
    }
  }

  const subCount = parsed ? parsed.strands.reduce((n, s) => n + s.subStrands.length, 0) : 0;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Curriculum"
      title="Import strands"
      blurb="Copy the strands and sub-strands out of a KICD curriculum design, one row per sub-strand, in the order the design lists them. Re-importing a file only adds what's missing."
      width={680}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {parsed && parsed.strands.length > 0 ? (
            <Button variant="accent" onClick={() => void doImport()} disabled={saving}>
              {saving ? "Importing…" : `Import ${parsed.strands.length} strand${parsed.strands.length === 1 ? "" : "s"}`}
            </Button>
          ) : (
            <Button variant="accent" onClick={() => setParsed(parseStrandCsv(text, areas))} disabled={!text.trim()}>Check file</Button>
          )}
        </>
      }
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e)} className="text-[12.5px]" aria-label="CSV file" />
          <button type="button" onClick={downloadTemplate} className="text-[12px] font-semibold text-leaf hover:underline">Download template</button>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-semibold">…or paste it</span>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setParsed(null); }}
            rows={7}
            placeholder={STRAND_CSV_TEMPLATE}
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[12px] outline-none"
          />
          <span className="mt-1 block text-[11px] text-ink-faint">
            Columns: area_code, grade, strand, sub_strand (optional), strand_code (optional). Area codes are shown under each learning area, e.g. JS-ISC.
          </span>
        </label>
        <TextField id="strand-source" label="Source" placeholder="e.g. KICD Grade 7 Integrated Science curriculum design (rationalised, 2024)"
          value={source} onChange={(e) => setSource(e.target.value)} hint="Stored with every strand, so anyone can trace it back to the document." />
        {parsed && (
          <div className="rounded-lg border border-line-soft p-3 text-[12.5px]">
            <div className="font-semibold">
              {parsed.strands.length} strand{parsed.strands.length === 1 ? "" : "s"}, {subCount} sub-strand{subCount === 1 ? "" : "s"} ready
              {parsed.errors.length ? `, ${parsed.errors.length} line${parsed.errors.length === 1 ? "" : "s"} skipped` : ""}.
            </div>
            {parsed.errors.length > 0 && (
              <ul className="mt-2 grid max-h-[140px] gap-1 overflow-y-auto text-warn-ink">
                {parsed.errors.map((e) => <li key={e} className="flex gap-1.5"><span aria-hidden>✕</span>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
