import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { FoundLearner, FoundStaff } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { People } from "./People";

// Looking a person up from the office: a learner by name or admission number, a member of staff by name, and calling them.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), searchLearners: jest.fn(), searchStaff: jest.fn() }));

const searchLearners = shared.searchLearners as unknown as jest.Mock;
const searchStaff = shared.searchStaff as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};
const ANN: FoundLearner = { id: "s1", name: "Ann Wanjiru", admissionNo: "1042", className: "Form 1A", boarding: false };
const ANNETTE: FoundLearner = { id: "s2", name: "Annette Mwangi", admissionNo: "1043", className: "Form 2B", boarding: true };
const GRACE: FoundStaff = { id: "p1", name: "Joan Anne", role: "teacher", title: "Head of Maths", phone: "0712 345 678", email: null };
const SAM: FoundStaff = { id: "p2", name: "Sam Anne", role: "driver", title: null, phone: null, email: null };

let openURL: jest.SpyInstance;
const onOpenLearner = jest.fn();
beforeEach(() => {
  onOpenLearner.mockReset();
  searchLearners.mockReset().mockResolvedValue([ANN, ANNETTE]);
  searchStaff.mockReset().mockResolvedValue([GRACE, SAM]);
  openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
});
afterEach(() => openURL.mockRestore());

async function open() {
  render(<ThemeProvider><People session={session} onOpenLearner={onOpenLearner} /></ThemeProvider>);
  await screen.findByText("Look up a learner or a member of staff", {}, { timeout: 5000 });
}
const pause = (ms = 400) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe("finding a learner", () => {
  it("starts on learners, and asks for two letters before it searches", async () => {
    await open();
    expect(screen.getByLabelText("Name or admission number")).toBeTruthy();
    expect(screen.getByText("Type at least two letters.")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Name or admission number"), "A");
    await pause();
    expect(searchLearners).not.toHaveBeenCalled();
  });

  it("lists whoever matches with their admission number, class and whether they board", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Name or admission number"), "Ann");
    expect(await screen.findByText("Ann Wanjiru", {}, { timeout: 5000 })).toBeTruthy();
    expect(searchLearners).toHaveBeenCalledWith("school-1", "Ann");
    // learners are being looked for, not staff
    expect(searchStaff).not.toHaveBeenCalled();
    expect(screen.getByText("ADM 1042 · Form 1A · Day scholar")).toBeTruthy();
    expect(screen.getByText("Annette Mwangi")).toBeTruthy();
    expect(screen.getByText("ADM 1043 · Form 2B · Boarder")).toBeTruthy();
  });

  it("opens the card of the learner tapped, with what the card needs", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Name or admission number"), "Ann");
    fireEvent.press(await screen.findByLabelText("Annette Mwangi, ADM 1043 · Form 2B · Boarder", {}, { timeout: 5000 }));
    expect(onOpenLearner).toHaveBeenCalledWith({ id: "s2", name: "Annette Mwangi", line: "ADM 1043 · Form 2B · Boarder" });
  });

  it("says when nobody matches, and why a search failed", async () => {
    searchLearners.mockResolvedValueOnce([]);
    await open();
    fireEvent.changeText(screen.getByLabelText("Name or admission number"), "Zed");
    expect(await screen.findByText("No learner matches that.", {}, { timeout: 5000 })).toBeTruthy();
    searchLearners.mockRejectedValueOnce(new Error("Network request failed"));
    fireEvent.changeText(screen.getByLabelText("Name or admission number"), "Zede");
    expect(await screen.findByText("Couldn't search: Network request failed", {}, { timeout: 5000 })).toBeTruthy();
  });
});

describe("finding a member of staff", () => {
  async function onStaff() {
    await open();
    fireEvent.press(screen.getByText("Staff"));
    fireEvent.changeText(screen.getByLabelText("Name"), "Anne");
    await screen.findByText("Joan Anne", {}, { timeout: 5000 });
  }

  it("searches the staff by name, and lists them with their title, or what they are", async () => {
    await onStaff();
    expect(searchStaff).toHaveBeenCalledWith("school-1", "Anne");
    expect(searchLearners).not.toHaveBeenCalled();
    expect(screen.getByText("Head of Maths")).toBeTruthy();
    expect(screen.getByText("Sam Anne")).toBeTruthy();
    expect(screen.getByText("Driver")).toBeTruthy();
  });

  it("searches the staff for what was already typed when the person switches from learners", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Name or admission number"), "Anne");
    await screen.findByText("Ann Wanjiru", {}, { timeout: 5000 });
    fireEvent.press(screen.getByText("Staff"));
    expect(await screen.findByText("Joan Anne", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("Ann Wanjiru")).toBeNull();
    expect(searchStaff).toHaveBeenCalledWith("school-1", "Anne");
  });

  it("calls a member of staff on the phone's dialer, in international form", async () => {
    await onStaff();
    fireEvent.press(screen.getByText("Call 0712 345 678"));
    await act(async () => {});
    expect(openURL).toHaveBeenCalledWith("tel:+254712345678");
  });

  it("says there is no number on file for someone with none, and offers no call", async () => {
    await onStaff();
    expect(screen.getByText("No phone number on file.")).toBeTruthy();
    expect(screen.getAllByText(/^Call /)).toHaveLength(1);
  });

  it("says when the phone could not start the call", async () => {
    openURL.mockRejectedValue(new Error("no dialer"));
    await onStaff();
    fireEvent.press(screen.getByText("Call 0712 345 678"));
    expect(await screen.findByText("Could not start the call to Joan Anne.")).toBeTruthy();
  });

  it("says when nobody on the staff matches", async () => {
    searchStaff.mockResolvedValue([]);
    await open();
    fireEvent.press(screen.getByText("Staff"));
    fireEvent.changeText(screen.getByLabelText("Name"), "Zed");
    expect(await screen.findByText("Nobody on the staff matches that.", {}, { timeout: 5000 })).toBeTruthy();
  });
});
