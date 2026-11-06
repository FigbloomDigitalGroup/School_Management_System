import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { today, type LatestRegisters, type SchoolOverview, type Term } from "@figbloom/shared";
import { ConsoleSwitchProvider } from "../../lib/consoleSwitch";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminHome, webConsoleUrl } from "./Home";

// The admin side's front page: the overview for a full admin, the areas (and registers) for staff who hold some.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchSchoolOverview: jest.fn(), fetchLatestRegisters: jest.fn(), fetchCoverageThisWeek: jest.fn() }));

const fetchSchoolOverview = shared.fetchSchoolOverview as unknown as jest.Mock;
const fetchLatestRegisters = shared.fetchLatestRegisters as unknown as jest.Mock;
const fetchCoverageThisWeek = shared.fetchCoverageThisWeek as unknown as jest.Mock;

const base: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Principal",
};

const overview: SchoolOverview = {
  term: { name: "Term 3, 2026" } as Term,
  classes: [{ id: "c1", name: "Form 1A", class_teacher_id: "t1" }],
  studentsByClass: new Map([["c1", 30]]),
  activeStudents: 30,
  staffCount: 4,
  fees: { billed: 100, paid: 50, invoices: 2, nothing_paid: 1, part_paid: 0, full_paid: 1, owing: 1 },
  attendanceDate: today(),
  presentByClass: new Map([["c1", 27]]),
  lateByClass: new Map(),
  absentByClass: new Map(),
  submittedClasses: new Set(["c1"]),
};
const registers: LatestRegisters = {
  date: today(), classes: [{ id: "c1", name: "Form 1A" }], learners: new Map([["c1", 30]]), present: new Map([["c1", 27]]), taken: new Set(["c1"]),
};

beforeEach(() => {
  fetchSchoolOverview.mockReset().mockResolvedValue(overview);
  fetchLatestRegisters.mockReset().mockResolvedValue(registers);
  fetchCoverageThisWeek.mockReset().mockResolvedValue([]);
});

/** The theme shows nothing until it has read the person's saved choice, so every test waits for the school's name first. */
async function home(session: StaffSession, canSwitch = false, switchTo = jest.fn(), onOpenRegister = jest.fn()) {
  const view = render(
    <ThemeProvider>
      <ConsoleSwitchProvider value={{ current: "admin", canSwitch, switchTo }}>
        <AdminHome session={session} onOpenRegister={onOpenRegister} />
      </ConsoleSwitchProvider>
    </ThemeProvider>,
  );
  await screen.findByText(session.school.name);
  return view;
}

describe("the admin home", () => {
  it("names the school and the person, with their title", async () => {
    await home(base);
    expect(screen.getByText("Grace Njeri · Principal")).toBeTruthy();
  });

  it("opens a school admin on the overview of their school, not on a list of areas", async () => {
    await home(base);
    expect(await screen.findByText("Needs you")).toBeTruthy();
    expect(fetchSchoolOverview).toHaveBeenCalledWith("school-1");
    expect(fetchLatestRegisters).not.toHaveBeenCalled();
    expect(screen.queryByText("Your access")).toBeNull();
  });

  it("shows a school admin which periods this week need cover, under what needs them, and nothing when none do", async () => {
    fetchCoverageThisWeek.mockResolvedValue([{
      date: "2026-11-04", weekday: "Wed", classId: "c1", className: "Form 1A", time: "10:00", subjectId: "math", subjectName: "Mathematics",
      absentTeacherId: "t-ann", absentTeacherName: "Ann Wanjiru", substitutes: [], assignment: null,
    }]);
    await home(base);
    expect(await screen.findByText("Needs cover this week · 1")).toBeTruthy();
    expect(fetchCoverageThisWeek).toHaveBeenCalledWith("school-1");
  });

  it("does not hold the overview back, or break it, when the cover list cannot be read", async () => {
    fetchCoverageThisWeek.mockRejectedValue(new Error("Network request failed"));
    await home(base);
    expect(await screen.findByText("Needs you")).toBeTruthy();
    expect(await screen.findByText("Couldn't check who needs cover this week: Network request failed")).toBeTruthy();
  });

  it("hands a class's register to the navigator when its row is tapped", async () => {
    const onOpenRegister = jest.fn();
    await home(base, false, jest.fn(), onOpenRegister);
    fireEvent.press(await screen.findByLabelText("Form 1A, 27 of 30 here. See who wasn't"));
    expect(onOpenRegister).toHaveBeenCalledWith({ classId: "c1", className: "Form 1A", date: today() });
  });

  it("says why the overview could not load, and loads it again on request", async () => {
    fetchSchoolOverview.mockRejectedValueOnce(new Error("Network request failed"));
    await home(base);
    expect(await screen.findByText("Network request failed")).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText("Try again")); });
    expect(await screen.findByText("Needs you")).toBeTruthy();
    expect(fetchSchoolOverview).toHaveBeenCalledTimes(2);
  });

  it("lists exactly the areas a teacher or other staff member holds, in the words the office reads, and loads nothing for them", async () => {
    await home({ ...base, role: "teacher", title: null, adminAreas: ["fees", "leave"] });
    expect(screen.getByText("Grace Njeri")).toBeTruthy();
    expect(screen.getByText("Fees")).toBeTruthy();
    expect(screen.getByText("Leave")).toBeTruthy();
    expect(screen.getByText("Approve or decline staff leave requests.")).toBeTruthy();
    expect(screen.queryByText("Everything in the admin console")).toBeNull();
    expect(screen.queryByText("People")).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(fetchSchoolOverview).not.toHaveBeenCalled();
    expect(fetchLatestRegisters).not.toHaveBeenCalled();
    expect(fetchCoverageThisWeek).not.toHaveBeenCalled();
  });

  it("shows every class's latest register to someone who holds the attendance area, and not the school's fees", async () => {
    await home({ ...base, role: "staff", title: null, adminAreas: ["attendance"] });
    expect(await screen.findByText("Attendance by class · today")).toBeTruthy();
    expect(screen.getByText("27 / 30")).toBeTruthy();
    expect(fetchLatestRegisters).toHaveBeenCalledWith("school-1");
    expect(fetchSchoolOverview).not.toHaveBeenCalled();
    expect(screen.queryByText("Fees collected")).toBeNull();
    expect(screen.queryByText("Remind teacher")).toBeNull();
  });

  it("points to the web console of this school, for everything the phone does not do yet", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await home(base);
    await act(async () => { fireEvent.press(screen.getByText("Open the web console")); });
    expect(open).toHaveBeenCalledWith("https://schoolmanagement.figbloom.org/s/kijani/admin");
    expect(webConsoleUrl("kijani")).toBe("https://schoolmanagement.figbloom.org/s/kijani/admin");
    open.mockRestore();
  });

  it("offers a way back to the teacher screens only to someone who has both", async () => {
    const switchTo = jest.fn();
    const first = await home({ ...base, role: "teacher", adminAreas: ["fees"] }, true, switchTo);
    fireEvent.press(screen.getByText("Back to teacher screens"));
    expect(switchTo).toHaveBeenCalledWith("own");
    first.unmount();

    await home(base);
    expect(screen.queryByText("Back to teacher screens")).toBeNull();
  });
});
