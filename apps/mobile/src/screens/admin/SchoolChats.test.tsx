import { fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { SchoolConversation } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { SchoolChats } from "./SchoolChats";

// Every chat in the school, for the office to read: filter by who is in it, and open one to read.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchSchoolConversations: jest.fn() }));

const fetchSchoolConversations = shared.fetchSchoolConversations as unknown as jest.Mock;

const session: StaffSession = {
  role: "school_admin", accent: "#7A1F2B", profileId: "grace", tenantId: "school-1", fullName: "Grace Njeri", country: "KE",
  adminAreas: [], school: { name: "Kijani Ridge", slug: "kijani" }, title: null,
};

const chat = (id: string, a: string, b: string, count: number, last: string | null): SchoolConversation => ({
  id,
  a: { profileId: `${id}-a`, name: a, role: "parent" },
  b: { profileId: `${id}-b`, name: b, role: "teacher" },
  lastMessageAt: "2026-11-05T09:30:00Z",
  messageCount: count,
  lastBody: last,
});

beforeEach(() => {
  fetchSchoolConversations.mockReset().mockResolvedValue([
    chat("k1", "Mary Otieno", "Ann Wanjiru", 12, "Thank you, see you Friday.\nRegards"),
    chat("k2", "Joel Kamau", "Ann Wanjiru", 1, null),
    chat("k3", "Ruth Njeri", "Peter Mwangi", 4, "Noted."),
  ]);
});

async function open(onOpen = jest.fn()) {
  render(<ThemeProvider><SchoolChats session={session} onOpen={onOpen} /></ThemeProvider>);
  await screen.findByText("Mary Otieno and Ann Wanjiru", {}, { timeout: 5000 });
  return onOpen;
}

describe("the school's chats", () => {
  it("lists each chat by the two people in it, with their roles, how many messages, and the last one's first line", async () => {
    await open();
    expect(fetchSchoolConversations).toHaveBeenCalledWith("school-1");
    expect(screen.getByText("Joel Kamau and Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("Ruth Njeri and Peter Mwangi")).toBeTruthy();
    expect(screen.getByText("Thank you, see you Friday.")).toBeTruthy();
    expect(screen.getByText("Parent · Teacher · 12 messages")).toBeTruthy();
    expect(screen.getByText("Parent · Teacher · 1 message")).toBeTruthy();
  });

  it("finds the chats with someone by any part of their name, on either side", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Filter by name"), "ann");
    expect(screen.getByText("Mary Otieno and Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("Joel Kamau and Ann Wanjiru")).toBeTruthy();
    expect(screen.queryByText("Ruth Njeri and Peter Mwangi")).toBeNull();
  });

  it("says no chat matches a name that nobody has", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Filter by name"), "nobody");
    expect(screen.getByText("No chats match this name.")).toBeTruthy();
  });

  it("opens a chat as a read-only oversight thread, named for both people", async () => {
    const onOpen = await open();
    fireEvent.press(screen.getByLabelText("Mary Otieno and Ann Wanjiru, 12 messages"));
    expect(onOpen).toHaveBeenCalledWith({
      conversationId: "k1",
      name: "Mary Otieno and Ann Wanjiru",
      subtitle: "Parent · Teacher · read only",
      canReply: false,
      oversight: true,
      backLabel: "All school chats",
    });
  });

  it("says no one has chatted yet when nobody has", async () => {
    fetchSchoolConversations.mockResolvedValue([]);
    render(<ThemeProvider><SchoolChats session={session} onOpen={jest.fn()} /></ThemeProvider>);
    expect(await screen.findByText("No one at the school has chatted yet.", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("says why it could not load the chats, and tries again on request", async () => {
    fetchSchoolConversations.mockRejectedValueOnce(new Error("permission denied for function school_conversations"));
    render(<ThemeProvider><SchoolChats session={session} onOpen={jest.fn()} /></ThemeProvider>);
    expect(await screen.findByText("permission denied for function school_conversations", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Mary Otieno and Ann Wanjiru")).toBeTruthy();
  });
});
