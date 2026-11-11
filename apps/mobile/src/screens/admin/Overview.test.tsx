import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { formatMoney, today, type LatestRegisters, type SchoolOverview, type Term } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { LatestRegistersSection, OverviewSections } from "./Overview";

// What a principal reads first: the school's overview (attendance by class, fees, what needs them) as figures, and
// from it the way into a class's register and the reminder to a teacher who has not taken one.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), remindClassTeacher: jest.fn() }));

const remindClassTeacher = shared.remindClassTeacher as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Principal",
};

/** Form 1A took today's register (27 of 30 here, 2 of them late, 3 absent); Form 1B has not; Form 2A has not and has no class teacher. */
function overview(over: Partial<SchoolOverview> = {}): SchoolOverview {
  return {
    term: { name: "Term 3, 2026" } as Term,
    classes: [
      { id: "c1", name: "Form 1A", class_teacher_id: "t1" },
      { id: "c2", name: "Form 1B", class_teacher_id: "t2" },
      { id: "c3", name: "Form 2A", class_teacher_id: null },
    ],
    studentsByClass: new Map([["c1", 30], ["c2", 28], ["c3", 25]]),
    activeStudents: 83,
    staffCount: 12,
    fees: { billed: 1_000_000, paid: 400_000, invoices: 10, nothing_paid: 2, part_paid: 3, full_paid: 5, owing: 5 },
    attendanceDate: today(),
    presentByClass: new Map([["c1", 27]]),
    lateByClass: new Map([["c1", 2]]),
    absentByClass: new Map([["c1", 3]]),
    submittedClasses: new Set(["c1"]),
    ...over,
  };
}

/** The theme shows nothing until it has read the person's saved choice, so each test waits for the first section. */
async function show(data: SchoolOverview, onOpen = jest.fn()) {
  render(<ThemeProvider><OverviewSections session={session} data={data} onOpen={onOpen} /></ThemeProvider>);
  await screen.findByText("Needs you");
  return onOpen;
}

beforeEach(() => { remindClassTeacher.mockReset().mockResolvedValue(undefined); });

describe("the overview's figures", () => {
  it("names the term and says in a line how the school is doing", async () => {
    await show(overview());
    expect(screen.getByText("TERM 3, 2026")).toBeTruthy();
    expect(screen.getByText(/1 of 3 classes have submitted attendance and fee collection stands at 40%\. 2 things need you\./)).toBeTruthy();
  });

  it("shows attendance across the classes that took a register, fees collected, learners and staff", async () => {
    await show(overview());
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("1 of 3 classes submitted")).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByText(`${formatMoney(400_000, "KE")} of ${formatMoney(1_000_000, "KE")}`)).toBeTruthy();
    expect(screen.getByText("83")).toBeTruthy();
    expect(screen.getByText("across 3 classes")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("shows a dash, not 0%, when no class has taken a register", async () => {
    await show(overview({ attendanceDate: null, presentByClass: new Map(), lateByClass: new Map(), absentByClass: new Map(), submittedClasses: new Set() }));
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("No class has taken a register this term yet.")).toBeTruthy();
  });

  it("says what needs the principal, and when nothing does", async () => {
    await show(overview());
    expect(screen.getByText("2 classes have not taken attendance")).toBeTruthy();
    expect(screen.getByText(`Form 1B, Form 2A for ${today()}.`)).toBeTruthy();
    expect(screen.getByText("Term 3, 2026 fee balances are outstanding")).toBeTruthy();
  });

  it("says nothing needs them when every class has taken it and nobody owes", async () => {
    await show(overview({
      fees: { billed: 100, paid: 100, invoices: 1, nothing_paid: 0, part_paid: 0, full_paid: 1, owing: 0 },
      submittedClasses: new Set(["c1", "c2", "c3"]),
    }));
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
    expect(screen.getByText(/Nothing needs you\./)).toBeTruthy();
  });

  it("splits this term's invoices into paid in full, part paid and nothing paid", async () => {
    await show(overview());
    expect(screen.getByText("Paid in full")).toBeTruthy();
    expect(screen.getByText("Part paid")).toBeTruthy();
    expect(screen.getByText("Nothing paid")).toBeTruthy();
  });
});

describe("attendance by class", () => {
  it("shows each class that took the register with who was here, and how many were late or absent", async () => {
    await show(overview());
    expect(screen.getByText("Attendance by class · today")).toBeTruthy();
    expect(screen.getByText("27 / 30")).toBeTruthy();
    expect(screen.getByText("2 late · 3 absent")).toBeTruthy();
  });

  it("opens that class's register for that day when its row is tapped", async () => {
    const onOpen = await show(overview());
    fireEvent.press(screen.getByLabelText("Form 1A, 27 of 30 here. See who wasn't"));
    expect(onOpen).toHaveBeenCalledWith({ classId: "c1", className: "Form 1A", date: today() });
  });

  it("marks a class that has not taken it, and offers to remind its teacher", async () => {
    await show(overview());
    expect(screen.getAllByText("Not taken")).toHaveLength(2);
    expect(screen.getAllByText("Remind teacher")).toHaveLength(1);
    expect(screen.getByText("No class teacher is set for this class.")).toBeTruthy();
  });

  it("sends the reminder to that class's teacher, from the person asking, and says it went", async () => {
    await show(overview());
    await act(async () => { fireEvent.press(screen.getByText("Remind teacher")); });
    expect(remindClassTeacher).toHaveBeenCalledWith("school-1", "grace", { id: "c2", name: "Form 1B", class_teacher_id: "t2" });
    expect(await screen.findByText("Reminder sent to the class teacher.")).toBeTruthy();
    expect(screen.queryByText("Remind teacher")).toBeNull();
  });

  it("says why when the reminder could not be sent, and lets them try again", async () => {
    remindClassTeacher.mockRejectedValueOnce(new Error("row-level security"));
    await show(overview());
    await act(async () => { fireEvent.press(screen.getByText("Remind teacher")); });
    expect(await screen.findByText("Could not send the reminder: row-level security")).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText("Remind teacher")); });
    expect(remindClassTeacher).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Reminder sent to the class teacher.")).toBeTruthy();
  });

  it("says the registers are from an earlier day when no class has taken today's", async () => {
    await show(overview({ attendanceDate: "2020-03-04" }));
    expect(screen.getByText("Attendance by class · Wed 4 Mar")).toBeTruthy();
    expect(screen.getByText("No class has taken today's register yet. These are from Wed 4 Mar, the last one taken.")).toBeTruthy();
  });

  it("says so when the school has no classes", async () => {
    await show(overview({ classes: [], studentsByClass: new Map(), submittedClasses: new Set(), presentByClass: new Map(), lateByClass: new Map(), absentByClass: new Map() }));
    expect(screen.getByText("No classes have been set up yet.")).toBeTruthy();
  });
});

describe("the registers for someone who holds the attendance area", () => {
  function registers(over: Partial<LatestRegisters> = {}): LatestRegisters {
    return {
      date: today(),
      classes: [{ id: "c1", name: "Form 1A" }, { id: "c2", name: "Form 1B" }],
      learners: new Map([["c1", 30], ["c2", 28]]),
      present: new Map([["c1", 27]]),
      taken: new Set(["c1"]),
      ...over,
    };
  }

  async function showRegisters(data: LatestRegisters, onOpen = jest.fn()) {
    render(<ThemeProvider><LatestRegistersSection data={data} onOpen={onOpen} /></ThemeProvider>);
    await screen.findByText("Attendance by class · today");
    return onOpen;
  }

  it("lists each class's latest register, opens one to read, and marks the one not taken, with no reminder to send", async () => {
    const onOpen = await showRegisters(registers());
    expect(screen.getByText("27 / 30")).toBeTruthy();
    expect(screen.getByText("Not taken")).toBeTruthy();
    expect(screen.queryByText("Remind teacher")).toBeNull();
    fireEvent.press(screen.getByLabelText("Form 1A, 27 of 30 here. See who wasn't"));
    expect(onOpen).toHaveBeenCalledWith({ classId: "c1", className: "Form 1A", date: today() });
  });

  it("says so when no class has taken a register yet", async () => {
    render(<ThemeProvider><LatestRegistersSection data={registers({ date: null, taken: new Set() })} onOpen={jest.fn()} /></ThemeProvider>);
    expect(await screen.findByText("No class has taken a register yet.")).toBeTruthy();
  });
});
