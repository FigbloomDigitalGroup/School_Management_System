import { totalPoints, type QuestionDraft } from "./examPapers";

/**
 * Turning an existing exam paper (a PDF, a Word file or photos of a printed
 * paper) into a draft online paper with Bloom. The ai-assist edge function
 * reads the document ("paper_import" in supabase/functions/ai-assist) and
 * answers in the shape below; this file checks what came back and maps it
 * onto the question builder's drafts, with a "check this" list on every
 * question the teacher should look at before publishing.
 *
 * Nothing here saves anything. The draft opens in the paper editor, and only
 * the teacher's own Save / Publish puts it in front of learners.
 */

// ---------------------------------------------------------------- the files

/** Word, PDF, or photos/scans of the pages. */
export type ImportFileKind = "pdf" | "docx" | "image";

/** One PDF or Word file, or up to this many page photos. */
export const IMPORT_MAX_IMAGES = 10;
/** All files together. Well under the upload limit: what a model can read in one go, not what storage takes. */
export const IMPORT_MAX_BYTES = 20 * 1024 ** 2;
/** Longest PDF read at once; a longer one is usually several papers, or a paper with its marking scheme as a book. */
export const IMPORT_MAX_PDF_PAGES = 30;

export const IMPORT_ACCEPT = ".pdf,.docx,.jpg,.jpeg,.png,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png";

export function importFileKind(file: { name: string; type?: string }): ImportFileKind | null {
  const name = file.name.toLowerCase();
  const type = (file.type ?? "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx")) return "docx";
  if (type === "image/jpeg" || type === "image/png" || /\.(jpe?g|png)$/.test(name)) return "image";
  return null;
}

/** Why these files can't be imported together, or null. */
export function checkImportFiles(files: { name: string; size: number; type?: string }[]): string | null {
  if (!files.length) return "Choose the paper: a PDF, a Word file or photos of its pages.";
  const kinds = files.map(importFileKind);
  if (kinds.some((k) => k === null)) {
    if (files.some((f) => /\.doc$/i.test(f.name))) return "Save the Word file as .docx first (File, Save As), then choose it again.";
    return "Bloom can read PDF, Word (.docx), JPG and PNG files.";
  }
  if (files.length > 1 && kinds.some((k) => k !== "image")) return "Choose one PDF or Word file, or several photos of the pages, not a mix.";
  if (files.length > IMPORT_MAX_IMAGES) return `Choose at most ${IMPORT_MAX_IMAGES} photos at a time.`;
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > IMPORT_MAX_BYTES) return `That's ${Math.ceil(total / 1024 ** 2)} MB. Bloom can read up to ${IMPORT_MAX_BYTES / 1024 ** 2} MB at a time: split the paper, or take smaller photos.`;
  return null;
}

/**
 * Where a file waits while Bloom reads it: the importing person's own folder
 * in private-documents (staff write there already). The edge function only
 * reads paths in the caller's folder, and deletes them once read.
 */
export function paperImportPath(tenantId: string, profileId: string, fileId: string, fileName: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1]?.toLowerCase() ?? "bin";
  return `${tenantId}/paper-imports/${profileId}/${fileId}.${ext}`;
}

// ---------------------------------------------------------------- what the model answers

/** The kinds Bloom may report; anything but choice/short/long is mapped onto one of those. */
export type ImportedKind = "choice" | "true_false" | "fill_blank" | "short" | "long";

export interface ImportedQuestion {
  section: string;
  number: string;
  kind: ImportedKind;
  prompt: string;
  options: string[];
  /** 0-based, or -1. */
  correct_option: number;
  model_answer: string;
  /** Where the answer came from: the paper's own marking scheme, Bloom's suggestion, or nowhere. */
  answer_source: "document" | "suggested" | "none";
  /** 0 when the paper doesn't say. */
  points: number;
  /** Needs a diagram, map, graph or picture that can't be typed. */
  figure: boolean;
  confidence: "high" | "medium" | "low";
  /** Anything the teacher should know about this question, or "". */
  note: string;
}

export interface ImportedPaper {
  title: string;
  instructions: string;
  /** 0 when the paper doesn't say. */
  duration_minutes: number;
  /** The total the paper states, 0 when it doesn't. */
  total_marks: number;
  questions: ImportedQuestion[];
  /** Whole-paper problems: unreadable pages, missing parts. */
  warnings: string[];
}

const KINDS: ImportedKind[] = ["choice", "true_false", "fill_blank", "short", "long"];
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const whole = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

/**
 * Reads the model's answer defensively. Structured outputs should make it
 * match the schema exactly, but a provider change, a truncated answer or a
 * fallback model shouldn't be able to put something malformed in front of
 * the teacher. Throws only when there's nothing usable at all.
 */
export function parseImportedPaper(raw: unknown): ImportedPaper {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { questions?: unknown }).questions)) {
    throw new Error("Bloom's answer didn't look like a paper. Please try again.");
  }
  const r = raw as Record<string, unknown>;
  const questions = (r.questions as unknown[]).flatMap((q): ImportedQuestion[] => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    const kind = KINDS.includes(o.kind as ImportedKind) ? (o.kind as ImportedKind) : "short";
    return [{
      section: text(o.section),
      number: text(o.number),
      kind,
      prompt: text(o.prompt),
      options: Array.isArray(o.options) ? o.options.map(text) : [],
      correct_option: Number.isInteger(o.correct_option) ? (o.correct_option as number) : -1,
      model_answer: text(o.model_answer),
      answer_source: o.answer_source === "document" || o.answer_source === "suggested" ? o.answer_source : "none",
      points: whole(o.points),
      figure: o.figure === true,
      confidence: o.confidence === "high" || o.confidence === "medium" ? o.confidence : "low",
      note: text(o.note),
    }];
  });
  return {
    title: text(r.title),
    instructions: text(r.instructions),
    duration_minutes: whole(r.duration_minutes),
    total_marks: whole(r.total_marks),
    questions,
    warnings: Array.isArray(r.warnings) ? r.warnings.map(text).filter(Boolean) : [],
  };
}

// ---------------------------------------------------------------- onto the builder

/** A builder question with what the teacher should check. `check` is never saved. */
export type ReviewQuestion = QuestionDraft & { check?: string[] };

export interface PaperImportDraft {
  title: string;
  instructions: string;
  durationMinutes: number | null;
  questions: ReviewQuestion[];
  /** About the paper as a whole, shown above the questions. */
  warnings: string[];
}

/** The most questions a paper can have (replace_exam_questions). */
const MAX_QUESTIONS = 200;
const PROMPT_MAX = 4000;
const ANSWER_MAX = 4000;
const OPTIONS_MAX = 8;
/** Marks for a question the paper gives none for: the builder's own defaults for each kind. */
const DEFAULT_POINTS = { choice: 1, short: 2, long: 5 } as const;

export const CHECK = {
  figure: "Refers to a diagram, map or picture Bloom can't reproduce. Attach it as the reference sheet, or describe it in the question.",
  unsure: "Bloom wasn't sure it read this correctly. Compare it with the paper.",
  suggested: "The answer is Bloom's suggestion, not from the paper's marking scheme.",
  noAnswer: "No answer was on the paper. Tick the correct option.",
  noOptions: "The options couldn't be read, so this became a written question. Add the options back if it was multiple choice.",
  tooManyOptions: "Had more than 8 options; only the first 8 were kept.",
  noMarks: "The paper didn't give marks for this question. Check the marks.",
  tooManyMarks: "Was worth more than 100 marks; set to 100.",
  cutShort: "Too long for one question; the end was cut off.",
  repeatedOption: "Two options are the same. Fix them before saving.",
} as const;

/**
 * The model's paper as builder drafts. Kinds the builder doesn't have become
 * the nearest one (true/false: a two-option choice; fill in the blank: a
 * short answer). A section heading goes at the top of the first question in
 * that section, so learners still see "SECTION B" where it starts.
 */
export function draftFromImport(paper: ImportedPaper): PaperImportDraft {
  const warnings = [...paper.warnings];
  let section = "";
  const questions: ReviewQuestion[] = [];

  for (const q of paper.questions) {
    if (!q.prompt) {
      warnings.push(`Question ${q.number || questions.length + 1} came back without any text and was left out. Add it by hand.`);
      continue;
    }
    const check: string[] = [];
    let kind: QuestionDraft["kind"];
    let options: string[] = [];
    let correctOption: number | null = null;

    if (q.kind === "true_false") {
      kind = "choice";
      options = ["True", "False"];
      // The model may have read the options as written ("T"/"F", "Kweli"/"Si kweli"): keep those when there are two.
      if (q.options.filter(Boolean).length === 2) options = q.options.filter(Boolean);
      correctOption = q.correct_option === 0 || q.correct_option === 1 ? q.correct_option : null;
    } else if (q.kind === "choice") {
      options = q.options.filter(Boolean);
      if (options.length < 2) {
        kind = "short";
        options = [];
        check.push(CHECK.noOptions);
      } else {
        kind = "choice";
        if (options.length > OPTIONS_MAX) {
          check.push(CHECK.tooManyOptions);
          options = options.slice(0, OPTIONS_MAX);
        }
        correctOption = q.correct_option >= 0 && q.correct_option < options.length ? q.correct_option : null;
      }
    } else {
      kind = q.kind === "long" ? "long" : "short";
    }

    if (kind === "choice") {
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) check.push(CHECK.repeatedOption);
      if (correctOption === null) check.push(CHECK.noAnswer);
      else if (q.answer_source !== "document") check.push(CHECK.suggested);
    } else if (q.model_answer && q.answer_source === "suggested") {
      check.push(CHECK.suggested);
    }

    let points = q.points;
    if (points < 1) {
      points = DEFAULT_POINTS[kind];
      check.push(CHECK.noMarks);
    } else if (points > 100) {
      points = 100;
      check.push(CHECK.tooManyMarks);
    }

    let prompt = q.prompt;
    if (q.section && q.section !== section) prompt = `${q.section}\n\n${prompt}`;
    section = q.section || section;
    if (prompt.length > PROMPT_MAX) {
      prompt = prompt.slice(0, PROMPT_MAX);
      check.push(CHECK.cutShort);
    }

    if (q.figure) check.push(CHECK.figure);
    if (q.confidence === "low") check.push(CHECK.unsure);
    if (q.note) check.push(q.note);

    questions.push({
      kind, prompt, options, points, correctOption,
      modelAnswer: kind === "choice" ? "" : q.model_answer.slice(0, ANSWER_MAX),
      ...(check.length ? { check } : {}),
    });
  }

  if (questions.length > MAX_QUESTIONS) {
    warnings.push(`The paper has ${questions.length} questions; a paper can have ${MAX_QUESTIONS}. Only the first ${MAX_QUESTIONS} were kept.`);
    questions.length = MAX_QUESTIONS;
  }
  const total = totalPoints(questions);
  if (paper.total_marks > 0 && questions.length && paper.total_marks !== total) {
    warnings.push(`The paper says it is out of ${paper.total_marks}, but the questions add up to ${total}. Check the marks.`);
  }

  return {
    title: paper.title.slice(0, 160),
    instructions: paper.instructions.slice(0, 4000),
    durationMinutes: paper.duration_minutes >= 1 && paper.duration_minutes <= 600 ? paper.duration_minutes : null,
    questions,
    warnings,
  };
}

/** How many questions still have something to check. */
export const questionsToCheck = (questions: ReviewQuestion[]): number => questions.filter((q) => q.check?.length).length;
