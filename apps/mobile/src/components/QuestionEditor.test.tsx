import { useState } from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { blankQuestion, type QuestionDraft } from "@figbloom/shared";
import { QuestionEditor } from "./QuestionEditor";

// The icon library ships as untranspiled ES modules; the icons are not what this tests.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : () => null) }));

let latest: QuestionDraft[] = [];
function Harness({ start = [], locked = false }: { start?: QuestionDraft[]; locked?: boolean }) {
  const [questions, setQuestions] = useState<QuestionDraft[]>(start);
  latest = questions;
  return <QuestionEditor questions={questions} onChange={setQuestions} locked={locked} accent="forest" />;
}

const choice = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({ ...blankQuestion("choice"), prompt: "2 + 2?", options: ["3", "4", "5"], correctOption: 1, ...over });
const written = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({ ...blankQuestion("short"), prompt: "Name a prime.", ...over });

/** The screen renders nothing until the theme has read its stored choice. */
async function show(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  await screen.findByText("Questions");
}

let alert: jest.SpyInstance;
beforeEach(() => { alert = jest.spyOn(Alert, "alert").mockImplementation(() => {}); });
afterEach(() => alert.mockRestore());

describe("adding questions", () => {
  it("starts empty and says so", async () => {
    await show();
    expect(screen.getByText("No questions yet. Add the first one below.")).toBeTruthy();
    expect(screen.getByText("0 marks in total")).toBeTruthy();
  });

  it("adds a multiple choice question with two empty options, and a short and a long answer", async () => {
    await show();
    fireEvent.press(screen.getByText("Add multiple choice"));
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ kind: "choice", options: ["", ""], points: 1, correctOption: null });
    fireEvent.press(screen.getByText("Add short answer"));
    fireEvent.press(screen.getByText("Add long answer"));
    expect(latest.map((q) => q.kind)).toEqual(["choice", "short", "long"]);
    expect(screen.getByText("3 marks in total")).toBeTruthy();
  });
});

describe("editing a question", () => {
  it("takes the question, the marks and an option's text", async () => {
    await show({ start: [choice()] });
    fireEvent.changeText(screen.getByLabelText("Question 1"), "3 + 3?");
    fireEvent.changeText(screen.getByLabelText("Marks"), "4");
    fireEvent.changeText(screen.getByLabelText("Option A"), "6");
    expect(latest[0]).toMatchObject({ prompt: "3 + 3?", points: 4 });
    expect(latest[0]!.options[0]).toBe("6");
    expect(screen.getByText("4 marks in total")).toBeTruthy();
  });

  it("marks the correct option, and only one", async () => {
    await show({ start: [choice({ correctOption: null })] });
    fireEvent.press(screen.getByLabelText("Option C is correct"));
    expect(latest[0]!.correctOption).toBe(2);
    expect(screen.getByLabelText("Option C is correct").props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByLabelText("Option B is correct").props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(screen.getByLabelText("Option A is correct"));
    expect(latest[0]!.correctOption).toBe(0);
  });

  it("does not count an emptied marks box as NaN while the teacher types the next number", async () => {
    await show({ start: [choice({ points: 3 })] });
    fireEvent.changeText(screen.getByLabelText("Marks"), "");
    expect(screen.getByText("0 marks in total")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
    fireEvent.changeText(screen.getByLabelText("Marks"), "5");
    expect(screen.getByText("5 marks in total")).toBeTruthy();
  });

  it("keeps only digits in the marks box", async () => {
    await show({ start: [choice()] });
    fireEvent.changeText(screen.getByLabelText("Marks"), "1a2");
    expect(latest[0]!.points).toBe(12);
  });

  it("turns a multiple choice question into a written one: the options and the key go, a model answer box appears", async () => {
    await show({ start: [choice()] });
    fireEvent.press(screen.getByText("Short answer"));
    expect(latest[0]).toMatchObject({ kind: "short", options: [], correctOption: null, prompt: "2 + 2?" });
    expect(screen.queryByLabelText("Option A")).toBeNull();
    fireEvent.changeText(screen.getByLabelText("Model answer (optional)"), "4, because 2 and 2 make 4");
    expect(latest[0]!.modelAnswer).toBe("4, because 2 and 2 make 4");
  });

  it("turns a written question into a multiple choice one with two empty options", async () => {
    await show({ start: [written()] });
    fireEvent.press(screen.getByText("Multiple choice"));
    expect(latest[0]).toMatchObject({ kind: "choice", options: ["", ""], correctOption: null });
  });
});

describe("options", () => {
  it("adds an option, up to eight, and removes one", async () => {
    await show({ start: [choice({ options: ["1", "2", "3", "4", "5", "6", "7"], correctOption: 0 })] });
    fireEvent.press(screen.getByText("Add an option"));
    expect(latest[0]!.options).toHaveLength(8);
    expect(screen.queryByText("Add an option")).toBeNull();
    fireEvent.press(screen.getByLabelText("Remove option H"));
    expect(latest[0]!.options).toHaveLength(7);
  });

  it("moves the key down with its option when an option before it is removed", async () => {
    await show({ start: [choice({ options: ["a", "b", "c"], correctOption: 2 })] });
    fireEvent.press(screen.getByLabelText("Remove option A"));
    expect(latest[0]).toMatchObject({ options: ["b", "c"], correctOption: 1 });
    expect(screen.getByLabelText("Option B is correct").props.accessibilityState).toMatchObject({ checked: true });
  });

  it("clears the key when the keyed option itself is removed", async () => {
    await show({ start: [choice({ options: ["a", "b", "c"], correctOption: 1 })] });
    fireEvent.press(screen.getByLabelText("Remove option B"));
    expect(latest[0]).toMatchObject({ options: ["a", "c"], correctOption: null });
  });

  it("offers no remove button when only two options are left", async () => {
    await show({ start: [choice({ options: ["a", "b"], correctOption: 0 })] });
    expect(screen.queryByLabelText("Remove option A")).toBeNull();
  });
});

describe("moving and removing questions", () => {
  const two = () => [choice({ prompt: "First" }), written({ prompt: "Second" })];

  it("moves a question down and up", async () => {
    await show({ start: two() });
    fireEvent.press(screen.getAllByText("Move down")[0]!);
    expect(latest.map((q) => q.prompt)).toEqual(["Second", "First"]);
    fireEvent.press(screen.getAllByText("Move up")[1]!);
    expect(latest.map((q) => q.prompt)).toEqual(["First", "Second"]);
  });

  it("will not move the first question up or the last one down", async () => {
    await show({ start: two() });
    fireEvent.press(screen.getAllByText("Move up")[0]!);
    fireEvent.press(screen.getAllByText("Move down")[1]!);
    expect(latest.map((q) => q.prompt)).toEqual(["First", "Second"]);
  });

  it("asks before removing a question that has something typed in it, and removes it only if told to", async () => {
    await show({ start: two() });
    fireEvent.press(screen.getAllByText("Remove")[0]!);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(latest).toHaveLength(2);
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Remove")!.onPress!(); });
    expect(latest.map((q) => q.prompt)).toEqual(["Second"]);
  });

  it("removes an empty question at once, without asking", async () => {
    await show({ start: [blankQuestion("short")] });
    fireEvent.press(screen.getByText("Remove"));
    expect(alert).not.toHaveBeenCalled();
    expect(latest).toHaveLength(0);
  });
});

describe("a paper learners have already started", () => {
  it("shows the questions and offers no way to change them", async () => {
    await show({ start: [choice(), written()], locked: true });
    expect(screen.getByText("Multiple choice")).toBeTruthy();
    expect(screen.queryByText("Add multiple choice")).toBeNull();
    expect(screen.queryByText("Move down")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Add an option")).toBeNull();
    expect(screen.queryByLabelText("Remove option A")).toBeNull();
    expect(screen.getByLabelText("Question 1").props.editable).toBe(false);
    expect(screen.getAllByLabelText("Marks")[0]!.props.editable).toBe(false);
  });

  it("does not change the key when an option's circle is tapped", async () => {
    await show({ start: [choice()], locked: true });
    fireEvent.press(screen.getByLabelText("Option A is correct"));
    expect(latest[0]!.correctOption).toBe(1);
  });
});
