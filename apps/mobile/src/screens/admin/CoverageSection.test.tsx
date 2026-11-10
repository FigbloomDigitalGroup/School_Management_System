import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { CoverageItem } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { CoverageSection } from "./CoverageSection";

// Periods this week whose teacher is on approved leave: choose a substitute, or mark the period free.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), assignCoverage: jest.fn() }));

const assignCoverage = shared.assignCoverage as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

const item = (over: Partial<CoverageItem> = {}): CoverageItem => ({
  date: "2026-11-04", weekday: "Wed", classId: "c1", className: "Form 1A", time: "10:00", subjectId: "math", subjectName: "Mathematics",
  absentTeacherId: "t-ann", absentTeacherName: "Ann Wanjiru", substitutes: [{ id: "t-dan", name: "Dan Otieno" }, { id: "t-eve", name: "Eve Kamau" }], assignment: null,
  ...over,
});

beforeEach(() => { assignCoverage.mockReset().mockResolvedValue(undefined); });

async function show(items: CoverageItem[], onChanged = jest.fn()) {
  render(<ThemeProvider><CoverageSection session={session} items={items} onChanged={onChanged} /></ThemeProvider>);
  await screen.findByText(/Needs cover this week/, {}, { timeout: 5000 });
  return onChanged;
}

describe("needs cover this week", () => {
  it("says which period, when, and whose leave leaves it without a teacher, and how many are still to arrange", async () => {
    await show([item(), item({ classId: "c2", className: "Form 1B", assignment: { coveringTeacherId: "t-dan", coveringTeacherName: "Dan Otieno", assignedAt: "x" } })]);
    expect(screen.getByText("Needs cover this week · 1")).toBeTruthy();
    expect(screen.getByText("Mathematics · Form 1A")).toBeTruthy();
    expect(screen.getAllByText("Wed 10:00")).toHaveLength(2);
    expect(screen.getAllByText("Ann Wanjiru is on approved leave 4 Nov.")).toHaveLength(2);
  });

  it("shows nothing at all when no period needs cover", () => {
    render(<ThemeProvider><CoverageSection session={session} items={[]} onChanged={jest.fn()} /></ThemeProvider>);
    expect(screen.queryByText(/Needs cover this week/)).toBeNull();
  });

  it("assigns the substitute picked, for that exact period, then lets the screen read the list again", async () => {
    const onChanged = await show([item()]);
    fireEvent.press(screen.getByText("Eve Kamau"));
    await act(async () => { fireEvent.press(screen.getByText("Assign")); });
    expect(assignCoverage).toHaveBeenCalledWith({
      tenantId: "school-1", assignedBy: "grace", item: expect.objectContaining({ date: "2026-11-04", classId: "c1", time: "10:00", subjectId: "math", absentTeacherId: "t-ann" }), coveringTeacherId: "t-eve",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("will not assign until someone is picked", async () => {
    await show([item()]);
    fireEvent.press(screen.getByText("Assign"));
    expect(assignCoverage).not.toHaveBeenCalled();
  });

  it("marks a period as free, which names nobody", async () => {
    const onChanged = await show([item()]);
    await act(async () => { fireEvent.press(screen.getByText("Mark free period")); });
    expect(assignCoverage).toHaveBeenCalledWith(expect.objectContaining({ coveringTeacherId: null }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("says nobody else teaches the subject when nobody does, and still lets the period be marked free", async () => {
    await show([item({ substitutes: [] })]);
    expect(screen.getByText("Nobody else on file teaches this.")).toBeTruthy();
    expect(screen.getByText("Mark free period")).toBeTruthy();
  });

  it("shows what was decided, and changes it on request", async () => {
    await show([item({ assignment: { coveringTeacherId: "t-dan", coveringTeacherName: "Dan Otieno", assignedAt: "x" } }), item({ classId: "c2", className: "Form 1B", assignment: { coveringTeacherId: null, coveringTeacherName: null, assignedAt: "x" } })]);
    expect(screen.getByText("Covered by Dan Otieno")).toBeTruthy();
    expect(screen.getByText("Marked as a free period")).toBeTruthy();
    expect(screen.getByText("Needs cover this week · 0")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Change cover for Mathematics, Form 1A"));
    expect(screen.getByText("Assign")).toBeTruthy();
    expect(screen.getByText("Eve Kamau")).toBeTruthy();
  });

  it("says why it could not save, such as a teacher who is teaching another class then", async () => {
    assignCoverage.mockRejectedValue(new Error("That teacher is teaching another class at that time. Choose someone who is free."));
    const onChanged = await show([item()]);
    fireEvent.press(screen.getByText("Dan Otieno"));
    await act(async () => { fireEvent.press(screen.getByText("Assign")); });
    expect(await screen.findByText("Could not save: That teacher is teaching another class at that time. Choose someone who is free.")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
