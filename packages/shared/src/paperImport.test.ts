import { describe, expect, it } from "vitest";
import { validateQuestions } from "./examPapers";
import {
  CHECK, IMPORT_MAX_BYTES, applyPaperImport, checkImportFiles, curriculumFromClassName, draftFromImport, flaggedQuestionsBanner,
  flaggedQuestionsProblem, importFileKind, paperImportPath, parseImportedPaper, questionsToCheck,
  type ImportedPaper, type ImportedQuestion, type PaperImportDraft, type ReviewQuestion,
} from "./paperImport";

const q = (over: Partial<ImportedQuestion> = {}): ImportedQuestion => ({
  section: "", number: "1", kind: "short", prompt: "Define photosynthesis.", options: [], correct_option: -1,
  model_answer: "", answer_source: "none", points: 2, figure: false, confidence: "high", note: "", ...over,
});
const paper = (questions: ImportedQuestion[], over: Partial<ImportedPaper> = {}): ImportedPaper => ({
  title: "Form 2 Biology End of Term 1", instructions: "Answer all questions.", duration_minutes: 90, total_marks: 0,
  questions, warnings: [], ...over,
});

describe("checkImportFiles", () => {
  const mb = 1024 ** 2;
  it("takes one PDF or Word file, or several page photos", () => {
    expect(checkImportFiles([{ name: "paper.pdf", size: mb }])).toBe(null);
    expect(checkImportFiles([{ name: "Paper 1.DOCX", size: mb }])).toBe(null);
    expect(checkImportFiles([{ name: "p1.jpg", size: mb }, { name: "p2.png", size: mb }])).toBe(null);
  });
  it("turns away a mix, old Word files, other types, and too much", () => {
    expect(checkImportFiles([])).toMatch(/Choose the paper/);
    expect(checkImportFiles([{ name: "paper.pdf", size: mb }, { name: "p2.jpg", size: mb }])).toMatch(/not a mix/);
    expect(checkImportFiles([{ name: "paper.doc", size: mb }])).toMatch(/\.docx/);
    expect(checkImportFiles([{ name: "paper.xlsx", size: mb }])).toMatch(/PDF, Word/);
    expect(checkImportFiles(Array.from({ length: 11 }, (_, i) => ({ name: `p${i}.jpg`, size: 1 })))).toMatch(/at most 10/);
    expect(checkImportFiles([{ name: "paper.pdf", size: IMPORT_MAX_BYTES + 1 }])).toMatch(/up to 20 MB/);
  });
  it("goes by the type when the name has no extension", () => {
    expect(importFileKind({ name: "scan", type: "image/jpeg" })).toBe("image");
    expect(importFileKind({ name: "scan", type: "text/plain" })).toBe(null);
  });
});

describe("paperImportPath", () => {
  it("stages in the importer's own folder, keeping only a safe extension", () => {
    expect(paperImportPath("t1", "p1", "f1", "Mid term Maths.PDF")).toBe("t1/paper-imports/p1/f1.pdf");
    expect(paperImportPath("t1", "p1", "f1", "no-extension")).toBe("t1/paper-imports/p1/f1.bin");
  });
});

describe("parseImportedPaper", () => {
  it("refuses an answer with no questions list", () => {
    expect(() => parseImportedPaper(null)).toThrow();
    expect(() => parseImportedPaper("not json")).toThrow();
    expect(() => parseImportedPaper({ title: "x" })).toThrow();
  });
  it("fills in what's missing or the wrong type instead of trusting it", () => {
    const p = parseImportedPaper({
      title: 7, duration_minutes: "90",
      questions: [null, "text", { kind: "matching", prompt: "  Match the parts.  ", options: [1, " A "], correct_option: 1.5, points: 3.4, confidence: "very" }],
    });
    expect(p.title).toBe("");
    expect(p.duration_minutes).toBe(0);
    expect(p.warnings).toEqual([]);
    expect(p.questions).toEqual([q({
      number: "", kind: "short", prompt: "Match the parts.", options: ["", "A"], correct_option: -1, points: 3, confidence: "low",
    })]);
  });
});

describe("draftFromImport", () => {
  it("keeps a choice question with its key from the paper, unflagged", () => {
    const d = draftFromImport(paper([q({ kind: "choice", prompt: "Which organelle makes food?", options: ["Nucleus", "Chloroplast", "Vacuole", "Ribosome"], correct_option: 1, answer_source: "document", points: 1 })]));
    expect(d.questions).toEqual([{ kind: "choice", prompt: "Which organelle makes food?", options: ["Nucleus", "Chloroplast", "Vacuole", "Ribosome"], correctOption: 1, points: 1, modelAnswer: "" }]);
    expect(questionsToCheck(d.questions)).toBe(0);
    expect(d.durationMinutes).toBe(90);
    expect(validateQuestions(d.questions).ok).toBe(true);
  });

  it("maps true/false and fill-in-the-blank onto the builder's kinds", () => {
    const d = draftFromImport(paper([
      q({ kind: "true_false", prompt: "Plants respire at night.", correct_option: 0, answer_source: "document", points: 1 }),
      q({ kind: "true_false", prompt: "Mimea hupumua usiku.", options: ["Kweli", "Si kweli"], correct_option: 0, answer_source: "document", points: 1 }),
      q({ kind: "fill_blank", prompt: "The green pigment in leaves is ______.", model_answer: "chlorophyll", answer_source: "document", points: 1 }),
    ]));
    expect(d.questions.map((x) => [x.kind, x.options])).toEqual([["choice", ["True", "False"]], ["choice", ["Kweli", "Si kweli"]], ["short", []]]);
    expect(d.questions[2]!.modelAnswer).toBe("chlorophyll");
    expect(questionsToCheck(d.questions)).toBe(0);
  });

  it("flags what the teacher has to check", () => {
    const d = draftFromImport(paper([
      q({ kind: "choice", prompt: "Pick one", options: ["A", "B", "C"], correct_option: 2, answer_source: "suggested", points: 1 }),
      q({ kind: "choice", prompt: "Pick again", options: ["A", "B"], correct_option: 5, points: 1 }),
      q({ kind: "choice", prompt: "Options unreadable", options: ["A"], points: 1 }),
      q({ kind: "long", prompt: "Study the diagram and explain.", points: 0, figure: true, confidence: "low", note: "Part (c) is smudged." }),
      q({ kind: "short", prompt: "Huge", points: 250 }),
    ]));
    const [suggested, noKey, noOptions, figure, huge] = d.questions;
    expect(suggested!.check).toEqual([CHECK.suggested]);
    expect(noKey!.correctOption).toBe(null);
    expect(noKey!.check).toEqual([CHECK.noAnswer]);
    expect(noOptions!.kind).toBe("short");
    expect(noOptions!.check).toEqual([CHECK.noOptions]);
    expect(figure!.points).toBe(5);
    expect(figure!.check).toEqual([CHECK.noMarks, CHECK.figure, CHECK.unsure, "Part (c) is smudged."]);
    expect(huge!.points).toBe(100);
    expect(questionsToCheck(d.questions)).toBe(5);
  });

  it("caps options at 8 and spots repeats", () => {
    const d = draftFromImport(paper([
      q({ kind: "choice", options: "ABCDEFGHIJ".split(""), correct_option: 9, answer_source: "document", points: 1 }),
      q({ kind: "choice", options: ["Yes", "yes"], correct_option: 0, answer_source: "document", points: 1 }),
    ]));
    expect(d.questions[0]!.options).toHaveLength(8);
    expect(d.questions[0]!.correctOption).toBe(null);
    expect(d.questions[0]!.check).toEqual([CHECK.tooManyOptions, CHECK.noAnswer]);
    expect(d.questions[1]!.check).toEqual([CHECK.repeatedOption]);
  });

  it("puts each section heading on the first question of its section", () => {
    const d = draftFromImport(paper([
      q({ section: "SECTION A (40 marks)", prompt: "One" }),
      q({ section: "SECTION A (40 marks)", prompt: "Two" }),
      q({ section: "SECTION B (60 marks)", prompt: "Three" }),
      q({ section: "", prompt: "Four" }),
    ]));
    expect(d.questions.map((x) => x.prompt)).toEqual(["SECTION A (40 marks)\n\nOne", "Two", "SECTION B (60 marks)\n\nThree", "Four"]);
  });

  it("leaves out questions with no text, and says so", () => {
    const d = draftFromImport(paper([q({ number: "3", prompt: "" }), q()], { warnings: ["Page 4 was too blurred to read."] }));
    expect(d.questions).toHaveLength(1);
    expect(d.warnings).toEqual(["Page 4 was too blurred to read.", "Question 3 came back without any text and was left out. Add it by hand."]);
  });

  it("compares the paper's stated total with the questions", () => {
    expect(draftFromImport(paper([q({ points: 2 }), q({ points: 3 })], { total_marks: 5 })).warnings).toEqual([]);
    expect(draftFromImport(paper([q({ points: 2 }), q({ points: 3 })], { total_marks: 50 })).warnings)
      .toEqual(["The paper says it is out of 50, but the questions add up to 5. Check the marks."]);
  });

  it("keeps a paper within the database's limits", () => {
    const d = draftFromImport(paper(Array.from({ length: 205 }, () => q({ prompt: "x".repeat(4100) })), { duration_minutes: 900, title: "T".repeat(300) }));
    expect(d.questions).toHaveLength(200);
    expect(d.questions[0]!.prompt).toHaveLength(4000);
    expect(d.questions[0]!.check).toContain(CHECK.cutShort);
    expect(d.durationMinutes).toBe(null);
    expect(d.title).toHaveLength(160);
    expect(d.warnings.at(-1)).toMatch(/Only the first 200/);
  });
});

describe("what an import does to the paper editor's fields", () => {
  const typed = (prompt: string): ReviewQuestion => ({ kind: "short", prompt, options: [], points: 2, correctOption: null, modelAnswer: "" });
  const draft = (over: Partial<PaperImportDraft> = {}): PaperImportDraft => ({
    title: "Form 2 Biology End of Term 1", instructions: "Answer all questions.", durationMinutes: 90,
    questions: [{ ...typed("Imported 1"), check: [CHECK.unsure] }, typed("Imported 2")], warnings: ["Page 3 is missing."], ...over,
  });
  const empty = { title: "", instructions: "", duration: "60", questions: [] as ReviewQuestion[], isNew: true };

  it("puts the imported questions after the ones already in the paper", () => {
    const r = applyPaperImport({ ...empty, questions: [typed("Mine")] }, draft(), false);
    expect(r.questions.map((x) => x.prompt)).toEqual(["Mine", "Imported 1", "Imported 2"]);
  });

  it("puts them in place of the ones already there when asked to replace", () => {
    const r = applyPaperImport({ ...empty, questions: [typed("Mine")] }, draft(), true);
    expect(r.questions.map((x) => x.prompt)).toEqual(["Imported 1", "Imported 2"]);
  });

  it("keeps what Bloom flagged, so the teacher is asked to check it", () => {
    const r = applyPaperImport(empty, draft(), false);
    expect(questionsToCheck(r.questions)).toBe(1);
  });

  it("fills the title and instructions only where they are empty", () => {
    expect(applyPaperImport(empty, draft(), false)).toMatchObject({ title: "Form 2 Biology End of Term 1", instructions: "Answer all questions." });
    const kept = applyPaperImport({ ...empty, title: "My title", instructions: "My notes" }, draft(), false);
    expect(kept).toMatchObject({ title: "My title", instructions: "My notes" });
    expect(applyPaperImport({ ...empty, title: "   " }, draft(), false).title).toBe("Form 2 Biology End of Term 1");
  });

  it("does not blank a title or instructions because the paper had none", () => {
    const r = applyPaperImport({ ...empty, title: "Mine", instructions: "Mine too" }, draft({ title: "", instructions: "" }), false);
    expect(r).toMatchObject({ title: "Mine", instructions: "Mine too" });
  });

  it("gives a new paper the imported paper's own time, over the 60-minute default", () => {
    expect(applyPaperImport({ ...empty, duration: "60" }, draft({ durationMinutes: 90 }), false).duration).toBe("90");
  });

  it("keeps the time of a paper that already has one, and fills it in for one that has none", () => {
    expect(applyPaperImport({ ...empty, isNew: false, duration: "45" }, draft({ durationMinutes: 90 }), false).duration).toBe("45");
    expect(applyPaperImport({ ...empty, isNew: false, duration: " " }, draft({ durationMinutes: 90 }), false).duration).toBe("90");
  });

  it("leaves the time alone when the imported paper gives none", () => {
    expect(applyPaperImport(empty, draft({ durationMinutes: null }), false).duration).toBe("60");
  });

  it("hands back what Bloom said about the paper as a whole", () => {
    expect(applyPaperImport(empty, draft(), false).warnings).toEqual(["Page 3 is missing."]);
  });
});

describe("the words about flagged questions", () => {
  it("says how many need checking before the paper can be published", () => {
    expect(flaggedQuestionsBanner(1)).toBe("Imported by Bloom. 1 question needs checking against the paper before you can publish.");
    expect(flaggedQuestionsBanner(3)).toBe("Imported by Bloom. 3 questions need checking against the paper before you can publish.");
  });
  it("says why a paper with flagged questions cannot be published, and that a draft can be saved", () => {
    expect(flaggedQuestionsProblem(1)).toBe('1 question is flagged for checking. Look at each one and press "Looks right", or save a draft for now.');
    expect(flaggedQuestionsProblem(2)).toBe('2 questions are flagged for checking. Look at each one and press "Looks right", or save a draft for now.');
  });
});

describe("the curriculum a class is guessed to follow", () => {
  it("takes a Form class as 8-4-4 and everything else as CBC", () => {
    expect(curriculumFromClassName("Form 2 West")).toBe("844");
    expect(curriculumFromClassName("  form 4")).toBe("844");
    expect(curriculumFromClassName("Grade 6 Blue")).toBe("cbc");
    expect(curriculumFromClassName("PP2")).toBe("cbc");
    expect(curriculumFromClassName("Formal 1")).toBe("cbc");
  });
});
