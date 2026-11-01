import { describe, expect, it } from "vitest";
import {
  attachmentName, bytesToBase64, checkChatAttachment, chatAttachmentKind, CHAT_MAX_ATTACHMENTS,
} from "./bloomAttachments";

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const LIMIT = 50 * 1024 ** 2;

describe("bytesToBase64", () => {
  it("matches the RFC 4648 test vectors, with padding", () => {
    expect(bytesToBase64(bytes(""))).toBe("");
    expect(bytesToBase64(bytes("f"))).toBe("Zg==");
    expect(bytesToBase64(bytes("fo"))).toBe("Zm8=");
    expect(bytesToBase64(bytes("foo"))).toBe("Zm9v");
    expect(bytesToBase64(bytes("foob"))).toBe("Zm9vYg==");
    expect(bytesToBase64(bytes("fooba"))).toBe("Zm9vYmE=");
    expect(bytesToBase64(bytes("foobar"))).toBe("Zm9vYmFy");
  });

  it("handles every byte value, as a PDF has them", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(bytesToBase64(all)).toBe(Buffer.from(all).toString("base64"));
  });
});

describe("chatAttachmentKind", () => {
  it("reads PDF, Word and plain text, by type or by name when the type is missing", () => {
    expect(chatAttachmentKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(chatAttachmentKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("docx");
    expect(chatAttachmentKind("text/plain", "a.txt")).toBe("text");
    expect(chatAttachmentKind("", "notes.csv")).toBe("text");
    expect(chatAttachmentKind("image/png", "a.png")).toBeNull();
  });
});

describe("checkChatAttachment", () => {
  it("accepts a file within the limits", () => {
    expect(checkChatAttachment({ name: "a.pdf", size: 1024 }, [], LIMIT)).toBeNull();
  });

  it("stops at three files, and at the most Bloom can read at once", () => {
    const three = Array.from({ length: CHAT_MAX_ATTACHMENTS }, () => ({ size: 1 }));
    expect(checkChatAttachment({ name: "a.pdf", size: 1 }, three, LIMIT)).toMatch(/up to 3 files/);
    expect(checkChatAttachment({ name: "big.pdf", size: 25 * 1024 ** 2 }, [], LIMIT)).toMatch(/can read up to 20 MB/);
    expect(checkChatAttachment({ name: "b.pdf", size: 12 * 1024 ** 2 }, [{ size: 12 * 1024 ** 2 }], LIMIT)).toMatch(/Together/);
  });

  it("refuses an empty or too long text", () => {
    expect(checkChatAttachment({ name: "e.txt", size: 0, textLength: 0 }, [], LIMIT)).toMatch(/is empty/);
    expect(checkChatAttachment({ name: "l.txt", size: 10, textLength: 120_001 }, [], LIMIT)).toMatch(/too long/);
  });
});

describe("attachmentName", () => {
  it("keeps one clean line, and a name for the nameless", () => {
    expect(attachmentName("Lesson\nplan\t.docx")).toBe("Lesson plan .docx");
    expect(attachmentName("   ")).toBe("Untitled");
  });
});
