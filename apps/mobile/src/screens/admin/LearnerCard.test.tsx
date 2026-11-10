import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { LearnerGuardianContact, StudentHealth } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { LearnerCard } from "./LearnerCard";

// One learner for the office on the move: what to know before giving them anything, and who to call.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchStudentHealth: jest.fn(), fetchLearnerGuardians: jest.fn() }));

const fetchStudentHealth = shared.fetchStudentHealth as unknown as jest.Mock;
const fetchLearnerGuardians = shared.fetchLearnerGuardians as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};
const learner = { id: "s1", name: "Ann Wanjiru", line: "ADM 1042 · Form 1A · Day scholar" };

const health = (over: Partial<StudentHealth> = {}): StudentHealth => ({
  student_id: "s1", tenant_id: "school-1", allergies: [], medical_conditions: [], medications: null, blood_group: null, dietary_needs: null, special_needs: null,
  notes: null, doctor_name: null, doctor_phone: null, emergency_name: null, emergency_relationship: null, emergency_phone: null, updated_at: "x", updated_by: null, ...over,
});
const guardian = (over: Partial<LearnerGuardianContact> = {}): LearnerGuardianContact => ({
  profile_id: "g1", relationship: "mother", full_name: "Rose Achieng", phone: "0712 345 678", alt_phone: "0733 111 222", email: null, ...over,
});

let openURL: jest.SpyInstance;
beforeEach(() => {
  fetchStudentHealth.mockReset().mockResolvedValue(health({ allergies: ["Peanuts", "Eggs"], medical_conditions: ["Asthma"], medications: "Salbutamol inhaler" }));
  fetchLearnerGuardians.mockReset().mockResolvedValue([guardian(), guardian({ profile_id: "g2", relationship: "father", full_name: "Peter Wanjiru", alt_phone: null })]);
  openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
});
afterEach(() => openURL.mockRestore());

async function open() {
  render(<ThemeProvider><LearnerCard session={session} learner={learner} /></ThemeProvider>);
  await screen.findByText("Allergies and conditions", {}, { timeout: 5000 });
}

describe("what to know before giving them anything", () => {
  it("names the learner under their class and admission number", async () => {
    await open();
    expect(screen.getByText("Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("ADM 1042 · Form 1A · Day scholar")).toBeTruthy();
    expect(fetchStudentHealth).toHaveBeenCalledWith("s1");
    expect(fetchLearnerGuardians).toHaveBeenCalledWith("s1");
  });

  it("shows allergies and conditions loudly, and what they take", async () => {
    await open();
    expect(await screen.findByText("Allergies: Peanuts, Eggs")).toBeTruthy();
    expect(screen.getByText("Conditions: Asthma")).toBeTruthy();
    expect(screen.getByText("Takes: Salbutamol inhaler")).toBeTruthy();
  });

  it("shows diet and needs when they are on file", async () => {
    fetchStudentHealth.mockResolvedValue(health({ dietary_needs: "No pork", special_needs: "Sits at the front" }));
    await open();
    expect(await screen.findByText("Diet: No pork")).toBeTruthy();
    expect(screen.getByText("Needs: Sits at the front")).toBeTruthy();
  });

  it("says quietly that there is nothing on file, so nothing shown never reads as no allergies", async () => {
    fetchStudentHealth.mockResolvedValue(health());
    await open();
    expect(await screen.findByText(/No allergies or conditions on file/)).toBeTruthy();
    fetchStudentHealth.mockResolvedValue(null);
  });

  it("says the same for a learner with no health record at all", async () => {
    fetchStudentHealth.mockResolvedValue(null);
    await open();
    expect(await screen.findByText(/No allergies or conditions on file/)).toBeTruthy();
  });
});

describe("who to call", () => {
  it("lists each guardian with how they are related, and each number to call, the main one first", async () => {
    await open();
    expect(await screen.findByText("Rose Achieng")).toBeTruthy();
    expect(screen.getByText("Mother")).toBeTruthy();
    expect(screen.getByText("Peter Wanjiru")).toBeTruthy();
    expect(screen.getByText("Father")).toBeTruthy();
    expect(screen.getAllByText("Call 0712 345 678")).toHaveLength(2);
    expect(screen.getByText("Call 0733 111 222")).toBeTruthy();
  });

  it("calls the number tapped on the phone's dialer, in international form", async () => {
    await open();
    fireEvent.press((await screen.findAllByText("Call 0712 345 678"))[0]!);
    await act(async () => {});
    expect(openURL).toHaveBeenCalledWith("tel:+254712345678");
    fireEvent.press(screen.getByText("Call 0733 111 222"));
    await act(async () => {});
    expect(openURL).toHaveBeenLastCalledWith("tel:+254733111222");
  });

  it("says there is no number on file for a guardian with none", async () => {
    fetchLearnerGuardians.mockResolvedValue([guardian({ phone: null, alt_phone: "" })]);
    await open();
    expect(await screen.findByText("No phone number on file.")).toBeTruthy();
    expect(screen.queryByText(/^Call /)).toBeNull();
  });

  it("says when no guardian is on file", async () => {
    fetchLearnerGuardians.mockResolvedValue([]);
    await open();
    expect(await screen.findByText("No guardian is on file for Ann Wanjiru.")).toBeTruthy();
  });

  it("says when the phone could not start the call", async () => {
    openURL.mockRejectedValue(new Error("no dialer"));
    await open();
    fireEvent.press((await screen.findAllByText("Call 0712 345 678"))[0]!);
    expect(await screen.findByText("Could not start the call to Rose Achieng.")).toBeTruthy();
  });
});

describe("when only one of the two can be read", () => {
  it("still shows the guardians when the health record is refused, and tries again on request", async () => {
    fetchStudentHealth.mockRejectedValueOnce(new Error("permission denied for table student_health"));
    await open();
    expect(await screen.findByText("Couldn't read their health record: permission denied for table student_health")).toBeTruthy();
    expect(screen.getByText("Rose Achieng")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Allergies: Peanuts, Eggs")).toBeTruthy();
  });

  it("still shows the allergies when the guardians are refused, and tries again on request", async () => {
    fetchLearnerGuardians.mockRejectedValueOnce(new Error("permission denied for table guardians"));
    await open();
    expect(await screen.findByText("Couldn't read their guardians: permission denied for table guardians")).toBeTruthy();
    expect(screen.getByText("Allergies: Peanuts, Eggs")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Rose Achieng")).toBeTruthy();
  });
});
