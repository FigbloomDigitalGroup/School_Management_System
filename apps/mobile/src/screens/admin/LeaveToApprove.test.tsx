import { Alert, Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { ApprovalItem } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { LeaveToApprove } from "./LeaveToApprove";

// Leave applications waiting on the person in Figbloom HR: look, approve, or decline with a comment. HR decides; the screen shows its answer.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  loadApprovals: jest.fn(), decideApproval: jest.fn(), fetchHrHandoffStatus: jest.fn(), requestHrLink: jest.fn(),
}));

const loadApprovals = shared.loadApprovals as unknown as jest.Mock;
const decideApproval = shared.decideApproval as unknown as jest.Mock;
const fetchHrHandoffStatus = shared.fetchHrHandoffStatus as unknown as jest.Mock;
const requestHrLink = shared.requestHrLink as unknown as jest.Mock;

const principal: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};
const teacherWithLeave: StaffSession = { ...principal, role: "teacher", adminAreas: ["leave"] };
const bursar: StaffSession = { ...principal, role: "staff", adminAreas: ["fees"] };

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: "a1", employee: "Ann Wanjiru", type: "Annual leave", from: "2026-11-09", to: "2026-11-11", days: 3, halfDay: false, reason: "Family wedding",
  step: "Head teacher", documents: [], steps: [{ label: "Head teacher", status: "current", who: "Grace Njeri", comment: null }], ...over,
});

let alert: jest.SpyInstance;
let openURL: jest.SpyInstance;
beforeEach(() => {
  loadApprovals.mockReset().mockResolvedValue({ kind: "list", items: [item(), item({ id: "a2", employee: "Bea Achieng", type: "Sick leave", from: "2026-11-12", to: "2026-11-12", days: 1, reason: null, step: null, steps: [] })] });
  decideApproval.mockReset().mockResolvedValue({});
  fetchHrHandoffStatus.mockReset().mockResolvedValue("available");
  requestHrLink.mockReset().mockResolvedValue({ url: "https://hr.example/enter?t=once", expires_at: "x" });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
});
afterEach(() => { alert.mockRestore(); openURL.mockRestore(); });

async function open(session: StaffSession = principal) {
  render(<ThemeProvider><LeaveToApprove session={session} /></ThemeProvider>);
  await screen.findByText("Ann Wanjiru", {}, { timeout: 5000 });
}

/** Presses a button, then the button of that name in the question that follows. */
async function pressAndConfirm(button: string, confirmLabel: string) {
  fireEvent.press(screen.getAllByText(button)[0]!);
  const buttons = alert.mock.calls[alert.mock.calls.length - 1]![2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((b) => b.text === confirmLabel)!.onPress!(); });
}

describe("what waits on the person", () => {
  it("lists each application with who, what kind, when, for how long, why, which step is theirs, and who has decided so far", async () => {
    await open();
    expect(screen.getByText("Annual leave · 9 Nov – 11 Nov · 3 days")).toBeTruthy();
    expect(screen.getByText("Family wedding")).toBeTruthy();
    expect(screen.getByText("Your step: Head teacher")).toBeTruthy();
    expect(screen.getByText("Head teacher: Current (Grace Njeri)")).toBeTruthy();
    expect(screen.getByText("Bea Achieng")).toBeTruthy();
    expect(screen.getByText("Sick leave · 12 Nov · 1 day")).toBeTruthy();
  });

  it("says nothing is waiting when HR has nothing for them", async () => {
    loadApprovals.mockResolvedValue({ kind: "empty" });
    render(<ThemeProvider><LeaveToApprove session={principal} /></ThemeProvider>);
    expect(await screen.findByText("Nothing waiting on you", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("says why it could not ask HR, and asks again on request", async () => {
    loadApprovals.mockRejectedValueOnce(new Error("That took too long. Check your connection and try again."));
    render(<ThemeProvider><LeaveToApprove session={principal} /></ThemeProvider>);
    expect(await screen.findByText("That took too long. Check your connection and try again.", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Ann Wanjiru")).toBeTruthy();
  });
});

describe("a person HR does not know yet", () => {
  beforeEach(() => { loadApprovals.mockResolvedValue({ kind: "not_linked" }); });

  it("is asked to open HR & Payroll once, and given the button when the database says they may have it", async () => {
    render(<ThemeProvider><LeaveToApprove session={principal} /></ThemeProvider>);
    expect(await screen.findByText("Connect your HR account", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/Open HR & Payroll once to connect your HR account\./)).toBeTruthy();
    expect(await screen.findByText("Open HR & Payroll")).toBeTruthy();
    expect(fetchHrHandoffStatus).toHaveBeenCalledWith("school-1");
  });

  it("opens HR with the one-time link the moment it arrives", async () => {
    render(<ThemeProvider><LeaveToApprove session={principal} /></ThemeProvider>);
    fireEvent.press(await screen.findByText("Open HR & Payroll", {}, { timeout: 5000 }));
    await act(async () => {});
    expect(requestHrLink).toHaveBeenCalledWith("school-1");
    expect(openURL).toHaveBeenCalledWith("https://hr.example/enter?t=once");
  });

  it("says why HR could not be opened", async () => {
    requestHrLink.mockRejectedValue(new Error("HR & Payroll isn't switched on for this school."));
    render(<ThemeProvider><LeaveToApprove session={principal} /></ThemeProvider>);
    fireEvent.press(await screen.findByText("Open HR & Payroll", {}, { timeout: 5000 }));
    expect(await screen.findByText("HR & Payroll isn't switched on for this school.")).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
  });

  it("sends the head teacher with the Leave area to the school office, who has no HR & Payroll to open", async () => {
    render(<ThemeProvider><LeaveToApprove session={teacherWithLeave} /></ThemeProvider>);
    expect(await screen.findByText(/ask the school office/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("Open HR & Payroll")).toBeNull();
    expect(fetchHrHandoffStatus).not.toHaveBeenCalled();
  });

  it("leaves the button out when the database says HR is not on for the school, and gives it to the bursar when it is", async () => {
    fetchHrHandoffStatus.mockResolvedValue("not_enabled");
    render(<ThemeProvider><LeaveToApprove session={bursar} /></ThemeProvider>);
    expect(await screen.findByText(/ask the school office/, {}, { timeout: 5000 })).toBeTruthy();
    expect(fetchHrHandoffStatus).toHaveBeenCalled();
    expect(screen.queryByText("Open HR & Payroll")).toBeNull();
  });

  it("reads the list again on 'Check again', and shows the applications once HR knows them", async () => {
    render(<ThemeProvider><LeaveToApprove session={principal} /></ThemeProvider>);
    await screen.findByText("Connect your HR account", {}, { timeout: 5000 });
    loadApprovals.mockResolvedValue({ kind: "list", items: [item()] });
    fireEvent.press(screen.getByText("Check again"));
    expect(await screen.findByText("Ann Wanjiru")).toBeTruthy();
    expect(screen.queryByText("Connect your HR account")).toBeNull();
  });
});

describe("approving", () => {
  it("asks first, naming the person, what and when, and says it is decided in HR as them", async () => {
    await open();
    fireEvent.press(screen.getAllByText("Approve")[0]!);
    expect(alert).toHaveBeenCalledWith("Approve Ann Wanjiru's leave?", "Annual leave, 9 Nov – 11 Nov. It is approved in Figbloom HR, as you.", expect.any(Array));
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("sends the decision to HR for that application, says so, and reads the list again", async () => {
    await open();
    await pressAndConfirm("Approve", "Approve");
    expect(decideApproval).toHaveBeenCalledWith("a1", "approve", "");
    expect(await screen.findByText("Approved — Ann Wanjiru's leave goes on in Figbloom HR.")).toBeTruthy();
    expect(loadApprovals).toHaveBeenCalledTimes(2);
  });

  it("sends a comment typed with an approval too", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Comment for Ann Wanjiru's request"), "Enjoy the wedding");
    await pressAndConfirm("Approve", "Approve");
    expect(decideApproval).toHaveBeenCalledWith("a1", "approve", "Enjoy the wedding");
  });

  it("says why HR refused, in HR's own words, and still reads the list again (someone else may have decided it)", async () => {
    decideApproval.mockRejectedValue(new Error("This application has already been decided."));
    await open();
    await pressAndConfirm("Approve", "Approve");
    expect(await screen.findByText("This application has already been decided.")).toBeTruthy();
    expect(loadApprovals).toHaveBeenCalledTimes(2);
  });
});

describe("declining", () => {
  it("waits for a comment: HR does not take a decline without one", async () => {
    await open();
    fireEvent.press(screen.getAllByText("Decline")[0]!);
    expect(alert).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText("Comment for Ann Wanjiru's request"), "   ");
    fireEvent.press(screen.getAllByText("Decline")[0]!);
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks first, then sends the comment with the decline and says the person will see it", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Comment for Ann Wanjiru's request"), "No cover for that week");
    fireEvent.press(screen.getAllByText("Decline")[0]!);
    expect(alert).toHaveBeenCalledWith("Decline Ann Wanjiru's leave?", "Annual leave, 9 Nov – 11 Nov. Ann Wanjiru will see your comment in HR.", expect.any(Array));
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Decline")!.onPress!(); });
    expect(decideApproval).toHaveBeenCalledWith("a1", "decline", "No cover for that week");
    expect(await screen.findByText("Declined — Ann Wanjiru will see your comment in HR.")).toBeTruthy();
  });

  it("keeps one application's comment apart from another's", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Comment for Ann Wanjiru's request"), "For Ann");
    expect(screen.getByLabelText("Comment for Bea Achieng's request").props.value).toBe("");
    fireEvent.press(screen.getAllByText("Decline")[1]!);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("the documents", () => {
  const note = { name: "Doctor's note", url: "https://files.example/note.pdf", expiresAt: "2026-11-06T12:05:00Z" };

  it("opens HR's copy when it is pressed", async () => {
    loadApprovals.mockResolvedValue({ kind: "list", items: [item({ documents: [note] })] });
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T12:00:00Z"));
    try {
      await open();
      fireEvent.press(screen.getByText("View Doctor's note"));
      expect(openURL).toHaveBeenCalledWith("https://files.example/note.pdf");
    } finally { now.mockRestore(); }
  });

  it("will not open a link that ran out while the screen was open: it reads the list again for a new one", async () => {
    loadApprovals.mockResolvedValue({ kind: "list", items: [item({ documents: [note] })] });
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T12:00:00Z"));
    try {
      await open();
      now.mockReturnValue(Date.parse("2026-11-06T12:06:00Z"));
      fireEvent.press(screen.getByText("View Doctor's note"));
      expect(openURL).not.toHaveBeenCalled();
      expect(await screen.findByText("The link to Doctor's note has expired. The list was read again, with a new one.")).toBeTruthy();
      expect(loadApprovals).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });

  it("shows a link that is already out of date as expired, with a way to reload", async () => {
    loadApprovals.mockResolvedValue({ kind: "list", items: [item({ documents: [{ ...note, expiresAt: "2020-01-01T00:00:00Z" }] })] });
    await open();
    expect(screen.getByText("Doctor's note: link expired.")).toBeTruthy();
    expect(screen.queryByText("View Doctor's note")).toBeNull();
    fireEvent.press(screen.getByText("Reload"));
    await act(async () => {});
    expect(loadApprovals).toHaveBeenCalledTimes(2);
  });

  it("says when the phone could not open it", async () => {
    loadApprovals.mockResolvedValue({ kind: "list", items: [item({ documents: [{ ...note, expiresAt: null }] })] });
    openURL.mockRejectedValue(new Error("no app"));
    await open();
    fireEvent.press(screen.getByText("View Doctor's note"));
    expect(await screen.findByText("Could not open Doctor's note.")).toBeTruthy();
  });
});
