import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ConsoleSwitchProvider } from "../../lib/consoleSwitch";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminHome, webConsoleUrl } from "./Home";

const base: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Principal",
};

/** The theme shows nothing until it has read the person's saved choice, so every test waits for the school's name first. */
async function home(session: StaffSession, canSwitch = false, switchTo = jest.fn()) {
  const view = render(
    <ThemeProvider>
      <ConsoleSwitchProvider value={{ current: "admin", canSwitch, switchTo }}>
        <AdminHome session={session} />
      </ConsoleSwitchProvider>
    </ThemeProvider>,
  );
  await screen.findByText(session.school.name);
  return view;
}

describe("the admin home", () => {
  it("names the school and the person, with their title", async () => {
    await home(base);
    expect(screen.getByText("Grace Njeri · Principal")).toBeTruthy();
  });

  it("tells a school admin they have everything", async () => {
    await home(base);
    expect(screen.getByText("Everything in the admin console")).toBeTruthy();
  });

  it("lists exactly the areas a teacher or other staff member holds, in the words the office reads", async () => {
    await home({ ...base, role: "teacher", title: null, adminAreas: ["fees", "leave"] });
    expect(screen.getByText("Grace Njeri")).toBeTruthy();
    expect(screen.getByText("Fees")).toBeTruthy();
    expect(screen.getByText("Leave")).toBeTruthy();
    expect(screen.getByText("Approve or decline staff leave requests.")).toBeTruthy();
    expect(screen.queryByText("Everything in the admin console")).toBeNull();
    expect(screen.queryByText("People")).toBeNull();
  });

  it("points to the web console of this school, for everything the phone does not do yet", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await home(base);
    await act(async () => { fireEvent.press(screen.getByText("Open the web console")); });
    expect(open).toHaveBeenCalledWith("https://schoolmanagement.figbloom.org/s/kijani/admin");
    expect(webConsoleUrl("kijani")).toBe("https://schoolmanagement.figbloom.org/s/kijani/admin");
    open.mockRestore();
  });

  it("offers a way back to the teacher screens only to someone who has both", async () => {
    const switchTo = jest.fn();
    const first = await home({ ...base, role: "teacher", adminAreas: ["fees"] }, true, switchTo);
    fireEvent.press(screen.getByText("Back to teacher screens"));
    expect(switchTo).toHaveBeenCalledWith("own");
    first.unmount();

    await home(base);
    expect(screen.queryByText("Back to teacher screens")).toBeNull();
  });
});
