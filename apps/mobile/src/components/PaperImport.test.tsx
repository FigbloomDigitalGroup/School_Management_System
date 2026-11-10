import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { PaperImportDraft } from "@figbloom/shared";
import * as pick from "../lib/pickFile";
import * as uploads from "../lib/uploads";
import { PaperImport } from "./PaperImport";

// The icon library ships as untranspiled ES modules; the icons are not what this tests.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : () => null) }));
jest.mock("../lib/pickFile", () => ({ PAPER_IMPORT_FILES: ["application/pdf"], pickFile: jest.fn(), readPickedFile: jest.fn() }));
jest.mock("../lib/uploads", () => ({ uploadPaperImportFiles: jest.fn(), removePaperImportFiles: jest.fn() }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), importPaperWithAi: jest.fn() }));

const mocked = (fn: unknown) => fn as jest.Mock;
const api = {
  pickFile: mocked(pick.pickFile),
  readPickedFile: mocked(pick.readPickedFile),
  uploadPaperImportFiles: mocked(uploads.uploadPaperImportFiles),
  removePaperImportFiles: mocked(uploads.removePaperImportFiles),
  importPaperWithAi: mocked(shared.importPaperWithAi),
};

const PDF = { uri: "file:///paper.pdf", name: "paper.pdf", mimeType: "application/pdf", sizeBytes: 120_000 };
const photo = (n: number) => ({ uri: `file:///p${n}.jpg`, name: `p${n}.jpg`, mimeType: "image/jpeg", sizeBytes: 300_000 });
const DRAFT: PaperImportDraft = {
  title: "Form 2 Chemistry", instructions: "", durationMinutes: 60, warnings: [],
  questions: [{ kind: "short", prompt: "Define an acid.", options: [], points: 2, correctOption: null, modelAnswer: "" }],
};

const onImported = jest.fn();
const onBusy = jest.fn();
const onClose = jest.fn();

beforeEach(() => {
  for (const f of [onImported, onBusy, onClose]) f.mockReset();
  api.pickFile.mockReset().mockResolvedValue(PDF);
  api.readPickedFile.mockReset().mockImplementation(async (f: { name: string; mimeType: string }) => ({ blob: { size: 120_000 }, name: f.name, mimeType: f.mimeType }));
  api.uploadPaperImportFiles.mockReset().mockResolvedValue(["s-1/paper-imports/t-1/a.pdf"]);
  api.removePaperImportFiles.mockReset().mockResolvedValue(undefined);
  api.importPaperWithAi.mockReset().mockResolvedValue(DRAFT);
});

async function show(over: Partial<Parameters<typeof PaperImport>[0]> = {}) {
  render(
    <PaperImport
      session={{ tenantId: "s-1", profileId: "t-1", accent: "forest" }}
      subject="Chemistry" className="Form 2 West" kind="exam" hasQuestions={false}
      onImported={onImported} onBusy={onBusy} onClose={onClose}
      {...over}
    />,
  );
  await screen.findByText("Import a paper with Bloom");
}
const choose = async (label = "📄 PDF or file") => { await act(async () => { fireEvent.press(screen.getByText(label)); }); };
const importIt = () => fireEvent.press(screen.getByText("Import paper"));

describe("choosing the paper", () => {
  it("cannot import until a file has been chosen", async () => {
    await show();
    importIt();
    await act(async () => {});
    expect(api.readPickedFile).not.toHaveBeenCalled();
    expect(api.importPaperWithAi).not.toHaveBeenCalled();
  });

  it("lists the file chosen, with its size, and lets it be taken off", async () => {
    await show();
    await choose();
    expect(screen.getByText("paper.pdf · 117 KB")).toBeTruthy();
    fireEvent.press(screen.getByText("Remove"));
    expect(screen.queryByText(/paper\.pdf/)).toBeNull();
  });

  it("asks the phone for a photo, a picture from the gallery, or a file, as the buttons say", async () => {
    await show();
    await choose("📷 Take a photo");
    expect(api.pickFile).toHaveBeenLastCalledWith("camera", expect.anything(), expect.objectContaining({ maxPixels: expect.any(Number) }));
    await choose("🖼 Photo");
    expect(api.pickFile).toHaveBeenLastCalledWith("gallery", expect.anything(), expect.anything());
    await choose();
    expect(api.pickFile).toHaveBeenLastCalledWith("document", expect.anything(), expect.anything());
  });

  it("takes several photos of the pages, in the order they were taken", async () => {
    await show();
    api.pickFile.mockResolvedValueOnce(photo(1)).mockResolvedValueOnce(photo(2));
    await choose("📷 Take a photo");
    await choose("📷 Take a photo");
    expect(screen.getByText(/p1\.jpg/)).toBeTruthy();
    expect(screen.getByText(/p2\.jpg/)).toBeTruthy();
  });

  it("refuses a PDF with photos, and says to choose one or the other; the second file is not added", async () => {
    await show();
    await choose();
    api.pickFile.mockResolvedValueOnce(photo(1));
    await choose("📷 Take a photo");
    expect(screen.getByText("Choose one PDF or Word file, or several photos of the pages, not a mix.")).toBeTruthy();
    expect(screen.queryByText(/p1\.jpg/)).toBeNull();
  });

  it("refuses an eleventh photo", async () => {
    await show();
    for (let n = 1; n <= 11; n++) {
      api.pickFile.mockResolvedValueOnce(photo(n));
      await choose("📷 Take a photo");
    }
    expect(screen.getByText("Choose at most 10 photos at a time.")).toBeTruthy();
    expect(screen.queryByText(/p11\.jpg/)).toBeNull();
  });

  it("refuses a file Bloom cannot read", async () => {
    await show();
    api.pickFile.mockResolvedValueOnce({ uri: "file:///song.mp3", name: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 1000 });
    await choose();
    expect(screen.getByText("Bloom can read PDF, Word (.docx), JPG and PNG files.")).toBeTruthy();
  });

  it("says why when the phone cannot open the picker", async () => {
    await show();
    api.pickFile.mockRejectedValueOnce(new Error("Allow the camera in your phone's settings to take a photo here."));
    await choose("📷 Take a photo");
    expect(screen.getByText("Allow the camera in your phone's settings to take a photo here.")).toBeTruthy();
  });

  it("does nothing when the person backs out of the picker", async () => {
    await show();
    api.pickFile.mockResolvedValueOnce(null);
    await choose();
    expect(screen.queryByText("Remove")).toBeNull();
  });
});

describe("importing", () => {
  it("uploads the file, then asks Bloom to read it with the form's values, then hands the paper back", async () => {
    await show();
    await choose();
    fireEvent.changeText(screen.getByLabelText("Anything Bloom should know (optional)"), "  Only Section B.  ");
    importIt();
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(api.uploadPaperImportFiles.mock.invocationCallOrder[0]).toBeLessThan(api.importPaperWithAi.mock.invocationCallOrder[0]!);
    expect(api.uploadPaperImportFiles).toHaveBeenCalledWith({ tenantId: "s-1", profileId: "t-1", files: [expect.objectContaining({ name: "paper.pdf" })] });
    expect(api.importPaperWithAi).toHaveBeenCalledWith({
      paths: ["s-1/paper-imports/t-1/a.pdf"], subject: "Chemistry", classLabel: "Form 2 West", curriculum: "844", kind: "exam", notes: "Only Section B.",
    });
    expect(onImported).toHaveBeenCalledWith(DRAFT, false);
    expect(api.removePaperImportFiles).not.toHaveBeenCalled();
  });

  it("suggests CBC for a Grade class, and sends the curriculum the teacher picks instead", async () => {
    await show({ className: "Grade 6 Blue" });
    await choose();
    importIt();
    await waitFor(() => expect(api.importPaperWithAi).toHaveBeenCalledTimes(1));
    expect(api.importPaperWithAi.mock.calls[0]![0]).toMatchObject({ curriculum: "cbc" });
  });

  it("sends the curriculum the teacher picks", async () => {
    await show({ className: "Form 2 West" });
    await choose();
    fireEvent.press(screen.getByText("CBC"));
    importIt();
    await waitFor(() => expect(api.importPaperWithAi).toHaveBeenCalledTimes(1));
    expect(api.importPaperWithAi.mock.calls[0]![0]).toMatchObject({ curriculum: "cbc" });
  });

  it("sends the type of paper, test or exam", async () => {
    await show({ kind: "assessment" });
    await choose();
    importIt();
    await waitFor(() => expect(api.importPaperWithAi).toHaveBeenCalledTimes(1));
    expect(api.importPaperWithAi.mock.calls[0]![0]).toMatchObject({ kind: "assessment" });
  });

  it("offers no replace box when the paper has no questions yet", async () => {
    await show();
    expect(screen.queryByText(/Replace the questions already in this paper/)).toBeNull();
  });

  it("adds to the questions already there unless told to replace them", async () => {
    await show({ hasQuestions: true });
    await choose();
    importIt();
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(DRAFT, false));
  });

  it("replaces them when the box is ticked", async () => {
    await show({ hasQuestions: true });
    await choose();
    fireEvent.press(screen.getByLabelText("Replace the questions already in this paper"));
    expect(screen.getByLabelText("Replace the questions already in this paper").props.accessibilityState).toMatchObject({ checked: true });
    importIt();
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(DRAFT, true));
  });

  it("needs the class and subject picked in the paper first", async () => {
    await show({ subject: "" });
    await choose();
    importIt();
    expect(await screen.findByText("Pick the class and subject in the paper first.")).toBeTruthy();
    expect(api.uploadPaperImportFiles).not.toHaveBeenCalled();
  });

  it("tells the screen when it starts and when it is over, so the screen can ask before being left", async () => {
    await show();
    await choose();
    importIt();
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(onBusy.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("says what it is doing while it works, and cannot be changed or cancelled meanwhile", async () => {
    api.importPaperWithAi.mockReturnValue(new Promise(() => {}));
    await show();
    await choose();
    importIt();
    expect(await screen.findByText(/Reading the paper\. This can take a few minutes\. Keep the app open until it finishes\./)).toBeTruthy();
    expect(screen.getByLabelText("Anything Bloom should know (optional)").props.editable).toBe(false);
    fireEvent.press(screen.getByText("Cancel"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenLastCalledWith(true);
  });

  it("says that it is an AI and that the file is deleted once read", async () => {
    await show();
    expect(screen.getByText(/Bloom is an AI and can get things wrong\. Read and edit before you save or send\. Your file is deleted once Bloom has read it\./)).toBeTruthy();
  });

  it("can be closed", async () => {
    await show();
    fireEvent.press(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("when it goes wrong", () => {
  it("shows Bloom's own reason when it finds no questions, and takes the uploaded file down again", async () => {
    api.importPaperWithAi.mockResolvedValue({ ...DRAFT, questions: [], warnings: ["That looks like a timetable, not a paper."] });
    await show();
    await choose();
    importIt();
    expect(await screen.findByText("That looks like a timetable, not a paper.")).toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
    expect(api.removePaperImportFiles).toHaveBeenCalledWith(["s-1/paper-imports/t-1/a.pdf"]);
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it("has its own words when Bloom finds no questions and gives no reason", async () => {
    api.importPaperWithAi.mockResolvedValue({ ...DRAFT, questions: [], warnings: [] });
    await show();
    await choose();
    importIt();
    expect(await screen.findByText("Bloom didn't find any questions in that file. Check it's the right paper.")).toBeTruthy();
  });

  it("shows the error, and takes the file down, when Bloom cannot be reached", async () => {
    api.importPaperWithAi.mockRejectedValue(new Error("Bloom is busy. Try again in a minute."));
    await show();
    await choose();
    importIt();
    expect(await screen.findByText("Bloom is busy. Try again in a minute.")).toBeTruthy();
    expect(api.removePaperImportFiles).toHaveBeenCalledWith(["s-1/paper-imports/t-1/a.pdf"]);
    expect(onImported).not.toHaveBeenCalled();
    // and the teacher can try again
    expect(screen.getByLabelText("Anything Bloom should know (optional)").props.editable).toBe(true);
  });

  it("does not ask Bloom anything when the upload fails", async () => {
    api.uploadPaperImportFiles.mockRejectedValue(new Error("The upload was refused (413)."));
    await show();
    await choose();
    importIt();
    expect(await screen.findByText("The upload was refused (413).")).toBeTruthy();
    expect(api.importPaperWithAi).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it("checks the size again on what was actually read, since the phone does not always say", async () => {
    api.pickFile.mockResolvedValue({ ...PDF, sizeBytes: null });
    api.readPickedFile.mockResolvedValue({ blob: { size: 25 * 1024 ** 2 }, name: "paper.pdf", mimeType: "application/pdf" });
    await show();
    await choose();
    importIt();
    expect(await screen.findByText(/That's 25 MB\. Bloom can read up to 20 MB at a time/)).toBeTruthy();
    expect(api.uploadPaperImportFiles).not.toHaveBeenCalled();
  });
});
