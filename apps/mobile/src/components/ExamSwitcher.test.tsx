import { fireEvent, render, screen } from "@testing-library/react-native";
import { ExamSwitcher } from "./ExamSwitcher";

const mock1 = { id: "e1", name: "Mock 1", subjectCount: 9 };
const cat2 = { id: "e2", name: "CAT 2", subjectCount: 1 };
const tint = "#7A1F2B";

describe("ExamSwitcher", () => {
  it("shows nothing when there is only one exam to look at", () => {
    const { toJSON } = render(<ExamSwitcher exams={[mock1]} value="e1" onPick={() => {}} tint={tint} />);
    expect(toJSON()).toBeNull();
  });

  it("shows nothing when there are no exams yet", () => {
    const { toJSON } = render(<ExamSwitcher exams={[]} value={null} onPick={() => {}} tint={tint} />);
    expect(toJSON()).toBeNull();
  });

  it("says how many subjects each exam has, and uses the singular for one", () => {
    render(<ExamSwitcher exams={[mock1, cat2]} value="e1" onPick={() => {}} tint={tint} />);
    expect(screen.getByText("Mock 1 · 9 subjects")).toBeTruthy();
    expect(screen.getByText("CAT 2 · 1 subject")).toBeTruthy();
  });

  it("marks the exam being shown as selected", () => {
    render(<ExamSwitcher exams={[mock1, cat2]} value="e2" onPick={() => {}} tint={tint} />);
    expect(screen.getByRole("button", { name: "CAT 2 · 1 subject", selected: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mock 1 · 9 subjects", selected: true })).toBeNull();
  });

  it("picks the exam that was tapped", () => {
    const onPick = jest.fn();
    render(<ExamSwitcher exams={[mock1, cat2]} value="e1" onPick={onPick} tint={tint} />);
    fireEvent.press(screen.getByText("CAT 2 · 1 subject"));
    expect(onPick).toHaveBeenCalledWith("e2");
  });
});
