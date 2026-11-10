import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { ExamPaperRow } from "@figbloom/shared";
import * as pick from "../../lib/pickFile";
import * as uploads from "../../lib/uploads";
import { TeacherExamPaperEditor } from "./ExamPaperEditor";
import type { TeacherSession } from "../../teacherNavigation";

// The icon library ships as untranspiled ES modules; the icons are not what this tests.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : () => null) }));
const mockNav = { goBack: jest.fn(), canGoBack: () => true, addListener: jest.fn(() => jest.fn()), dispatch: jest.fn() };
jest.mock("@react-navigation/native", () => ({ useNavigation: () => mockNav }));
jest.mock("../../lib/pickFile", () => ({ PDF_OR_IMAGE: ["application/pdf"], pickFile: jest.fn() }));
jest.mock("../../lib/uploads", () => ({ uploadExamPaperFile: jest.fn() }));
jest.mock("../../lib/examFile", () => ({ openExamFile: jest.fn() }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchTeacherClasses: jest.fn(), fetchTeacherSubjectsForClass: jest.fn(), fetchCurrentTermExams: jest.fn(), fetchPaperContent: jest.fn(),
  createExamPaper: jest.fn(), updateExamPaper: jest.fn(), savePaperBody: jest.fn(), setPaperFile: jest.fn(), saveExamQuestions: jest.fn(), setPaperPublished: jest.fn(),
}));

const mocked = (fn: unknown) => fn as jest.Mock;
const api = {
  fetchTeacherClasses: mocked(shared.fetchTeacherClasses),
  fetchTeacherSubjectsForClass: mocked(shared.fetchTeacherSubjectsForClass),
  fetchCurrentTermExams: mocked(shared.fetchCurrentTermExams),
  fetchPaperContent: mocked(shared.fetchPaperContent),
  createExamPaper: mocked(shared.createExamPaper),
  updateExamPaper: mocked(shared.updateExamPaper),
  savePaperBody: mocked(shared.savePaperBody),
  setPaperFile: mocked(shared.setPaperFile),
  saveExamQuestions: mocked(shared.saveExamQuestions),
  setPaperPublished: mocked(shared.setPaperPublished),
  pickFile: pick.pickFile as unknown as jest.Mock,
  uploadExamPaperFile: uploads.uploadExamPaperFile as unknown as jest.Mock,
};
const session: TeacherSession = { profileId: "t-1", tenantId: "s-1", fullName: "Teacher Two", accent: "forest", country: "KE" };

const PDF = { uri: "file:///paper.pdf", name: "paper.pdf", mimeType: "application/pdf", sizeBytes: 120_000 };
const existing = (over: Partial<ExamPaperRow> = {}): ExamPaperRow => ({
  id: "paper-1", kind: "exam", title: "Mid-term Chemistry", instructions: "", classId: "c-1", className: "Form 2 West", subjectId: "sub-1", subjectName: "Chemistry",
  examId: null, examName: null, mode: "online", filePath: null, fileName: null, opensAt: "2026-11-12T05:00:00.000Z", closesAt: null, durationMinutes: 45,
  publishedAt: null, resultsReleasedAt: null, questionCount: 1, attemptCount: 0, ...over,
});

beforeEach(() => {
  // The new paper's opening time is tomorrow 08:00 by the phone's clock; pin the clock so that is a known moment.
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] }).setSystemTime(new Date("2026-11-10T10:00:00"));
  mockNav.goBack.mockReset();
  api.fetchTeacherClasses.mockResolvedValue([{ id: "c-1", name: "Form 2 West", level: "secondary", form_level: 2 }]);
  api.fetchTeacherSubjectsForClass.mockResolvedValue([{ id: "sub-1", name: "Chemistry" }]);
  api.fetchCurrentTermExams.mockResolvedValue([{ id: "e-1", name: "Term 2 Exam", outOf: 100 }]);
  api.fetchPaperContent.mockResolvedValue({ body: "", questions: [] });
  api.createExamPaper.mockReset().mockResolvedValue("paper-new");
  for (const k of ["updateExamPaper", "savePaperBody", "setPaperFile", "saveExamQuestions", "setPaperPublished"] as const) api[k].mockReset().mockResolvedValue(undefined);
  api.pickFile.mockReset().mockResolvedValue(PDF);
  api.uploadExamPaperFile.mockReset().mockResolvedValue({ path: "s-1/exam-papers/paper-new/1-paper.pdf", name: "paper.pdf" });
});
afterEach(() => jest.useRealTimers());

async function open(paper?: ExamPaperRow) {
  render(<TeacherExamPaperEditor session={session} route={{ params: paper ? { paper } : undefined }} />);
  await screen.findByLabelText("Title");
  await act(async () => {});
}
const typeTitle = (v = "Mid-term Chemistry") => fireEvent.changeText(screen.getByLabelText("Title"), v);
function addSodiumQuestion() {
  fireEvent.press(screen.getByText("Add multiple choice"));
  fireEvent.changeText(screen.getByLabelText("Question 1"), "Symbol for sodium?");
  fireEvent.changeText(screen.getByLabelText("Option A"), "Na");
  fireEvent.changeText(screen.getByLabelText("Option B"), "S");
  fireEvent.press(screen.getByLabelText("Option A is correct"));
}
const press = (label: string) => fireEvent.press(screen.getByText(label));

describe("saving a new online paper", () => {
  it("creates the paper, saves its questions and goes back, leaving it a draft", async () => {
    await open();
    typeTitle();
    addSodiumQuestion();
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.createExamPaper).toHaveBeenCalledTimes(1);
    expect(api.createExamPaper).toHaveBeenCalledWith("s-1", expect.objectContaining({
      kind: "exam", title: "Mid-term Chemistry", classId: "c-1", subjectId: "sub-1", mode: "online", examId: null,
      durationMinutes: 60, closesAt: null, opensAt: new Date("2026-11-11T08:00").toISOString(),
    }));
    expect(api.saveExamQuestions).toHaveBeenCalledWith("paper-new", [
      expect.objectContaining({ kind: "choice", prompt: "Symbol for sodium?", options: ["Na", "S"], correctOption: 0, points: 1 }),
    ]);
    expect(api.setPaperPublished).not.toHaveBeenCalled();
  });

  it("publishes only after the questions are saved", async () => {
    await open();
    typeTitle();
    addSodiumQuestion();
    press("Save and publish");
    await waitFor(() => expect(api.setPaperPublished).toHaveBeenCalledWith("paper-new", true));
    expect(api.saveExamQuestions.mock.invocationCallOrder[0]).toBeLessThan(api.setPaperPublished.mock.invocationCallOrder[0]!);
    expect(mockNav.goBack).toHaveBeenCalled();
  });

  it("sends the term exam it counts towards", async () => {
    await open();
    typeTitle();
    addSodiumQuestion();
    press("Term 2 Exam");
    press("Save draft");
    await waitFor(() => expect(api.createExamPaper).toHaveBeenCalled());
    expect(api.createExamPaper.mock.calls[0]![1]).toMatchObject({ examId: "e-1" });
  });

  it("does not make a second paper when a retry follows a failure after the first was created", async () => {
    api.saveExamQuestions.mockRejectedValueOnce(new Error("The questions could not be saved."));
    await open();
    typeTitle();
    addSodiumQuestion();
    press("Save draft");
    expect(await screen.findByText("The questions could not be saved.")).toBeTruthy();
    expect(mockNav.goBack).not.toHaveBeenCalled();
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.createExamPaper).toHaveBeenCalledTimes(1);
    expect(api.updateExamPaper).toHaveBeenCalledWith("paper-new", expect.objectContaining({ title: "Mid-term Chemistry" }));
  });
});

describe("what the form refuses, and says", () => {
  const nothingSaved = () => { expect(api.createExamPaper).not.toHaveBeenCalled(); expect(mockNav.goBack).not.toHaveBeenCalled(); };

  it("asks for a title", async () => {
    await open();
    press("Save draft");
    expect(await screen.findByText("Give the paper a title, e.g. Mid-term Mathematics Paper 1.")).toBeTruthy();
    nothingSaved();
  });

  it("says how to type an opening time that is half typed", async () => {
    await open();
    typeTitle();
    fireEvent.changeText(screen.getByLabelText("Opens: date"), "20261111");
    fireEvent.changeText(screen.getByLabelText("Opens: time"), "8");
    press("Save draft");
    expect(await screen.findByText(/Type when the paper opens/)).toBeTruthy();
    nothingSaved();
  });

  it("will not take a paper that closes before it opens", async () => {
    await open();
    typeTitle();
    fireEvent.changeText(screen.getByLabelText("Closes (optional): date"), "20261111");
    fireEvent.changeText(screen.getByLabelText("Closes (optional): time"), "0700");
    press("Save draft");
    expect(await screen.findByText("The paper has to close after it opens.")).toBeTruthy();
    nothingSaved();
  });

  it("names the question that has nothing written", async () => {
    await open();
    typeTitle();
    fireEvent.press(screen.getByText("Add short answer"));
    press("Save draft");
    expect(await screen.findByText("Question 1 has no question written.")).toBeTruthy();
    nothingSaved();
  });

  it("will not publish an online paper with no questions, though it can be saved as a draft", async () => {
    await open();
    typeTitle();
    press("Save and publish");
    expect(await screen.findByText("Add at least one question before publishing.")).toBeTruthy();
    nothingSaved();
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
  });
});

describe("a read-only paper", () => {
  it("needs the paper uploaded or typed, and keeps no questions or time limit", async () => {
    await open();
    typeTitle();
    press("Read only");
    expect(screen.queryByText("Add multiple choice")).toBeNull();
    press("Save draft");
    expect(await screen.findByText("Upload the paper as a PDF or type it in.")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Or type the paper"), "1. Define a prime number.");
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.createExamPaper.mock.calls[0]![1]).toMatchObject({ mode: "read", body: "1. Define a prime number.", durationMinutes: null });
    expect(api.savePaperBody).toHaveBeenCalledWith("paper-new", "1. Define a prime number.");
    expect(api.saveExamQuestions).not.toHaveBeenCalled();
  });

  it("is saved with a PDF alone, uploaded under the paper's own id", async () => {
    await open();
    typeTitle();
    press("Read only");
    press("Choose a PDF or picture");
    expect(await screen.findByText(/paper\.pdf/)).toBeTruthy();
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.uploadExamPaperFile).toHaveBeenCalledWith("s-1", "paper-new", PDF);
    expect(api.setPaperFile).toHaveBeenCalledWith("paper-new", { path: "s-1/exam-papers/paper-new/1-paper.pdf", name: "paper.pdf" });
  });

  it("refuses a file over the phone's limit and says which", async () => {
    api.pickFile.mockResolvedValue({ ...PDF, name: "scan.pdf", sizeBytes: 60 * 1024 ** 2 });
    await open();
    press("Read only");
    press("Choose a PDF or picture");
    expect(await screen.findByText(/"scan\.pdf" is 60 MB\. Files can be up to 50 MB\./)).toBeTruthy();
    expect(screen.queryByText(/scan\.pdf ·/)).toBeNull();
  });
});

describe("changing a paper that is already saved", () => {
  it("shows its questions once they have loaded, and updates it instead of creating another", async () => {
    api.fetchPaperContent.mockResolvedValue({
      body: "",
      questions: [{ id: "q-1", kind: "short", prompt: "Name a prime.", options: [], points: 2, correctOption: null, modelAnswer: "2, 3 or 5" }],
    });
    await open(existing());
    expect(await screen.findByDisplayValue("Name a prime.")).toBeTruthy();
    expect(screen.getByDisplayValue("Mid-term Chemistry")).toBeTruthy();
    expect(screen.getByDisplayValue("45")).toBeTruthy();
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.createExamPaper).not.toHaveBeenCalled();
    expect(api.updateExamPaper).toHaveBeenCalledWith("paper-1", expect.objectContaining({ title: "Mid-term Chemistry", durationMinutes: 45 }));
    expect(api.saveExamQuestions).toHaveBeenCalledWith("paper-1", [expect.objectContaining({ prompt: "Name a prime.", points: 2, modelAnswer: "2, 3 or 5" })]);
  });

  it("cannot be saved before its questions have loaded, so they are not wiped", async () => {
    api.fetchPaperContent.mockReturnValue(new Promise(() => {}));
    await open(existing());
    press("Save draft");
    await act(async () => {});
    expect(api.updateExamPaper).not.toHaveBeenCalled();
    expect(api.saveExamQuestions).not.toHaveBeenCalled();
  });

  it("says so, and cannot be saved, when its questions could not be loaded", async () => {
    api.fetchPaperContent.mockRejectedValue(new Error("offline"));
    await open(existing());
    expect(await screen.findByText(/Could not load this paper's questions/)).toBeTruthy();
    press("Save draft");
    await act(async () => {});
    expect(api.updateExamPaper).not.toHaveBeenCalled();
  });

  it("is already published: offers Save changes, not Save and publish, and does not publish it again", async () => {
    await open(existing({ publishedAt: "2026-11-09T00:00:00.000Z" }));
    expect(screen.queryByText("Save and publish")).toBeNull();
    fireEvent.press(await screen.findByText("Add multiple choice"));
    fireEvent.changeText(screen.getByLabelText("Question 1"), "x?");
    fireEvent.changeText(screen.getByLabelText("Option A"), "a");
    fireEvent.changeText(screen.getByLabelText("Option B"), "b");
    fireEvent.press(screen.getByLabelText("Option A is correct"));
    press("Save changes");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.setPaperPublished).not.toHaveBeenCalled();
  });

  it("can have its reference file taken off", async () => {
    await open(existing({ filePath: "s-1/exam-papers/paper-1/sheet.pdf", fileName: "sheet.pdf", questionCount: 1 }));
    fireEvent.press(await screen.findByText("Add short answer"));
    fireEvent.changeText(screen.getByLabelText("Question 1"), "Why?");
    expect(screen.getByText("sheet.pdf")).toBeTruthy();
    press("Remove file");
    expect(screen.queryByText("sheet.pdf")).toBeNull();
    press("Save draft");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.setPaperFile).toHaveBeenCalledWith("paper-1", null);
  });
});

describe("a paper learners have already started", () => {
  it("says what is fixed, shows no way to change the questions, and saves only the paper's own fields", async () => {
    api.fetchPaperContent.mockResolvedValue({
      body: "",
      questions: [{ id: "q-1", kind: "short", prompt: "Name a prime.", options: [], points: 2, correctOption: null, modelAnswer: "" }],
    });
    await open(existing({ attemptCount: 3, publishedAt: "2026-11-09T00:00:00.000Z" }));
    expect(screen.getByText(/Learners have already started this paper/)).toBeTruthy();
    expect(await screen.findByDisplayValue("Name a prime.")).toBeTruthy();
    expect(screen.queryByText("Add multiple choice")).toBeNull();
    typeTitle("Mid-term Chemistry (corrected)");
    press("Save changes");
    await waitFor(() => expect(mockNav.goBack).toHaveBeenCalled());
    expect(api.updateExamPaper).toHaveBeenCalledWith("paper-1", expect.objectContaining({ title: "Mid-term Chemistry (corrected)" }));
    expect(api.saveExamQuestions).not.toHaveBeenCalled();
  });
});

describe("a teacher with no classes", () => {
  it("is told to ask the school admin, with nothing to fill in", async () => {
    api.fetchTeacherClasses.mockResolvedValue([]);
    render(<TeacherExamPaperEditor session={session} route={{}} />);
    expect(await screen.findByText(/You aren't assigned to any classes yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});
