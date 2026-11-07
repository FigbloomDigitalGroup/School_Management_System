import { Text as MockText } from "react-native";
import { render, screen } from "@testing-library/react-native";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { MyLeave } from "./MyLeave";

// Other staff's own leave, through Figbloom HR.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
// HR's form has its own tests; here it is only found on the screen.
jest.mock("../../components/HrLeave", () => ({ HrLeave: ({ accent }: { accent: string }) => <MockText>HR leave form for {accent}</MockText> }));

const session: StaffSession = {
  role: "staff", accent: "#7A1F2B", profileId: "dan", tenantId: "school-1", fullName: "Dan Otieno", country: "KE",
  adminAreas: ["attendance"], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Registrar",
};

describe("my leave", () => {
  it("is HR's leave form under its own header, in the school's colour", async () => {
    render(<ThemeProvider><MyLeave session={session} /></ThemeProvider>);
    expect(await screen.findByText("My leave", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Through Figbloom HR")).toBeTruthy();
    expect(screen.getByText("HR leave form for #7A1F2B")).toBeTruthy();
  });
});
