import { describe, expect, it } from "vitest";
import {
  attachmentLabel, attachmentName, chatAttachmentKind, chatAttachmentMaxBytes, checkChatAttachment, CHAT_ATTACHMENT_MAX_CHARS, CHAT_MAX_ATTACHMENTS,
} from "./bloomAttachments";
import { parseAttachmentNames } from "./aiChat";
import { bloomExportFileName } from "./bloomExport";
import {
  driveFileName, driveMultipart, driveOpenLabel, drivePickedFetch, driveUploadMetadata, GOOGLE_DOC, GOOGLE_SHEET, pickedAttachmentName, shortAccount,
} from "./googleDrive";

const MB = 1024 ** 2;
const NOW = new Date(2026, 9, 28);

describe("Drive file names", () => {
  it("names a file as the download is named, without the extension Drive converts away", () => {
    const docx = bloomExportFileName("Half term circular", NOW, "docx");
    expect(docx).toBe("Bloom - Half term circular - 2026-10-28.docx");
    expect(driveFileName(docx, "doc")).toBe("Bloom - Half term circular - 2026-10-28");
    expect(driveFileName(bloomExportFileName("Fees", NOW, "xlsx"), "sheet")).toBe("Bloom - Fees - 2026-10-28");
    expect(driveFileName(bloomExportFileName("Fees", NOW, "pdf"), "pdf")).toBe("Bloom - Fees - 2026-10-28.pdf");
  });

  it("asks Drive to convert Word to a Google Doc and Excel to a Google Sheet, and keeps a PDF as it is", () => {
    expect(driveUploadMetadata("a.docx", "doc")).toEqual({ name: "a", mimeType: GOOGLE_DOC });
    expect(driveUploadMetadata("a.xlsx", "sheet")).toEqual({ name: "a", mimeType: GOOGLE_SHEET });
    expect(driveUploadMetadata("a.pdf", "pdf")).toEqual({ name: "a.pdf", mimeType: "application/pdf" });
    expect(driveOpenLabel("doc")).toBe("Open in Google Docs");
    expect(driveOpenLabel("sheet")).toBe("Open in Google Sheets");
    expect(driveOpenLabel("pdf")).toBe("Open in Google Drive");
  });
});

describe("driveMultipart", () => {
  it("builds the metadata part and the file part Drive's multipart upload expects", () => {
    const meta = { name: "Bloom - Muhtasari “wa” somo", mimeType: GOOGLE_DOC };
    const m = driveMultipart(meta, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "bloom-123");
    expect(m.contentType).toBe("multipart/related; boundary=bloom-123");
    const body = `${m.head}FILE${m.tail}`;
    expect(body).toBe(
      "--bloom-123\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
      + `{"name":"Bloom - Muhtasari “wa” somo","mimeType":"application/vnd.google-apps.document"}\r\n`
      + "--bloom-123\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
      + "FILE\r\n--bloom-123--\r\n",
    );
    // the metadata is real JSON, whatever the name holds
    const json = /\r\n\r\n(\{.*\})\r\n/.exec(m.head)![1]!;
    expect(JSON.parse(json)).toEqual(meta);
  });

  it("refuses a boundary that could break the body", () => {
    expect(() => driveMultipart({ name: "a", mimeType: "x" }, "x", "has space")).toThrow();
    expect(() => driveMultipart({ name: "a", mimeType: "x" }, "x", "a\r\nb")).toThrow();
    expect(() => driveMultipart({ name: "a", mimeType: "x" }, "x", "")).toThrow();
  });
});

describe("picked files", () => {
  it("exports a Doc as Markdown (plain text if that fails) and a Sheet as CSV, and downloads the rest", () => {
    expect(drivePickedFetch(GOOGLE_DOC)).toEqual({ export: "text/markdown", fallback: "text/plain" });
    expect(drivePickedFetch(GOOGLE_SHEET)).toEqual({ export: "text/csv" });
    expect(drivePickedFetch("application/pdf")).toEqual({ download: true });
    expect(pickedAttachmentName("Fees 2026", GOOGLE_SHEET)).toBe("Fees 2026 (Google Sheet, first sheet)");
    expect(pickedAttachmentName("Plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("Plan.docx");
  });

  it("reads Docs, Sheets, text, PDF and Word, and nothing else", () => {
    expect(chatAttachmentKind(GOOGLE_DOC, "Plan")).toBe("text");
    expect(chatAttachmentKind(GOOGLE_SHEET, "Fees")).toBe("text");
    expect(chatAttachmentKind("text/plain", "notes.txt")).toBe("text");
    expect(chatAttachmentKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(chatAttachmentKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("docx");
    expect(chatAttachmentKind("", "a.docx")).toBe("docx");
    expect(chatAttachmentKind("image/png", "a.png")).toBeNull();
    expect(chatAttachmentKind("application/vnd.google-apps.presentation", "Slides")).toBeNull();
    expect(chatAttachmentKind("application/msword", "old.doc")).toBeNull();
  });

  it("shows just enough of the account", () => {
    expect(shortAccount("mwalimu.wanjiru@kijani.sc.ke")).toBe("mwalimu.wanjiru@…");
    expect(shortAccount("odd")).toBe("odd");
  });
});

describe("attachment limits", () => {
  it("reads up to the paper import's 20 MB, and never more than the upload limit", () => {
    expect(chatAttachmentMaxBytes(50 * MB)).toBe(20 * MB);
    expect(chatAttachmentMaxBytes(10 * MB)).toBe(10 * MB);
  });

  it("refuses a file too big, too much together, too many files, or a document too long", () => {
    const limit = 50 * MB;
    expect(checkChatAttachment({ name: "plan.pdf", size: 2 * MB }, [], limit)).toBeNull();
    expect(checkChatAttachment({ name: "book.pdf", size: 21 * MB }, [], limit)).toBe(`"book.pdf" is 21 MB. Bloom can read up to 20 MB at a time.`);
    expect(checkChatAttachment({ name: "b.pdf", size: 8 * MB }, [{ size: 7 * MB }, { size: 6 * MB }], limit)).toBe("Together these files come to 21 MB. Bloom can read up to 20 MB at a time.");
    expect(checkChatAttachment({ name: "d.pdf", size: 1 }, Array.from({ length: CHAT_MAX_ATTACHMENTS }, () => ({ size: 1 })), limit)).toBe("Bloom can read up to 3 files with one question.");
    expect(checkChatAttachment({ name: "Sheet", size: 10, textLength: CHAT_ATTACHMENT_MAX_CHARS + 1 }, [], limit)).toMatch(/too long/);
    expect(checkChatAttachment({ name: "Blank", size: 0, textLength: 0 }, [], limit)).toBe(`"Blank" is empty.`);
    // a smaller upload limit wins
    expect(checkChatAttachment({ name: "a.pdf", size: 6 * MB }, [], 5 * MB)).toMatch(/up to 5.0 MB/);
  });

  it("reads saved attachment names defensively", () => {
    expect(parseAttachmentNames(["Lesson plan.docx", "", 7, "Fees (Google Sheet, first sheet)"])).toEqual(["Lesson plan.docx", "Fees (Google Sheet, first sheet)"]);
    expect(parseAttachmentNames(null)).toEqual([]);
    expect(parseAttachmentNames(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
  });

  it("keeps a name to one clean line", () => {
    expect(attachmentName("  Lesson\nplan\t.docx ")).toBe("Lesson plan .docx");
    expect(attachmentName("")).toBe("Untitled");
    expect(attachmentName("x".repeat(300))).toHaveLength(200);
    expect(attachmentLabel("Lesson plan.docx")).toBe("📎 Lesson plan.docx");
  });
});
