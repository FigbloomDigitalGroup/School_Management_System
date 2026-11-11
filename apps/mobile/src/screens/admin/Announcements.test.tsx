import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { formatMoney, type AnnouncementsData } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { AdminAnnouncements } from "./Announcements";

// The announcement composer on the phone: who it reaches, what it says, how it goes out, and the question before it cannot be unsent.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchAnnouncementsData: jest.fn(),
  insertAnnouncement: jest.fn(),
  sendAnnouncementPush: jest.fn(),
}));

const fetchAnnouncementsData = shared.fetchAnnouncementsData as unknown as jest.Mock;
const insertAnnouncement = shared.insertAnnouncement as unknown as jest.Mock;
const sendAnnouncementPush = shared.sendAnnouncementPush as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Principal",
};

function schoolData(over: Partial<AnnouncementsData> = {}): AnnouncementsData {
  return {
    classes: [
      { id: "c1", name: "Grade 1 East", level: "primary", form_level: 1 },
      { id: "c2", name: "Form 2A", level: "secondary", form_level: 2 },
    ],
    byRole: { everyone: 120, parents: 70, students: 30, teachers: 12, staff: 20 },
    reachByYear: new Map([["primary:1", { guardians: 20, students: 5, both: 25 }], ["secondary:2", { guardians: 8, students: 2, both: 10 }]]),
    years: [{ key: "primary:1", level: "primary", year: 1 }, { key: "secondary:2", level: "secondary", year: 2 }],
    reachByClass: new Map([["c1", { guardians: 12, students: 3, both: 15 }], ["c2", { guardians: 0, students: 0, both: 0 }]]),
    recent: [{ id: "n1", subject: "Fees due", published_at: "2026-11-01T08:00:00Z" }, { id: "n2", subject: "Sports day", published_at: "2026-10-20T08:00:00Z" }],
    ...over,
  };
}

let alert: jest.SpyInstance;
beforeEach(() => {
  fetchAnnouncementsData.mockReset().mockResolvedValue(schoolData());
  insertAnnouncement.mockReset().mockResolvedValue("new-id");
  sendAnnouncementPush.mockReset().mockResolvedValue(undefined);
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

/** The theme shows nothing until it has read the person's saved choice, and the counts arrive a moment later (the first, cold run of a suite is slow). */
async function open() {
  render(<ThemeProvider><AdminAnnouncements session={session} /></ThemeProvider>);
  await screen.findByLabelText("Whole school, 120 people", {}, { timeout: 5000 });
}

function write(subject: string, message: string) {
  fireEvent.changeText(screen.getByLabelText("Subject"), subject);
  fireEvent.changeText(screen.getByLabelText("Message"), message);
}

/** Presses Send now, then the "Send now" in the question that follows. */
async function sendAndConfirm() {
  fireEvent.press(screen.getByText("Send now"));
  expect(alert).toHaveBeenCalledTimes(1);
  const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((b) => b.text === "Send now")!.onPress!(); });
}

describe("who should get it", () => {
  it("lists the audiences with how many people each reaches, for the school the person is at", async () => {
    await open();
    expect(fetchAnnouncementsData).toHaveBeenCalledWith("school-1");
    expect(screen.getByLabelText("All parents, 70 people")).toBeTruthy();
    expect(screen.getByLabelText("All students, 30 people")).toBeTruthy();
    expect(screen.getByLabelText("All teachers, 12 people")).toBeTruthy();
    expect(screen.getByLabelText("All staff, 20 people")).toBeTruthy();
    expect(screen.getByLabelText("One year group, 25 people")).toBeTruthy();
    expect(screen.getByLabelText("One class, 15 people")).toBeTruthy();
  });

  it("starts on the whole school", async () => {
    await open();
    expect(screen.getByLabelText("Whole school, 120 people").props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByLabelText("All parents, 70 people").props.accessibilityState).toMatchObject({ selected: false });
  });

  it("asks which class, and parents or learners, and counts for that class", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("One class, 15 people"));
    expect(screen.getByText("Grade 1 East")).toBeTruthy();
    expect(screen.getByText("Form 2A")).toBeTruthy();
    fireEvent.press(screen.getByText("Parents only"));
    expect(screen.getByLabelText("One class, 12 people")).toBeTruthy();
    fireEvent.press(screen.getByText("Students only"));
    expect(screen.getByLabelText("One class, 3 people")).toBeTruthy();
  });

  it("asks which year group, with its name, and counts for that year group", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("One year group, 25 people"));
    expect(screen.getByText("Grade 1")).toBeTruthy();
    fireEvent.press(screen.getByText("Form 2"));
    expect(screen.getByLabelText("One year group, 10 people")).toBeTruthy();
  });
});

describe("sending", () => {
  it("cannot be sent until it has a subject and a message", async () => {
    await open();
    fireEvent.press(screen.getByText("Send now"));
    write("Half-term", "");
    fireEvent.press(screen.getByText("Send now"));
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks first, with the number of people, and that it cannot be unsent", async () => {
    await open();
    write("Half-term", "Closing Friday.");
    fireEvent.press(screen.getByText("Send now"));
    expect(alert).toHaveBeenCalledWith("Send to 120 people?", "This cannot be unsent.", expect.any(Array));
    expect(insertAnnouncement).not.toHaveBeenCalled();
  });

  it("says what the texts will cost, in the school's money, when SMS is on", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("SMS"));
    write("Half-term", "Closing Friday.");
    fireEvent.press(screen.getByText("Send now"));
    expect(alert).toHaveBeenCalledWith("Send to 120 people?", `This cannot be unsent. Texting them will cost about ${formatMoney(9_600, "KE")}.`, expect.any(Array));
    expect(screen.getAllByText(formatMoney(9_600, "KE")).length).toBeGreaterThan(0);
  });

  it("writes the notice to the school, from the person sending, with the channels chosen, then sends the push, says so, and clears the form", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("All parents, 70 people"));
    write("Half-term", "Closing Friday.");
    await sendAndConfirm();
    expect(insertAnnouncement).toHaveBeenCalledWith(
      "school-1",
      "grace",
      { subject: "Half-term", body: "Closing Friday.", audience: { kind: "role", role: "parent" }, channels: { in_app: true, push: true, sms: false, email: false } },
      true,
    );
    expect(sendAnnouncementPush).toHaveBeenCalledWith("new-id");
    expect(await screen.findByText("Sent to 70 people.")).toBeTruthy();
    expect(screen.getByLabelText("Subject").props.value).toBe("");
    expect(screen.getByLabelText("Message").props.value).toBe("");
    // the recent list is read again, so what was just sent shows up in it
    expect(fetchAnnouncementsData).toHaveBeenCalledTimes(2);
  });

  it("sends a class notice to that class, to the parents or learners chosen", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("One class, 15 people"));
    fireEvent.press(screen.getByText("Parents only"));
    write("Trip", "Bring a packed lunch.");
    await sendAndConfirm();
    expect(insertAnnouncement.mock.calls[0]![2].audience).toEqual({ kind: "class", class_id: "c1", recipients: "guardians" });
  });

  it("sends no push when push is off", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("Push notification"));
    write("Half-term", "Closing Friday.");
    await sendAndConfirm();
    expect(sendAnnouncementPush).not.toHaveBeenCalled();
    expect(insertAnnouncement.mock.calls[0]![2].channels).toMatchObject({ push: false });
  });

  it("says the notice went, and that the push did not, when only the push fails", async () => {
    sendAnnouncementPush.mockRejectedValue(new Error("FCM unavailable"));
    await open();
    write("Half-term", "Closing Friday.");
    await sendAndConfirm();
    expect(await screen.findByText("Sent to 120 people. Push notifications failed: FCM unavailable")).toBeTruthy();
  });

  it("says why it could not send, and keeps what was written", async () => {
    insertAnnouncement.mockRejectedValue(new Error("new row violates row-level security policy"));
    await open();
    write("Half-term", "Closing Friday.");
    await sendAndConfirm();
    expect(await screen.findByText("Could not send: new row violates row-level security policy")).toBeTruthy();
    expect(screen.getByLabelText("Subject").props.value).toBe("Half-term");
    expect(sendAnnouncementPush).not.toHaveBeenCalled();
  });

  it("will not send to nobody, and says so", async () => {
    await open();
    fireEvent.press(screen.getByLabelText("One class, 15 people"));
    fireEvent.press(screen.getByText("Form 2A"));
    write("Half-term", "Closing Friday.");
    expect(screen.getByText("This would reach no one. Pick someone else, or another class or year group.")).toBeTruthy();
    fireEvent.press(screen.getByText("Send now"));
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("the rest of the screen", () => {
  it("lists what was sent lately", async () => {
    await open();
    expect(screen.getByText("Fees due")).toBeTruthy();
    expect(screen.getByText("Sports day")).toBeTruthy();
    expect(screen.getByText("1 Nov 2026")).toBeTruthy();
  });

  it("says nothing has been sent when nothing has", async () => {
    fetchAnnouncementsData.mockResolvedValue(schoolData({ recent: [] }));
    await open();
    expect(screen.getByText("Nothing has been sent from the school yet.")).toBeTruthy();
  });

  it("points to the web for files and signatures", async () => {
    await open();
    expect(screen.getByText("To attach files or ask families to sign something, use the web console.")).toBeTruthy();
  });

  it("says why it could not load the school, and tries again on request", async () => {
    fetchAnnouncementsData.mockRejectedValueOnce(new Error("Network request failed"));
    render(<ThemeProvider><AdminAnnouncements session={session} /></ThemeProvider>);
    expect(await screen.findByText("Network request failed")).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText("Try again")); });
    expect(await screen.findByLabelText("Whole school, 120 people")).toBeTruthy();
  });
});
