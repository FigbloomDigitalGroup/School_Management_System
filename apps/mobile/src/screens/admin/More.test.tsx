import { fireEvent, render, screen } from "@testing-library/react-native";
import { adminScreensFor, ADMIN_SCREENS, hrScreensFor } from "../../adminScreens";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminMore } from "./More";

// The admin side's menu: one row for each screen this person's areas open.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
const mockUnread = jest.fn(() => 0);
jest.mock("../../lib/chatUnread", () => ({ useChatUnread: () => mockUnread() }));

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

/** Every screen a full admin has before HR says anything about leave. */
const WITHOUT_HR = ["Fees", "Announcements", "Chats", "SchoolChats", "CallLog", "Leave"];

describe("which admin screens a person is offered", () => {
  it("is every screen for a full admin, once HR says they approve leave and they apply through it", () => {
    expect(adminScreensFor("all", { approver: true, staffLeave: true })).toEqual([...ADMIN_SCREENS]);
  });
  it("leaves out the two HR screens until HR says so, whatever the areas", () => {
    expect(adminScreensFor("all").map((s) => s.to)).toEqual(WITHOUT_HR);
    expect(adminScreensFor("all", { approver: false, staffLeave: false }).map((s) => s.to)).toEqual(WITHOUT_HR);
  });
  it("lists Leave to approve for an approver whose areas open nothing else of leave, such as the bursar", () => {
    expect(adminScreensFor(["fees"], { approver: true }).map((s) => s.to)).toEqual(["Fees", "LeaveToApprove"]);
    expect(adminScreensFor(["leave"], { approver: true }).map((s) => s.to)).toEqual(["Leave", "LeaveToApprove"]);
  });
  it("lists My leave for staff whose leave runs in HR, on its own and not with the approvals", () => {
    expect(adminScreensFor(["attendance"], { staffLeave: true }).map((s) => s.to)).toEqual(["MyLeave"]);
    expect(adminScreensFor(["attendance"], { approver: true }).map((s) => s.to)).toEqual(["LeaveToApprove"]);
    expect(adminScreensFor(["attendance"])).toEqual([]);
  });
  it("takes the two HR screens from HR's answer for the person's role: approvals for approvers, My leave only for other staff", () => {
    const answer = { status: "available" as const, approver: true };
    expect(hrScreensFor("staff", answer)).toEqual({ approver: true, staffLeave: true });
    expect(hrScreensFor("teacher", answer)).toEqual({ approver: true, staffLeave: false });
    expect(hrScreensFor("school_admin", answer)).toEqual({ approver: true, staffLeave: false });
    expect(hrScreensFor("staff", { status: "available", approver: false })).toEqual({ approver: false, staffLeave: true });
    // not HR's school, or HR not asked yet: neither
    expect(hrScreensFor("staff", { status: "off", approver: true })).toEqual({ approver: false, staffLeave: false });
    expect(hrScreensFor("staff", null)).toEqual({ approver: false, staffLeave: false });
  });
  it("is the screens an area covers, and only those: announcements and chats for Communication, fees for Fees", () => {
    expect(adminScreensFor(["communication"]).map((s) => s.to)).toEqual(["Announcements", "Chats", "SchoolChats", "CallLog"]);
    expect(adminScreensFor(["fees"]).map((s) => s.to)).toEqual(["Fees"]);
  });
  it("is leave requests for the Leave area, beside the fees for a bursar who also has it", () => {
    expect(adminScreensFor(["leave"]).map((s) => s.to)).toEqual(["Leave"]);
    expect(adminScreensFor(["fees", "leave"]).map((s) => s.to)).toEqual(["Fees", "Leave"]);
  });
  it("is nothing for someone with no admin console", () => {
    expect(adminScreensFor(null)).toEqual([]);
    expect(adminScreensFor(null, { approver: true, staffLeave: true })).toEqual([]);
  });
});

describe("the admin More list", () => {
  beforeEach(() => { mockUnread.mockReturnValue(0); });

  it("shows a row for each screen, with what it is for, and opens the one tapped", async () => {
    const onOpen = jest.fn();
    render(<ThemeProvider><AdminMore session={session} screens={adminScreensFor("all", { approver: true, staffLeave: true })} onOpen={onOpen} /></ThemeProvider>);
    expect(await screen.findByText("Kijani Ridge")).toBeTruthy();
    expect(screen.getByText("Send a notice to the school, a year group or a class")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Fees"));
    expect(onOpen).toHaveBeenCalledWith("Fees");
    fireEvent.press(screen.getByLabelText("Announcements"));
    expect(onOpen).toHaveBeenCalledWith("Announcements");
    fireEvent.press(screen.getByLabelText("Chats"));
    expect(onOpen).toHaveBeenCalledWith("Chats");
    fireEvent.press(screen.getByLabelText("All school chats"));
    expect(onOpen).toHaveBeenCalledWith("SchoolChats");
    fireEvent.press(screen.getByLabelText("Call log"));
    expect(onOpen).toHaveBeenCalledWith("CallLog");
    fireEvent.press(screen.getByLabelText("Leave requests"));
    expect(onOpen).toHaveBeenCalledWith("Leave");
    fireEvent.press(screen.getByLabelText("Leave to approve"));
    expect(onOpen).toHaveBeenCalledWith("LeaveToApprove");
    fireEvent.press(screen.getByLabelText("My leave"));
    expect(onOpen).toHaveBeenCalledWith("MyLeave");
  });

  it("says how many chat messages are waiting, on the Chats row only", async () => {
    mockUnread.mockReturnValue(3);
    render(<ThemeProvider><AdminMore session={session} screens={adminScreensFor("all")} onOpen={jest.fn()} /></ThemeProvider>);
    expect(await screen.findByLabelText("Chats, 3 new")).toBeTruthy();
    expect(screen.getByLabelText("All school chats")).toBeTruthy();
    expect(screen.getByLabelText("Announcements")).toBeTruthy();
  });
});
