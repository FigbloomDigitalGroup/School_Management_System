import { Text as MockText } from "react-native";
import { render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { HrLeaveAccess } from "@figbloom/shared";
import type { TeacherSession } from "../../teacherNavigation";
import { ThemeProvider } from "../../ui/ThemeContext";
import { TeacherLeave } from "./Leave";

// The teacher's Leave screen: Figbloom HR's where the school's leave runs there, the school's own form everywhere else.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
// HR's form has its own tests; here it is only told apart from the school's own.
jest.mock("../../components/HrLeave", () => ({ HrLeave: ({ accent }: { accent: string }) => <MockText>HR leave form for {accent}</MockText> }));
const mockAccess = jest.fn<HrLeaveAccess | null, []>();
jest.mock("../../lib/useHrLeaveAccess", () => ({ useHrLeaveAccess: () => mockAccess() }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchMyLeaveRequests: jest.fn() }));

const fetchMyLeaveRequests = shared.fetchMyLeaveRequests as unknown as jest.Mock;

const session: TeacherSession = { profileId: "ann", tenantId: "school-1", fullName: "Ann Wanjiru", accent: "#7A1F2B", country: "KE" };

beforeEach(() => { mockAccess.mockReset(); fetchMyLeaveRequests.mockReset().mockResolvedValue([]); });

describe("which leave form a teacher gets", () => {
  it("is Figbloom HR's where the school's leave runs there, and not the school's own", async () => {
    mockAccess.mockReturnValue({ status: "available", approver: false });
    render(<ThemeProvider><TeacherLeave session={session} /></ThemeProvider>);
    expect(await screen.findByText("HR leave form for #7A1F2B", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Through Figbloom HR")).toBeTruthy();
    expect(screen.queryByText("Request leave")).toBeNull();
    expect(fetchMyLeaveRequests).not.toHaveBeenCalled();
  });

  it("is the school's own form where the leave is not HR's, exactly as before", async () => {
    mockAccess.mockReturnValue({ status: "off", approver: false });
    render(<ThemeProvider><TeacherLeave session={session} /></ThemeProvider>);
    expect(await screen.findByText("Request leave", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/HR leave form/)).toBeNull();
    expect(fetchMyLeaveRequests).toHaveBeenCalledWith("ann");
  });

  it("is neither while HR is still being asked, so neither form flashes up first", async () => {
    mockAccess.mockReturnValue(null);
    render(<ThemeProvider><TeacherLeave session={session} /></ThemeProvider>);
    expect(await screen.findByText("Request time off", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/HR leave form/)).toBeNull();
    expect(screen.queryByText("Request leave")).toBeNull();
    expect(fetchMyLeaveRequests).not.toHaveBeenCalled();
  });
});
