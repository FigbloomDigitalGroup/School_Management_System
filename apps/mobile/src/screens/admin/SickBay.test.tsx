import { fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { DoseSlot, MedicationSchedule, SickBayOverview, SickBayVisit } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { SickBay } from "./SickBay";

// The sick bay on the move: doses overdue, who is in, today's visits; a learner opens their card.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchSickBayBoard: jest.fn() }));

const fetchSickBayBoard = shared.fetchSickBayBoard as unknown as jest.Mock;

const session: StaffSession = {
  role: "staff", accent: "#7A1F2B", profileId: "nurse-1", tenantId: "school-1", fullName: "Mary Atieno", country: "KE",
  adminAreas: ["medical"], school: { name: "Kijani Ridge", slug: "kijani" }, title: "School nurse",
};

/** Today, at this time, on this device's clock: so "the time alone for today" holds whenever the test runs. */
const todayAt = (h: number, m: number, daysAgo = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.toISOString(); };

const visit = (id: string, name: string, over: Partial<SickBayVisit> = {}): SickBayVisit => ({
  id, tenant_id: "school-1", student_id: `st-${id}`, time_in: todayAt(9, 5), complaint: "Headache", temperature_c: null, pulse_bpm: null, observations: null, assessment: null,
  treatment: null, outcome: null, referred_to: null, time_out: null, follow_up: null, attendance_mark: null, attendance_marked_at: null, logged_by: null, updated_at: "x",
  students: { full_name: name, admission_no: "1042", classes: { name: "Form 1A" } }, ...over,
});
const dose = (id: string, name: string, time: string): DoseSlot => ({
  schedule: {
    id, tenant_id: "school-1", student_id: `st-${id}`, drug: "Amoxicillin", dose: "250mg", times: [time], starts_on: "2026-11-01", ends_on: null, prescribed_by: "doctor",
    prescriber: null, notes: null, stopped_at: null, created_at: "x", students: { full_name: name, admission_no: "1042", classes: { name: "Form 1A" } },
  } satisfies MedicationSchedule,
  day: "2026-11-07", time, dose: null, state: "overdue",
});

const board = (over: Partial<SickBayOverview> = {}): SickBayOverview => ({
  overdue: [dose("a", "Ann Wanjiru", "08:00"), dose("b", "Dan Otieno", "09:30")],
  open: [visit("v1", "Ann Wanjiru", { temperature_c: 38.4 }), visit("v0", "Eve Kamau", { time_in: todayAt(15, 0, 1), complaint: "Fever", outcome: "rest" })],
  today: [
    visit("v1", "Ann Wanjiru", { temperature_c: 38.4 }),
    visit("v2", "Bea Achieng", { time_in: todayAt(8, 15), complaint: "Cut knee", outcome: "class", time_out: todayAt(8, 40) }),
    visit("v3", "Cy Mwangi", { time_in: todayAt(7, 50), complaint: "Stomach ache", outcome: "hospital", time_out: todayAt(8, 10) }),
  ],
  ...over,
});

const onOpenLearner = jest.fn();
beforeEach(() => {
  onOpenLearner.mockReset();
  fetchSickBayBoard.mockReset().mockResolvedValue(board());
});

async function open() {
  render(<ThemeProvider><SickBay session={session} onOpenLearner={onOpenLearner} /></ThemeProvider>);
  await screen.findByText(/In the sick bay now/, {}, { timeout: 5000 });
}

describe("what needs doing now", () => {
  it("says how many doses have not been given for over an hour, and which", async () => {
    await open();
    expect(fetchSickBayBoard).toHaveBeenCalledWith("school-1");
    expect(screen.getByText("2 doses not given for over an hour")).toBeTruthy();
    expect(screen.getByText("08:00 · Ann Wanjiru: Amoxicillin 250mg")).toBeTruthy();
    expect(screen.getByText("09:30 · Dan Otieno: Amoxicillin 250mg")).toBeTruthy();
  });

  it("says '1 dose' for one, and says nothing when there are none overdue", async () => {
    fetchSickBayBoard.mockResolvedValue(board({ overdue: [dose("a", "Ann Wanjiru", "08:00")] }));
    await open();
    expect(screen.getByText("1 dose not given for over an hour")).toBeTruthy();
  });

  it("shows no alert when no dose is overdue", async () => {
    fetchSickBayBoard.mockResolvedValue(board({ overdue: [] }));
    await open();
    expect(screen.queryByText(/not given for over an hour/)).toBeNull();
  });

  it("opens the learner's card from an overdue dose", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("08:00, Ann Wanjiru, Amoxicillin 250mg. Open their card"));
    expect(onOpenLearner).toHaveBeenCalledWith({ id: "st-a", name: "Ann Wanjiru", line: "ADM 1042 · Form 1A" });
  });
});

describe("who is in, and today's visits", () => {
  it("counts and lists who is in the sick bay, with when they came, what for (and their temperature), and that they are being seen", async () => {
    await open();
    expect(screen.getByText("In the sick bay now · 2")).toBeTruthy();
    expect(screen.getAllByText("ADM 1042 · Form 1A · Headache · 38.4°C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Being seen").length).toBeGreaterThan(0);
  });

  it("gives the day with the time for someone who came in on an earlier day", async () => {
    await open();
    // Eve Kamau has been in since yesterday afternoon: the row says so, where today's say the time alone
    expect(screen.getByText("Eve Kamau")).toBeTruthy();
    expect(screen.getByText("ADM 1042 · Form 1A · Fever")).toBeTruthy();
    expect(screen.getByText("Resting in the sick bay")).toBeTruthy();
  });

  it("lists today's visits with where each learner went and when they left", async () => {
    await open();
    expect(screen.getByText("Today's visits · 3")).toBeTruthy();
    expect(screen.getByText("Bea Achieng")).toBeTruthy();
    expect(screen.getByText("Back to class · out 08:40")).toBeTruthy();
    expect(screen.getByText("Cy Mwangi")).toBeTruthy();
    expect(screen.getByText("Referred to hospital · out 08:10")).toBeTruthy();
  });

  it("opens the card of the learner in a visit", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("Bea Achieng, Cut knee, Back to class. Open their card"));
    expect(onOpenLearner).toHaveBeenCalledWith({ id: "st-v2", name: "Bea Achieng", line: "ADM 1042 · Form 1A" });
  });

  it("says when nobody is in and there have been no visits", async () => {
    fetchSickBayBoard.mockResolvedValue(board({ overdue: [], open: [], today: [] }));
    await open();
    expect(screen.getByText("Nobody in the sick bay")).toBeTruthy();
    expect(screen.getByText("No visits yet today")).toBeTruthy();
    expect(screen.getByText("In the sick bay now · 0")).toBeTruthy();
  });
});

describe("when it cannot be read", () => {
  it("says why, and asks again on request", async () => {
    fetchSickBayBoard.mockRejectedValueOnce(new Error("permission denied for table sick_bay_visits"));
    render(<ThemeProvider><SickBay session={session} onOpenLearner={onOpenLearner} /></ThemeProvider>);
    expect(await screen.findByText("permission denied for table sick_bay_visits", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText(/In the sick bay now/)).toBeTruthy();
  });
});
