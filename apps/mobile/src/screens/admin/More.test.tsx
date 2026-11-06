import { fireEvent, render, screen } from "@testing-library/react-native";
import { adminScreensFor, ADMIN_SCREENS } from "../../adminScreens";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminMore } from "./More";

// The admin side's menu: one row for each screen this person's areas open.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
const mockUnread = jest.fn(() => 0);
jest.mock("../../lib/chatUnread", () => ({ useChatUnread: () => mockUnread() }));

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

describe("which admin screens a person is offered", () => {
  it("is every screen for a full admin", () => {
    expect(adminScreensFor("all")).toEqual([...ADMIN_SCREENS]);
  });
  it("is the screens an area covers, and only those: announcements and chats for Communication, none for Fees alone", () => {
    expect(adminScreensFor(["communication"]).map((s) => s.to)).toEqual(["Announcements", "Chats", "SchoolChats", "CallLog"]);
    expect(adminScreensFor(["fees", "leave"])).toEqual([]);
  });
  it("is nothing for someone with no admin console", () => {
    expect(adminScreensFor(null)).toEqual([]);
  });
});

describe("the admin More list", () => {
  beforeEach(() => { mockUnread.mockReturnValue(0); });

  it("shows a row for each screen, with what it is for, and opens the one tapped", async () => {
    const onOpen = jest.fn();
    render(<ThemeProvider><AdminMore session={session} screens={adminScreensFor("all")} onOpen={onOpen} /></ThemeProvider>);
    expect(await screen.findByText("Kijani Ridge")).toBeTruthy();
    expect(screen.getByText("Send a notice to the school, a year group or a class")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Announcements"));
    expect(onOpen).toHaveBeenCalledWith("Announcements");
    fireEvent.press(screen.getByLabelText("Chats"));
    expect(onOpen).toHaveBeenCalledWith("Chats");
    fireEvent.press(screen.getByLabelText("All school chats"));
    expect(onOpen).toHaveBeenCalledWith("SchoolChats");
    fireEvent.press(screen.getByLabelText("Call log"));
    expect(onOpen).toHaveBeenCalledWith("CallLog");
  });

  it("says how many chat messages are waiting, on the Chats row only", async () => {
    mockUnread.mockReturnValue(3);
    render(<ThemeProvider><AdminMore session={session} screens={adminScreensFor("all")} onOpen={jest.fn()} /></ThemeProvider>);
    expect(await screen.findByLabelText("Chats, 3 new")).toBeTruthy();
    expect(screen.getByLabelText("All school chats")).toBeTruthy();
    expect(screen.getByLabelText("Announcements")).toBeTruthy();
  });
});
