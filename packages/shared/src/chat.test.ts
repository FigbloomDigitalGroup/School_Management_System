import { describe, expect, it } from "vitest";
import {
  chatDayLabel, chatDraftBody, chatFilePath, chatMimeForFile, conversationPreview, groupMessagesByDay, mergeMessage,
  type ChatMessage,
} from "./chat";

function msg(id: string, createdAt: string): ChatMessage {
  return { id, conversationId: "c1", senderId: "p1", body: id, filePath: null, fileName: null, mimeType: null, sizeBytes: null, createdAt };
}

describe("chatMimeForFile", () => {
  it("takes documents, pictures and voice notes", () => {
    expect(chatMimeForFile({ name: "form.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(chatMimeForFile({ name: "photo.jpg", type: "image/jpeg" })).toBe("image/jpeg");
    expect(chatMimeForFile({ name: "voice.m4a" })).toBe("audio/mp4");
  });
  it("refuses what the chat bucket won't take, even if learning materials would", () => {
    expect(chatMimeForFile({ name: "notes.zip", type: "application/zip" })).toBeNull();
    expect(chatMimeForFile({ name: "lesson.mkv", type: "" })).toBeNull();
    expect(chatMimeForFile({ name: "setup.exe", type: "application/x-msdownload" })).toBeNull();
  });
});

describe("chatFilePath", () => {
  it("puts the file under the conversation's own folder", () => {
    const path = chatFilePath("t1", "c1", "Fee receipt (Term 3).pdf");
    expect(path.startsWith("t1/c1/")).toBe(true);
    expect(path.split("/")).toHaveLength(3);
    expect(path).toMatch(/Fee receipt _Term 3_\.pdf$/);
  });
  it("can't be steered into another folder by the file name", () => {
    expect(chatFilePath("t1", "c1", "../../t2/c9/x.pdf").split("/")).toHaveLength(3);
  });
});

describe("chatDraftBody", () => {
  it("trims, and has nothing to send for blank text", () => {
    expect(chatDraftBody("  hello \n")).toBe("hello");
    expect(chatDraftBody("   \n ")).toBeNull();
  });
});

describe("conversationPreview", () => {
  it("marks the caller's own last message and keeps only the first line", () => {
    expect(conversationPreview({ lastBody: "See you Friday\nThanks", lastSenderId: "me" }, "me")).toBe("You: See you Friday");
    expect(conversationPreview({ lastBody: "Noted", lastSenderId: "them" }, "me")).toBe("Noted");
  });
  it("says so when nothing has been sent", () => {
    expect(conversationPreview({ lastBody: null, lastSenderId: null }, "me")).toBe("No messages yet");
  });
});

describe("groupMessagesByDay", () => {
  it("starts a new group whenever the day changes", () => {
    const groups = groupMessagesByDay([
      msg("a", new Date(2026, 9, 20, 9).toISOString()),
      msg("b", new Date(2026, 9, 20, 17).toISOString()),
      msg("c", new Date(2026, 9, 21, 8).toISOString()),
    ]);
    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([["a", "b"], ["c"]]);
  });
  it("is empty for no messages", () => {
    expect(groupMessagesByDay([])).toEqual([]);
  });
});

describe("chatDayLabel", () => {
  const now = new Date(2026, 9, 26, 12);
  it("names today and yesterday", () => {
    expect(chatDayLabel(new Date(2026, 9, 26, 7).toISOString(), now)).toBe("Today");
    expect(chatDayLabel(new Date(2026, 9, 25, 22).toISOString(), now)).toBe("Yesterday");
  });
  it("adds the year only for another year", () => {
    expect(chatDayLabel(new Date(2026, 9, 20, 9).toISOString(), now)).not.toMatch(/2026/);
    expect(chatDayLabel(new Date(2025, 9, 20, 9).toISOString(), now)).toMatch(/2025/);
  });
});

describe("mergeMessage", () => {
  it("adds a new message in time order", () => {
    const list = [msg("a", "2026-10-26T08:00:00Z"), msg("c", "2026-10-26T10:00:00Z")];
    expect(mergeMessage(list, msg("b", "2026-10-26T09:00:00Z")).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  it("ignores a message already shown (sent here, then echoed by Realtime)", () => {
    const list = [msg("a", "2026-10-26T08:00:00Z")];
    expect(mergeMessage(list, msg("a", "2026-10-26T08:00:00Z"))).toBe(list);
  });
});
