import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { LeaveRequestRow } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminLeave } from "./Leave";

// Teachers' leave requests for the principal: those awaiting review first, a question before each decision, and the past ones.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchAllLeaveRequests: jest.fn(), decideLeaveRequest: jest.fn() }));

const fetchAllLeaveRequests = shared.fetchAllLeaveRequests as unknown as jest.Mock;
const decideLeaveRequest = shared.decideLeaveRequest as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

const row = (id: string, teacherName: string, over: Partial<LeaveRequestRow> = {}): LeaveRequestRow => ({
  id, teacher_id: `t-${id}`, teacherName, starts_on: "2026-11-09", ends_on: "2026-11-11", reason: null, status: "pending",
  reviewed_by: null, reviewed_at: null, review_note: null, created_at: "2026-11-05T08:00:00Z", ...over,
});

/** Dates that are not the two pending requests', so a test can tell a past row from a pending one. */
const EARLIER = { starts_on: "2026-10-12", ends_on: "2026-10-14" };

let alert: jest.SpyInstance;
beforeEach(() => {
  fetchAllLeaveRequests.mockReset().mockResolvedValue([
    row("1", "Ann Wanjiru", { reason: "Family wedding" }),
    row("2", "Bea Achieng", { starts_on: "2026-11-12", ends_on: "2026-11-12" }),
    row("3", "Cy Mwangi", { ...EARLIER, status: "approved", review_note: "Cover arranged with Dan" }),
    row("4", "Dan Otieno", { ...EARLIER, status: "rejected" }),
    row("5", "Eve Kamau", { ...EARLIER, status: "approved", source: "hr" }),
    row("6", "Fay Njoroge", { ...EARLIER, status: "cancelled" }),
  ]);
  decideLeaveRequest.mockReset().mockResolvedValue({ notifyError: null });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

async function open() {
  render(<ThemeProvider><AdminLeave session={session} /></ThemeProvider>);
  await screen.findByText("Awaiting review · 2", {}, { timeout: 5000 });
}

/** Presses a button, then the button of that name in the question that follows. */
async function pressAndConfirm(button: string, confirmLabel: string) {
  fireEvent.press(screen.getAllByText(button)[0]!);
  const buttons = alert.mock.calls[alert.mock.calls.length - 1]![2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((b) => b.text === confirmLabel)!.onPress!(); });
}

describe("what the principal sees", () => {
  it("lists the requests awaiting review first, with who, when and why", async () => {
    await open();
    expect(fetchAllLeaveRequests).toHaveBeenCalledWith("school-1");
    expect(screen.getByText("Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("9 Nov – 11 Nov")).toBeTruthy();
    expect(screen.getByText("Family wedding")).toBeTruthy();
    expect(screen.getByText("Bea Achieng")).toBeTruthy();
    expect(screen.getByText("12 Nov – 12 Nov")).toBeTruthy();
  });

  it("lists the past requests with how they ended, the principal's note, and which were decided in Figbloom HR", async () => {
    await open();
    expect(screen.getByText("Past requests")).toBeTruthy();
    expect(screen.getByText("Cy Mwangi")).toBeTruthy();
    expect(screen.getByText("Cover arranged with Dan")).toBeTruthy();
    expect(screen.getAllByText("Approved")).toHaveLength(1);
    expect(screen.getByText("Approved · Figbloom HR")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });

  it("says nothing is waiting when nothing is, and that there is no history when there is none", async () => {
    fetchAllLeaveRequests.mockResolvedValue([]);
    render(<ThemeProvider><AdminLeave session={session} /></ThemeProvider>);
    expect(await screen.findByText("Nothing awaiting review", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Awaiting review · 0")).toBeTruthy();
    expect(screen.getByText("Reviewed and withdrawn requests will show up here.")).toBeTruthy();
  });

  it("says why it could not load the requests, and tries again on request", async () => {
    fetchAllLeaveRequests.mockRejectedValueOnce(new Error("Network request failed"));
    render(<ThemeProvider><AdminLeave session={session} /></ThemeProvider>);
    expect(await screen.findByText("Network request failed", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Awaiting review · 2")).toBeTruthy();
  });
});

describe("deciding", () => {
  it("asks first, naming the teacher and the dates, and says they are told straight away", async () => {
    await open();
    fireEvent.press(screen.getAllByText("Approve")[0]!);
    expect(alert).toHaveBeenCalledWith("Approve Ann Wanjiru's leave?", "9 Nov – 11 Nov. Ann Wanjiru is told in the app straight away.", expect.any(Array));
    expect(decideLeaveRequest).not.toHaveBeenCalled();
  });

  it("approves with the note typed for that request, as the person signed in, then says so and reads the list again", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Note for Ann Wanjiru's request"), "Cover arranged with Dan");
    await pressAndConfirm("Approve", "Approve");
    expect(decideLeaveRequest).toHaveBeenCalledWith({
      tenantId: "school-1", reviewerId: "grace", request: expect.objectContaining({ id: "1", teacher_id: "t-1" }), status: "approved", note: "Cover arranged with Dan",
    });
    expect(await screen.findByText("Approved. Ann Wanjiru has been told.")).toBeTruthy();
    expect(fetchAllLeaveRequests).toHaveBeenCalledTimes(2);
  });

  it("keeps one request's note apart from another's", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Note for Ann Wanjiru's request"), "For Ann");
    await pressAndConfirm("Reject", "Reject");
    expect(decideLeaveRequest.mock.calls[0]![0]).toMatchObject({ status: "rejected", note: "For Ann", request: { id: "1" } });
    expect(await screen.findByText("Rejected. Ann Wanjiru has been told.")).toBeTruthy();
    expect(screen.getByLabelText("Note for Bea Achieng's request").props.value).toBe("");
  });

  it("says the decision stands but the teacher was not told, when only the notice failed", async () => {
    decideLeaveRequest.mockResolvedValue({ notifyError: "could not publish" });
    await open();
    await pressAndConfirm("Approve", "Approve");
    expect(await screen.findByText("Recorded, but Ann Wanjiru could not be notified: could not publish")).toBeTruthy();
  });

  it("says why it could not record the decision", async () => {
    decideLeaveRequest.mockRejectedValue(new Error("new row violates row-level security policy"));
    await open();
    await pressAndConfirm("Approve", "Approve");
    expect(await screen.findByText("Could not update: new row violates row-level security policy")).toBeTruthy();
  });
});
