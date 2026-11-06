import { Text as MockText } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { ChatMessage } from "@figbloom/shared";
import { ThemeProvider } from "../../ui/ThemeContext";
import { ChatThread } from "./ChatThread";

// One conversation, read by someone in it and (oversight) by the school's office, who is not.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }), useRoute: () => ({ params: mockParams }) }));
jest.mock("../../lib/chatSession", () => ({ useChatSession: () => ({ profileId: "grace", tenantId: "school-1" }) }));
jest.mock("../../lib/chatUnread", () => ({ notifyChatRead: jest.fn() }));
jest.mock("../../calls/CallButtons", () => ({ CallButtons: () => <MockText>CALL BUTTONS</MockText> }));
jest.mock("../../components/AttachChoices", () => ({ AttachChoices: () => null }));
jest.mock("../../lib/pickFile", () => ({ ANY_FILE: {}, pickFile: jest.fn(), readPickedFile: jest.fn() }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchChatMessages: jest.fn(),
  fetchConversationPeople: jest.fn(),
  markConversationRead: jest.fn(),
  subscribeChatMessages: jest.fn(),
  chatFileUrl: jest.fn(),
}));

let mockParams: Record<string, unknown> = {};

const fetchChatMessages = shared.fetchChatMessages as unknown as jest.Mock;
const fetchConversationPeople = shared.fetchConversationPeople as unknown as jest.Mock;
const markConversationRead = shared.markConversationRead as unknown as jest.Mock;
const subscribeChatMessages = shared.subscribeChatMessages as unknown as jest.Mock;

const message = (id: string, senderId: string | null, body: string, createdAt = "2026-11-05T09:30:00Z"): ChatMessage => ({
  id, conversationId: "k1", senderId, body, filePath: null, fileName: null, mimeType: null, sizeBytes: null, createdAt,
});

let live: ((m: ChatMessage) => void) | null = null;

beforeEach(() => {
  live = null;
  fetchChatMessages.mockReset().mockResolvedValue([message("m1", "mary", "Good morning, Ann."), message("m2", "ann", "Morning! How can I help?"), message("m3", "gone", "(left the school)")]);
  fetchConversationPeople.mockReset().mockResolvedValue([
    { profileId: "mary", name: "Mary Otieno", role: "parent", avatarUrl: null },
    { profileId: "ann", name: "Ann Wanjiru", role: "teacher", avatarUrl: null },
  ]);
  markConversationRead.mockReset().mockResolvedValue(undefined);
  subscribeChatMessages.mockReset().mockImplementation((_scope: unknown, onInsert: (m: ChatMessage) => void) => { live = onInsert; return () => {}; });
});

async function open(params: Record<string, unknown>) {
  mockParams = params;
  render(<ThemeProvider><ChatThread tint="#7A1F2B" /></ThemeProvider>);
  await screen.findByText("Good morning, Ann.", {}, { timeout: 5000 });
}

const OVERSIGHT = { conversationId: "k1", name: "Mary Otieno and Ann Wanjiru", subtitle: "Parent · Teacher · read only", canReply: false, oversight: true, backLabel: "All school chats" };
const MINE = { conversationId: "k1", otherId: "mary", name: "Mary Otieno", role: "parent", canReply: true };

describe("a chat read by the school's office", () => {
  it("names both people at the top, and says it is read only, with its own way back", async () => {
    await open(OVERSIGHT);
    expect(screen.getByText("Mary Otieno and Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("Parent · Teacher · read only")).toBeTruthy();
    expect(screen.getByLabelText("All school chats")).toBeTruthy();
  });

  it("names who sent each message, and a sender who has left as a former member", async () => {
    await open(OVERSIGHT);
    expect(fetchConversationPeople).toHaveBeenCalledWith("k1");
    expect(await screen.findByText("Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("Mary Otieno")).toBeTruthy();
    expect(screen.getByText("Former member")).toBeTruthy();
  });

  it("has no composer and no call buttons, and says why", async () => {
    await open(OVERSIGHT);
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByLabelText("Send")).toBeNull();
    expect(screen.queryByText("CALL BUTTONS")).toBeNull();
    expect(screen.getByText("You are reading this chat as the school's administrator. You can't reply to it.")).toBeTruthy();
  });

  it("marks nothing read for the people in it, not when it opens and not when a message arrives", async () => {
    await open(OVERSIGHT);
    await act(async () => { live?.(message("m4", "mary", "Thank you!", "2026-11-05T09:40:00Z")); });
    expect(await screen.findByText("Thank you!")).toBeTruthy();
    expect(markConversationRead).not.toHaveBeenCalled();
  });
});

describe("a chat someone is in", () => {
  it("still has its composer and call buttons, and marks the chat read", async () => {
    await open(MINE);
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByText("CALL BUTTONS")).toBeTruthy();
    expect(screen.getByText("Parent")).toBeTruthy();
    expect(markConversationRead).toHaveBeenCalledWith("k1");
    expect(fetchConversationPeople).not.toHaveBeenCalled();
    expect(screen.queryByText("Former member")).toBeNull();
  });

  it("says the chat can no longer be replied to when the school has changed who teaches the learner", async () => {
    await open({ ...MINE, canReply: false });
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.getByText(/can no longer reply/)).toBeTruthy();
  });
});
