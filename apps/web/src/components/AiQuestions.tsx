import { useState } from "react";
import { draftQuestions, type QuestionDraft } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { SelectField, TextArea, TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { AI_DRAFT_NOTE } from "../lib/useAi";

/** "Form 2 West" is 8-4-4; "Grade 6 Blue", "PP2" and the rest are CBC. The teacher can change it. */
export const curriculumFromClassName = (name: string): "844" | "cbc" => (/^\s*form\b/i.test(name) ? "844" : "cbc");

/**
 * Drafts questions for the paper being edited. They're added to the end of
 * the question list like any typed question, keys included, for the teacher
 * to check, edit or delete before saving.
 */
export function AiQuestionsModal({ subject, className, kind, onAdd, onClose }: {
  subject: string;
  className: string;
  kind: "exam" | "assessment";
  onAdd: (questions: QuestionDraft[]) => void;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [choice, setChoice] = useState("5");
  const [short, setShort] = useState("3");
  const [long, setLong] = useState("1");
  const [difficulty, setDifficulty] = useState<"easy" | "mixed" | "hard">("mixed");
  const [curriculum, setCurriculum] = useState<"844" | "cbc">(curriculumFromClassName(className));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const n = (v: string) => Math.max(0, Math.min(30, Math.floor(Number(v) || 0)));

  async function generate() {
    if (!topic.trim()) { setError("Say which topic or strand the questions are on."); return; }
    if (n(choice) + n(short) + n(long) === 0) { setError("Ask for at least one question."); return; }
    setBusy(true);
    setError("");
    try {
      const drafts = await draftQuestions({
        subject, classLabel: className, curriculum, kind, topic: topic.trim(), notes: notes.trim() || undefined,
        choice: n(choice), short: n(short), long: n(long), difficulty,
      });
      if (!drafts.length) throw new Error("No usable questions came back. Try again, or reword the topic.");
      onAdd(drafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not draft questions.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${className} · ${subject}`}
      title="Draft questions with Bloom"
      blurb="The questions, options, answer keys and marking points are added to the end of this paper for you to check and edit."
      footNote={AI_DRAFT_NOTE}
      width={560}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={busy} onClick={() => void generate()}>{busy ? "Drafting… (up to a minute)" : "Draft questions"}</Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <TextField id="aiq-topic" label="Topic or strand" placeholder="e.g. Fractions: adding and subtracting unlike denominators" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <TextField id="aiq-choice" label="Multiple choice" type="number" min={0} max={30} value={choice} onChange={(e) => setChoice(e.target.value)} />
          <TextField id="aiq-short" label="Short answer" type="number" min={0} max={20} value={short} onChange={(e) => setShort(e.target.value)} />
          <TextField id="aiq-long" label="Long answer" type="number" min={0} max={10} value={long} onChange={(e) => setLong(e.target.value)} />
        </div>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SelectField id="aiq-difficulty" label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
            options={[{ value: "easy", label: "Easier" }, { value: "mixed", label: "Mixed" }, { value: "hard", label: "Harder" }]} />
          <SelectField id="aiq-curriculum" label="Curriculum" value={curriculum} onChange={(e) => setCurriculum(e.target.value as typeof curriculum)}
            options={[{ value: "cbc", label: "CBC" }, { value: "844", label: "8-4-4 (KCSE)" }]} />
        </div>
        <TextArea id="aiq-notes" label="Anything else (optional)" placeholder="e.g. Use word problems about the market. Avoid calculators." value={notes} onChange={(e) => setNotes(e.target.value)} />
        {error && <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
      </div>
    </Modal>
  );
}
