import { launchImageLibrary } from "react-native-image-picker";
import { LEAVE_DOCUMENT_FILES, pickFile, readPickedBase64 } from "./pickFile";

// Getting a file from the phone: how a leave document is sized down and read for HR.

jest.mock("@react-native-documents/picker", () => ({
  errorCodes: { OPERATION_CANCELED: "OPERATION_CANCELED" },
  isErrorWithCode: () => false,
  keepLocalCopy: jest.fn(),
  pick: jest.fn(),
  types: {
    pdf: "application/pdf", images: "image/*", doc: "application/msword", allFiles: "*/*",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
}));
jest.mock("react-native-image-picker", () => ({ launchCamera: jest.fn(), launchImageLibrary: jest.fn() }));

const library = launchImageLibrary as unknown as jest.Mock;
const file = { uri: "file:///cache/note.pdf", name: "note.pdf", mimeType: "application/pdf", sizeBytes: null };

/** The two browser APIs a file read goes through, stood in for with what they answer. */
type Globals = { XMLHttpRequest?: unknown; FileReader?: unknown };
const globals = globalThis as Globals;
const saved = { xhr: globals.XMLHttpRequest, reader: globals.FileReader };
afterEach(() => { globals.XMLHttpRequest = saved.xhr; globals.FileReader = saved.reader; });

function standIn({ blob = { size: 3 } as object | null, xhrFails = false, dataUrl = "data:application/pdf;base64,QUJD", readerFails = false } = {}) {
  const opened: string[] = [];
  globals.XMLHttpRequest = class {
    responseType = "";
    response: unknown = blob;
    onload?: () => void;
    onerror?: () => void;
    open(_method: string, url: string) { opened.push(url); }
    send() { setTimeout(() => (xhrFails ? this.onerror?.() : this.onload?.()), 0); }
  };
  globals.FileReader = class {
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    readAsDataURL() { setTimeout(() => { if (readerFails) this.onerror?.(); else { this.result = dataUrl; this.onload?.(); } }, 0); }
  };
  return opened;
}

describe("a file read as base64, for a call that carries it in its body", () => {
  it("is the file's bytes without the data-URL prefix, and the size of what was read", async () => {
    const opened = standIn({ blob: { size: 1234 } });
    expect(await readPickedBase64(file)).toEqual({ base64: "QUJD", size: 1234 });
    expect(opened).toEqual(["file:///cache/note.pdf"]);
  });

  it("says to choose the file again when it cannot be read: not found, empty, or the reader failing", async () => {
    standIn({ xhrFails: true });
    await expect(readPickedBase64(file)).rejects.toThrow("Could not read that file. Choose it again.");
    standIn({ blob: null });
    await expect(readPickedBase64(file)).rejects.toThrow("Could not read that file. Choose it again.");
    standIn({ readerFails: true });
    await expect(readPickedBase64(file)).rejects.toThrow("Could not read that file. Choose it again.");
  });
});

describe("a photo for a leave document", () => {
  beforeEach(() => { library.mockReset().mockResolvedValue({ assets: [{ uri: "file:///cache/p.jpg", fileName: "p.jpg", type: "image/jpeg", fileSize: 900_000 }] }); });

  it("is shrunk to the size asked for, a side at most", async () => {
    expect(await pickFile("gallery", LEAVE_DOCUMENT_FILES, { maxPixels: 2000 })).toMatchObject({ name: "p.jpg", mimeType: "image/jpeg", sizeBytes: 900_000 });
    expect(library).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 2000, maxHeight: 2000 }));
  });

  it("is left at its own size when nothing is asked for, as before", async () => {
    await pickFile("gallery");
    expect(library).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: undefined, maxHeight: undefined }));
  });
});

describe("what a leave document may be", () => {
  it("is what HR takes: a PDF, a photo, a Word document", () => {
    expect(LEAVE_DOCUMENT_FILES).toEqual(["application/pdf", "image/*", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
  });
});
