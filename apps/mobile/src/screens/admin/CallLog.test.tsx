import { fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { Call } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { CallLog } from "./CallLog";

// The school's call log: who called whom, how it ended, and for how long. Never what was said.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchSchoolCallLog: jest.fn() }));

const fetchSchoolCallLog = shared.fetchSchoolCallLog as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

const call = (id: string, caller: string, callee: string, over: Partial<Call> = {}): Call => ({
  id, tenant_id: "school-1", caller_id: `${id}-a`, callee_id: `${id}-b`, caller_name: caller, callee_name: callee, video: false,
  status: "ended", created_at: "2026-11-05T09:30:00Z", answered_at: "2026-11-05T09:30:10Z", ended_at: "2026-11-05T09:34:17Z", ended_by: `${id}-a`,
  ...over,
});

beforeEach(() => {
  fetchSchoolCallLog.mockReset().mockResolvedValue([
    call("c1", "Mary Otieno", "Ann Wanjiru"),
    call("c2", "Joel Kamau", "Ann Wanjiru", { video: true, status: "missed", answered_at: null, ended_at: null }),
    call("c3", "Ruth Njeri", "Peter Mwangi", { status: "declined", answered_at: null, ended_at: null }),
    // rang and nobody closed it, long ago: it was missed
    call("c4", "Ann Wanjiru", "Mary Otieno", { status: "ringing", answered_at: null, ended_at: null, created_at: "2026-11-04T08:00:00Z" }),
  ]);
});

async function open() {
  render(<ThemeProvider><CallLog session={session} /></ThemeProvider>);
  await screen.findByText("Mary Otieno to Ann Wanjiru", {}, { timeout: 5000 });
}

describe("the school's call log", () => {
  it("lists each call by who called whom, for the school the person is at", async () => {
    await open();
    expect(fetchSchoolCallLog).toHaveBeenCalledWith("school-1");
    expect(screen.getByText("Joel Kamau to Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("Ruth Njeri to Peter Mwangi")).toBeTruthy();
  });

  it("says how each call ended, and calls one that rang out unanswered missed", async () => {
    await open();
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getByText("Declined")).toBeTruthy();
    // the missed call, and the one that rang and was never closed
    expect(screen.getAllByText("Missed")).toHaveLength(2);
  });

  it("says whether it was voice or video, and how long an answered call lasted", async () => {
    await open();
    expect(screen.getByLabelText(/Mary Otieno called Ann Wanjiru, voice, Answered, 4:07,/)).toBeTruthy();
    expect(screen.getByLabelText(/Joel Kamau called Ann Wanjiru, video, Missed,/)).toBeTruthy();
  });

  it("finds the calls a person made or took, by any part of their name", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Filter by name"), "mary");
    expect(screen.getByText("Mary Otieno to Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("Ann Wanjiru to Mary Otieno")).toBeTruthy();
    expect(screen.queryByText("Ruth Njeri to Peter Mwangi")).toBeNull();
    fireEvent.changeText(screen.getByLabelText("Filter by name"), "nobody");
    expect(screen.getByText("No calls match this name.")).toBeTruthy();
  });

  it("says no one has made a call when no one has", async () => {
    fetchSchoolCallLog.mockResolvedValue([]);
    render(<ThemeProvider><CallLog session={session} /></ThemeProvider>);
    expect(await screen.findByText("No one at the school has made a call yet.", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("says why it could not load the calls, and tries again on request", async () => {
    fetchSchoolCallLog.mockRejectedValueOnce(new Error("Network request failed"));
    render(<ThemeProvider><CallLog session={session} /></ThemeProvider>);
    expect(await screen.findByText("Network request failed", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Mary Otieno to Ann Wanjiru")).toBeTruthy();
  });
});
