import { fireEvent, render, screen } from "@testing-library/react-native";
import { ConsoleSwitchProvider } from "../../lib/consoleSwitch";
import { ThemeProvider } from "../../ui/ThemeContext";
import { TeacherMore } from "./More";

// The teacher's More list has one extra row for a teacher who holds admin areas: the way to the admin screens.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
jest.mock("../../lib/chatSession", () => ({ useChatSession: () => null }));
jest.mock("../../lib/chatUnread", () => ({ useChatUnread: () => 0 }));
jest.mock("../../lib/useDayVisits", () => ({ useDayVisits: () => ({ visits: null }) }));

const session = { profileId: "ann", tenantId: "school-1", fullName: "Ann Wanjiru", accent: "#7A1F2B", country: "KE" };

/** The theme shows nothing until it has read the person's saved choice, so each test waits for the screen's title. */
async function more(canSwitch: boolean, switchTo = jest.fn()) {
  render(
    <ThemeProvider>
      <ConsoleSwitchProvider value={{ current: "own", canSwitch, switchTo }}>
        <TeacherMore session={session} />
      </ConsoleSwitchProvider>
    </ThemeProvider>,
  );
  await screen.findByText("More");
}

describe("the teacher's More list", () => {
  it("has no admin row for a teacher with no admin areas", async () => {
    await more(false);
    expect(screen.getByText("Leave")).toBeTruthy();
    expect(screen.queryByText("Admin screens")).toBeNull();
  });

  it("opens the admin screens from a row of its own for a teacher who holds areas", async () => {
    const switchTo = jest.fn();
    await more(true, switchTo);
    fireEvent.press(screen.getByText("Admin screens"));
    expect(switchTo).toHaveBeenCalledWith("admin");
  });
});
