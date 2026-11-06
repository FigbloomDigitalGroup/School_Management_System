import { fireEvent, render, screen } from "@testing-library/react-native";
import { adminScreensFor, ADMIN_SCREENS } from "../../adminScreens";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminMore } from "./More";

// The admin side's menu: one row for each screen this person's areas open.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

describe("which admin screens a person is offered", () => {
  it("is every screen for a full admin", () => {
    expect(adminScreensFor("all")).toEqual([...ADMIN_SCREENS]);
  });
  it("is the screens an area covers, and only those: announcements for Communication, none for Fees alone", () => {
    expect(adminScreensFor(["communication"]).map((s) => s.to)).toEqual(["Announcements"]);
    expect(adminScreensFor(["fees", "leave"])).toEqual([]);
  });
  it("is nothing for someone with no admin console", () => {
    expect(adminScreensFor(null)).toEqual([]);
  });
});

describe("the admin More list", () => {
  it("shows a row for each screen, with what it is for, and opens the one tapped", async () => {
    const onOpen = jest.fn();
    render(<ThemeProvider><AdminMore session={session} screens={adminScreensFor("all")} onOpen={onOpen} /></ThemeProvider>);
    expect(await screen.findByText("Kijani Ridge")).toBeTruthy();
    expect(screen.getByText("Send a notice to the school, a year group or a class")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Announcements"));
    expect(onOpen).toHaveBeenCalledWith("Announcements");
  });
});
