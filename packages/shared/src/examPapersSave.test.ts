import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What reaches the database when a paper's questions are saved. A question Bloom imported carries notes about
 * what to check (`check`); they are for the teacher to read and clear, and must never be saved with the paper.
 */
const rpc = vi.fn();
vi.mock("./supabase", () => ({ supabase: () => ({ rpc }) }));

import { saveExamQuestions, type QuestionDraft } from "./examPapers";

beforeEach(() => { rpc.mockReset().mockResolvedValue({ error: null }); });

const choice: QuestionDraft = { kind: "choice", prompt: "Symbol for sodium?", options: ["Na", "S"], points: 1, correctOption: 0, modelAnswer: "" };
const written: QuestionDraft = { kind: "short", prompt: "Define an acid.", options: [], points: 2, correctOption: null, modelAnswer: "A proton donor" };

describe("saving a paper's questions", () => {
  it("sends the columns the table has, and nothing else, whatever else the question object carries", async () => {
    const flagged = [{ ...choice, check: ["Bloom was not sure."] }, { ...written, check: ["Compare it with the paper."], id: "q-1" }] as unknown as QuestionDraft[];
    await saveExamQuestions("paper-1", flagged);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe("replace_exam_questions");
    expect(args).toEqual({
      p_paper_id: "paper-1",
      p_questions: [
        { kind: "choice", prompt: "Symbol for sodium?", options: ["Na", "S"], points: 1, correct_option: 0, model_answer: null },
        { kind: "short", prompt: "Define an acid.", options: null, points: 2, correct_option: null, model_answer: "A proton donor" },
      ],
    });
    expect(JSON.stringify(args)).not.toContain("check");
  });

  it("reports the database's own refusal", async () => {
    rpc.mockResolvedValue({ error: { message: "Learners have already started this paper." } });
    await expect(saveExamQuestions("paper-1", [choice])).rejects.toThrow("Learners have already started this paper.");
  });
});
