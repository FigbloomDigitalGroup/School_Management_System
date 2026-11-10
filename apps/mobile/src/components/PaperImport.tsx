import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { CircleAlert } from "lucide-react-native";
import {
  AI_DRAFT_NOTE, IMPORT_MAX_IMAGES, checkImportFiles, curriculumFromClassName, formatFileSize, importPaperWithAi,
  type PaperImportDraft, type PaperKind,
} from "@figbloom/shared";
import { PAPER_IMPORT_FILES, pickFile, readPickedFile, type FileSource, type PickedFile } from "../lib/pickFile";
import { removePaperImportFiles, uploadPaperImportFiles } from "../lib/uploads";
import { accentFor } from "../theme";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";
import { AttachChoices } from "./AttachChoices";
import { PillPicker } from "./PillPicker";

const CURRICULA = [{ id: "cbc", name: "CBC" }, { id: "844", name: "8-4-4 (KCSE)" }];

/**
 * Bloom reads a paper the teacher already has (a PDF, a Word file, or photos of the printed pages) and hands back
 * its questions, options, marks and any marking scheme, flagged wherever it was not sure. The questions go into the
 * paper being edited for the teacher to check; nothing is saved until they save the paper. The pages go up to the
 * teacher's own folder, Bloom deletes them once read, and they are taken down again here if the request never
 * reached it. Reading can take a few minutes, so the card says so and the screen asks before it is left.
 */
export function PaperImport({ session, subject, className, kind, hasQuestions, onImported, onBusy, onClose }: {
  session: { tenantId: string; profileId: string; accent: string };
  subject: string;
  className: string;
  kind: PaperKind;
  /** The paper already has questions: offer to add to them or replace them. */
  hasQuestions: boolean;
  onImported: (draft: PaperImportDraft, replace: boolean) => void;
  /** Tells the screen the import is in progress, so it can ask before being left. */
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const { t, s, fieldLine, accentInk } = useTheme();
  const a = accentFor(session.accent);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [curriculum, setCurriculum] = useState<"844" | "cbc">(curriculumFromClassName(className));
  const [notes, setNotes] = useState("");
  const [replace, setReplace] = useState(false);
  const [step, setStep] = useState<"" | "uploading" | "reading">("");
  const [error, setError] = useState("");
  const busy = step !== "";
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const asCheckable = (list: PickedFile[]) => list.map((f) => ({ name: f.name, size: f.sizeBytes ?? 1, type: f.mimeType }));

  async function add(source: FileSource) {
    setError("");
    try {
      const picked = await pickFile(source, PAPER_IMPORT_FILES, { maxPixels: 2400 });
      if (!picked) return;
      const next = [...files, picked];
      const problem = checkImportFiles(asCheckable(next));
      if (problem) { setError(problem); return; }
      setFiles(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that file.");
    }
  }

  async function run() {
    if (!subject || !className) { setError("Pick the class and subject in the paper first."); return; }
    const early = checkImportFiles(asCheckable(files));
    if (early) { setError(early); return; }
    setError("");
    setStep("uploading");
    onBusy(true);
    let paths: string[] = [];
    try {
      // The phone does not always say how big a file is, so the limits are checked again on what was actually read.
      const read = [];
      for (const f of files) read.push(await readPickedFile(f));
      const problem = checkImportFiles(read.map((r) => ({ name: r.name, size: r.blob.size, type: r.mimeType })));
      if (problem) throw new Error(problem);
      paths = await uploadPaperImportFiles({ tenantId: session.tenantId, profileId: session.profileId, files: read });
      if (mounted.current) setStep("reading");
      const draft = await importPaperWithAi({ paths, subject, classLabel: className, curriculum, kind, notes: notes.trim() || undefined });
      if (!draft.questions.length) throw new Error(draft.warnings[0] ?? "Bloom didn't find any questions in that file. Check it's the right paper.");
      onImported(draft, replace);
    } catch (err) {
      // Bloom deletes a page once it has read it; this covers a request that never got that far.
      await removePaperImportFiles(paths).catch(() => {});
      if (mounted.current) { setError(err instanceof Error ? err.message : "Could not import the paper."); setStep(""); }
    } finally {
      onBusy(false);
    }
  }

  return (
    <View style={[s.card, { gap: 12, borderWidth: 1, borderColor: fieldLine }]}>
      <View>
        <Text style={[s.eyebrow, { color: t.appSurface.inkFaint }]}>{(className || "Pick a class").toUpperCase()} · {subject || "pick a subject"}</Text>
        <Text style={[s.h2, { marginTop: 2 }]}>Import a paper with Bloom</Text>
        <Text style={[s.small, { marginTop: 4 }]}>
          Choose a paper you already have. Bloom types out its questions, options, marks and any marking scheme into this paper, and flags anything you should check.
        </Text>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink }]}>The paper</Text>
        <Text style={s.faint}>
          One PDF or Word (.docx) file, or up to {IMPORT_MAX_IMAGES} clear photos of the pages, in order. Include the marking scheme if you have it, and Bloom will fill in the answers.
        </Text>
        <AttachChoices onChoose={(source) => void add(source)} disabled={busy} />
        {files.map((f, i) => (
          <View key={`${f.uri}-${i}`} style={[s.row, { gap: 8 }]}>
            <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>{f.name}{f.sizeBytes ? ` · ${formatFileSize(f.sizeBytes)}` : ""}</Text>
            <Button variant="quiet" tint={t.status.warnInk} label="Remove" accessibilityHint={f.name} disabled={busy} onPress={() => setFiles(files.filter((_, j) => j !== i))} style={{ paddingHorizontal: 8 }} />
          </View>
        ))}
      </View>

      <View>
        <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Curriculum</Text>
        <PillPicker items={CURRICULA} selectedId={curriculum} onPick={(id) => { if (!busy) setCurriculum(id as "844" | "cbc"); }} accent={session.accent} />
      </View>

      <Field
        label="Anything Bloom should know (optional)"
        value={notes}
        onChangeText={setNotes}
        placeholder="e.g. Only import Section B. The answers are on the last page."
        multiline
        editable={!busy}
      />

      {hasQuestions && (
        <Tap
          accessibilityRole="checkbox"
          accessibilityLabel="Replace the questions already in this paper"
          accessibilityState={{ checked: replace, disabled: busy }}
          disabled={busy}
          onPress={() => setReplace(!replace)}
          style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: replace ? accentInk(a.deep) : fieldLine, backgroundColor: replace ? accentInk(a.deep) : "transparent", alignItems: "center", justifyContent: "center" }}>
            {replace && <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>✓</Text>}
          </View>
          <Text style={[s.small, { flex: 1 }]}>Replace the questions already in this paper (otherwise they're added at the end)</Text>
        </Tap>
      )}

      {!!error && (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
          <CircleAlert size={14} color={t.status.warnInk} style={{ marginTop: 2 }} />
          <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: t.status.warnInk }}>{error}</Text>
        </View>
      )}
      {busy && (
        <Text accessibilityLiveRegion="polite" style={s.small}>
          {step === "uploading" ? "Uploading the paper…" : "Reading the paper. This can take a few minutes."} Keep the app open until it finishes.
        </Text>
      )}
      <Text style={s.faint}>{AI_DRAFT_NOTE} Your file is deleted once Bloom has read it.</Text>

      <View style={{ gap: 8 }}>
        <Button label="Import paper" tint={a.deep} loading={busy} disabled={!files.length} onPress={() => void run()} />
        <Button variant="quiet" tint={t.appSurface.inkMuted} label="Cancel" disabled={busy} onPress={onClose} />
      </View>
    </View>
  );
}
