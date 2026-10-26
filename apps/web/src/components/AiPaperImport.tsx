import { useState } from "react";
import {
  IMPORT_ACCEPT, IMPORT_MAX_IMAGES, checkImportFiles, importPaperWithAi, type PaperImportDraft,
} from "@figbloom/shared";
import { Button } from "./ui/Button";
import { SelectField, TextArea } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { curriculumFromClassName } from "./AiQuestions";
import { AI_DRAFT_NOTE } from "../lib/useAi";
import { useTenantSession } from "../lib/sessionContext";
import { UPLOAD_LIMIT_BYTES } from "../lib/uploadLimit";
import { removePaperImportFiles, uploadPaperImportFiles } from "../lib/uploads";

/**
 * Bloom reads a paper the teacher already has (PDF, Word, or photos of the
 * printed pages) and fills in the paper editor with its questions, keys and
 * marks. Every question it wasn't sure of is flagged there for the teacher
 * to check; nothing is saved until they press Save.
 */
export function AiPaperImportModal({ subject, className, kind, hasQuestions, onImported, onClose }: {
  subject: string;
  className: string;
  kind: "exam" | "assessment";
  /** The paper already has questions: offer to add to them or replace them. */
  hasQuestions: boolean;
  onImported: (draft: PaperImportDraft, replace: boolean) => void;
  onClose: () => void;
}) {
  const { profile, tenant } = useTenantSession();
  const [files, setFiles] = useState<File[]>([]);
  const [curriculum, setCurriculum] = useState<"844" | "cbc">(curriculumFromClassName(className));
  const [notes, setNotes] = useState("");
  const [replace, setReplace] = useState(false);
  const [step, setStep] = useState<"" | "uploading" | "reading">("");
  const [error, setError] = useState("");

  async function run() {
    const problem = checkImportFiles(files)
      ?? (files.some((f) => f.size > UPLOAD_LIMIT_BYTES) ? `Each file can be up to ${Math.floor(UPLOAD_LIMIT_BYTES / 1024 ** 2)} MB.` : null);
    if (problem) { setError(problem); return; }
    if (!subject || !className) { setError("Pick the class and subject in the paper first."); return; }
    setError("");
    setStep("uploading");
    let paths: string[] = [];
    try {
      paths = await uploadPaperImportFiles({ tenantId: tenant.id, profileId: profile.id, files });
      setStep("reading");
      const draft = await importPaperWithAi({
        paths, subject, classLabel: className, curriculum, kind, notes: notes.trim() || undefined,
      });
      if (!draft.questions.length) {
        throw new Error(draft.warnings[0] ?? "Bloom didn't find any questions in that file. Check it's the right paper.");
      }
      onImported(draft, replace);
    } catch (err) {
      // Bloom deletes the file once read; this covers a request that never reached it.
      await removePaperImportFiles(paths).catch(() => {});
      setError(err instanceof Error ? err.message : "Could not import the paper.");
      setStep("");
    }
  }

  const busy = step !== "";

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      eyebrow={`${className || "Pick a class"} · ${subject || "pick a subject"}`}
      title="Import a paper with Bloom"
      blurb="Upload a paper you already have. Bloom types out its questions, options, marks and any marking scheme into this paper, and flags anything you should check."
      footNote={`${AI_DRAFT_NOTE} Your file is deleted once Bloom has read it.`}
      width={560}
      actions={
        <>
          <Button disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={busy || !files.length} onClick={() => void run()}>
            {step === "uploading" ? "Uploading…" : step === "reading" ? "Reading the paper… (up to 3 minutes)" : "Import paper"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div>
          <label htmlFor="aip-file" className="mb-1.5 block text-small font-semibold">The paper</label>
          <input
            id="aip-file" type="file" multiple accept={IMPORT_ACCEPT} disabled={busy}
            onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setError(""); }}
            className="text-[12.5px]"
          />
          <p className="mt-1 text-[11.5px] text-ink-faint">
            One PDF or Word (.docx) file, or up to {IMPORT_MAX_IMAGES} clear photos of the pages, in order. Include the marking scheme if you have it, and Bloom will fill in the answers.
          </p>
        </div>
        <SelectField id="aip-curriculum" label="Curriculum" value={curriculum} disabled={busy} onChange={(e) => setCurriculum(e.target.value as typeof curriculum)}
          options={[{ value: "cbc", label: "CBC" }, { value: "844", label: "8-4-4 (KCSE)" }]} />
        <TextArea id="aip-notes" label="Anything Bloom should know (optional)" disabled={busy}
          placeholder="e.g. Only import Section B. The answers are on the last page." value={notes} onChange={(e) => setNotes(e.target.value)} />
        {hasQuestions && (
          <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
            <input type="checkbox" checked={replace} disabled={busy} onChange={(e) => setReplace(e.target.checked)} />
            Replace the questions already in this paper (otherwise they're added at the end)
          </label>
        )}
        {error && <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
      </div>
    </Modal>
  );
}
