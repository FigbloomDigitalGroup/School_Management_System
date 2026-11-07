import { fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { ClassRegister } from "./ClassRegister";

// Who was not in a class on a day: opened from a class's row on the admin Home.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mockGoBack }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchClassRegister: jest.fn() }));

const mockGoBack = jest.fn();
const fetchClassRegister = shared.fetchClassRegister as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};
const params = { classId: "c1", className: "Form 1A", date: "2020-03-04" };

const roster = [
  { id: "s1", name: "Amani Otieno", admissionNo: "101", mark: "present" },
  { id: "s2", name: "Baraka Mwangi", admissionNo: "102", mark: "late" },
  { id: "s3", name: "Chebet Kiprop", admissionNo: "103", mark: "absent" },
  { id: "s4", name: "Dalila Hassan", admissionNo: "104", mark: "excused" },
];

async function open(route: { params?: typeof params } = { params }) {
  render(<ThemeProvider><ClassRegister session={session} route={route} /></ThemeProvider>);
}

beforeEach(() => {
  mockGoBack.mockClear();
  fetchClassRegister.mockReset().mockResolvedValue(roster);
});

describe("a class's register for a day", () => {
  it("names the class and the day, and asks for that class on that day", async () => {
    await open();
    expect(await screen.findByText("Form 1A")).toBeTruthy();
    expect(screen.getByText("Who wasn't here · Wed 4 Mar")).toBeTruthy();
    expect(fetchClassRegister).toHaveBeenCalledWith("c1", "2020-03-04");
  });

  it("lists only the learners who were late, absent or excused, each with the reason, and leaves off those who were present", async () => {
    await open();
    expect(await screen.findByText("Baraka Mwangi")).toBeTruthy();
    expect(screen.getByText("Chebet Kiprop")).toBeTruthy();
    expect(screen.getByText("Dalila Hassan")).toBeTruthy();
    expect(screen.queryByText("Amani Otieno")).toBeNull();
    expect(screen.getByText("Late")).toBeTruthy();
    expect(screen.getByText("Absent")).toBeTruthy();
    expect(screen.getByText("Excused")).toBeTruthy();
    expect(screen.getByText("ADM 102")).toBeTruthy();
  });

  it("says everyone was here when nobody was away", async () => {
    fetchClassRegister.mockResolvedValue([roster[0]]);
    await open();
    expect(await screen.findByText("Everyone was here")).toBeTruthy();
    expect(screen.getByText("Everyone in Form 1A was present and on time.")).toBeTruthy();
  });

  it("says why it could not load, and tries again on request", async () => {
    fetchClassRegister.mockRejectedValueOnce(new Error("Network request failed"));
    await open();
    expect(await screen.findByText("Network request failed")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Baraka Mwangi")).toBeTruthy();
    expect(fetchClassRegister).toHaveBeenCalledTimes(2);
  });

  it("goes back to the list", async () => {
    await open();
    fireEvent.press(await screen.findByLabelText("Go back"));
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("asks for nothing, and says so, when no class was chosen", async () => {
    await open({});
    expect(await screen.findByText("No class chosen")).toBeTruthy();
    expect(fetchClassRegister).not.toHaveBeenCalled();
  });
});
