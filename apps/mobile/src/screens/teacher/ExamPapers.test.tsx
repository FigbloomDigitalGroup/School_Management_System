import { Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { ExamPaperRow } from "@figbloom/shared";
import { TeacherExamPapers } from "./ExamPapers";
import type { TeacherSession } from "../../teacherNavigation";

// The icon library ships as untranspiled ES modules; the icons are not what this tests.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : () => null) }));
const mockNav = { navigate: jest.fn(), goBack: jest.fn(), canGoBack: () => true };
jest.mock("@react-navigation/native", () => {
  const { useEffect } = jest.requireActual("react");
  return { useNavigation: () => mockNav, useFocusEffect: (callback: () => void | (() => void)) => { useEffect(callback, [callback]); } };
});
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchExamPapers: jest.fn(), fetchMyTeachingPairs: jest.fn(), fetchTeacherClasses: jest.fn(), fetchClassSizes: jest.fn(),
  savedPaperPublishProblem: jest.fn(), setPaperPublished: jest.fn(), deleteExamPaper: jest.fn(),
}));

const mocked = (fn: unknown) => fn as jest.Mock;
const api = {
  fetchExamPapers: mocked(shared.fetchExamPapers),
  fetchMyTeachingPairs: mocked(shared.fetchMyTeachingPairs),
  fetchTeacherClasses: mocked(shared.fetchTeacherClasses),
  fetchClassSizes: mocked(shared.fetchClassSizes),
  savedPaperPublishProblem: mocked(shared.savedPaperPublishProblem),
  setPaperPublished: mocked(shared.setPaperPublished),
  deleteExamPaper: mocked(shared.deleteExamPaper),
};
const session: TeacherSession = { profileId: "t-1", tenantId: "s-1", fullName: "Teacher Two", accent: "forest", country: "KE" };

const paper = (over: Partial<ExamPaperRow>): ExamPaperRow => ({
  id: "p1", kind: "exam", title: "Mid-term Chemistry", instructions: "", classId: "c-1", className: "Form 2 West", subjectId: "sub-1", subjectName: "Chemistry",
  examId: null, examName: null, mode: "online", filePath: null, fileName: null, opensAt: "2026-11-12T05:00:00.000Z", closesAt: null, durationMinutes: 60,
  publishedAt: null, resultsReleasedAt: null, questionCount: 5, attemptCount: 0, ...over,
});
const draft = paper({});
const sat = paper({ id: "p2", kind: "assessment", title: "CAT 1", opensAt: "2026-11-10T05:00:00.000Z", publishedAt: "2026-11-09T00:00:00.000Z", attemptCount: 3, durationMinutes: 30 });
const someoneElses = paper({ id: "p3", title: "Biology paper", classId: "c-2", subjectId: "sub-9", className: "Form 4", subjectName: "Biology" });

let alert: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] }).setSystemTime(new Date("2026-11-10T10:00:00Z"));
  mockNav.navigate.mockReset();
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  api.fetchExamPapers.mockReset().mockResolvedValue([draft, sat, someoneElses]);
  api.fetchMyTeachingPairs.mockResolvedValue(new Set(["c-1:sub-1"]));
  api.fetchTeacherClasses.mockResolvedValue([{ id: "c-1", name: "Form 2 West" }]);
  api.fetchClassSizes.mockResolvedValue({ "c-1": 30 });
  api.savedPaperPublishProblem.mockReset().mockResolvedValue(null);
  api.setPaperPublished.mockReset().mockResolvedValue(undefined);
  api.deleteExamPaper.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { jest.useRealTimers(); alert.mockRestore(); });

async function open() {
  render(<TeacherExamPapers session={session} />);
  await screen.findByText("Mid-term Chemistry");
  await act(async () => {});
}
/** Every card has an Edit button, in the order the papers are listed. */
const pressEdit = (card: number) => fireEvent.press(screen.getAllByText("Edit")[card]!);

describe("the list", () => {
  it("shows only the papers for the classes and subjects this teacher teaches", async () => {
    await open();
    expect(screen.getByText("CAT 1")).toBeTruthy();
    expect(screen.queryByText("Biology paper")).toBeNull();
  });

  it("says what each paper is: its type, class and subject, status, how it is taken, and who has sat it", async () => {
    await open();
    expect(screen.getByText("EXAM · Form 2 West · Chemistry")).toBeTruthy();
    expect(screen.getByText("TEST / CAT · Form 2 West · Chemistry")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Open now")).toBeTruthy();
    expect(screen.getByText("Sat online · 60 min · 0 of 30 have sat it")).toBeTruthy();
    expect(screen.getByText("Sat online · 30 min · 3 of 30 have sat it")).toBeTruthy();
  });

  it("never says more learners have sat a paper than the class has", async () => {
    api.fetchExamPapers.mockResolvedValue([paper({ attemptCount: 40 })]);
    await open();
    expect(screen.getByText(/30 of 30 have sat it/)).toBeTruthy();
  });

  it("does not count who has sat a read-only paper", async () => {
    api.fetchExamPapers.mockResolvedValue([paper({ mode: "read", durationMinutes: null })]);
    await open();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.queryByText(/have sat it/)).toBeNull();
  });
});

describe("opening the editor", () => {
  it("starts a new paper, and edits an existing one with its row", async () => {
    await open();
    fireEvent.press(screen.getByText("New paper"));
    expect(mockNav.navigate).toHaveBeenCalledWith("ExamPaperEditor");
    pressEdit(1);
    expect(mockNav.navigate).toHaveBeenCalledWith("ExamPaperEditor", { paper: sat });
  });
});

describe("publishing", () => {
  it("publishes a draft the checks allow, says so, and reads the list again", async () => {
    await open();
    fireEvent.press(screen.getByText("Publish"));
    expect(await screen.findByText("Published. Form 2 West can see it now.")).toBeTruthy();
    expect(api.setPaperPublished).toHaveBeenCalledWith("p1", true);
    expect(api.fetchExamPapers).toHaveBeenCalledTimes(2);
  });

  it("does not publish a draft the checks refuse, and says why", async () => {
    api.savedPaperPublishProblem.mockResolvedValue("Add at least one question before publishing.");
    await open();
    fireEvent.press(screen.getByText("Publish"));
    expect(await screen.findByText("Add at least one question before publishing.")).toBeTruthy();
    expect(api.setPaperPublished).not.toHaveBeenCalled();
  });

  it("asks before unpublishing a paper, and does it only if told to", async () => {
    await open();
    fireEvent.press(screen.getByText("Unpublish"));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(api.setPaperPublished).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Unpublish")!.onPress!(); });
    await waitFor(() => expect(api.setPaperPublished).toHaveBeenCalledWith("p2", false));
    expect(await screen.findByText("Unpublished. Only staff can see it now.")).toBeTruthy();
  });

  it("shows the error and keeps the list when publishing fails", async () => {
    api.setPaperPublished.mockRejectedValue(new Error("You can only change papers for a class and subject you teach."));
    await open();
    fireEvent.press(screen.getByText("Publish"));
    expect(await screen.findByText("You can only change papers for a class and subject you teach.")).toBeTruthy();
    expect(screen.getByText("Mid-term Chemistry")).toBeTruthy();
  });
});

describe("deleting", () => {
  it("is offered only for a paper nobody has started", async () => {
    await open();
    expect(screen.getAllByText("Delete")).toHaveLength(1);
  });

  it("asks first, and deletes only if told to", async () => {
    await open();
    fireEvent.press(screen.getByText("Delete"));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(api.deleteExamPaper).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Delete")!.onPress!(); });
    await waitFor(() => expect(api.deleteExamPaper).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("Deleted.")).toBeTruthy();
  });
});

describe("when there is nothing to show", () => {
  it("says there are no papers yet, with the way to add one still on screen", async () => {
    api.fetchExamPapers.mockResolvedValue([]);
    render(<TeacherExamPapers session={session} />);
    expect(await screen.findByText("No papers yet")).toBeTruthy();
    expect(screen.getByText("New paper")).toBeTruthy();
  });

  it("tells a teacher with no classes to ask the school admin, with no New paper button", async () => {
    api.fetchExamPapers.mockResolvedValue([]);
    api.fetchTeacherClasses.mockResolvedValue([]);
    render(<TeacherExamPapers session={session} />);
    expect(await screen.findByText("No classes yet")).toBeTruthy();
    expect(screen.queryByText("New paper")).toBeNull();
  });

  it("offers to try again when the papers cannot be loaded", async () => {
    api.fetchExamPapers.mockRejectedValueOnce(new Error("offline"));
    render(<TeacherExamPapers session={session} />);
    expect(await screen.findByText("Couldn't load your papers")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Mid-term Chemistry")).toBeTruthy();
  });
});
