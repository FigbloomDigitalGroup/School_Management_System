import * as shared from "@figbloom/shared";
import * as pick from "./pickFile";
import { removePaperImportFiles, uploadExamPaperFile, uploadPaperImportFiles } from "./uploads";

// Where a teacher's paper and the pages Bloom is to read go, and what happens to the ones that went up when a later one fails.

jest.mock("./pickFile", () => ({ readPickedFile: jest.fn() }));
// Files go through shared's files module (Supabase Storage or S3, whichever the school is on), never to a bucket directly.
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  uploadFile: jest.fn(),
  deleteFiles: jest.fn(),
}));

const uploadFile = shared.uploadFile as unknown as jest.Mock;
const deleteFiles = shared.deleteFiles as unknown as jest.Mock;
const readPickedFile = pick.readPickedFile as unknown as jest.Mock;
const page = (name: string) => ({ blob: { size: 1000 } as Blob, name, mimeType: "image/jpeg" });

beforeEach(() => {
  uploadFile.mockReset().mockResolvedValue(undefined);
  deleteFiles.mockReset().mockResolvedValue(undefined);
});

describe("the pages of a paper going up for Bloom to read", () => {
  it("puts each in the teacher's own folder of private-documents, in order, and gives back the paths", async () => {
    const paths = await uploadPaperImportFiles({ tenantId: "s-1", profileId: "t-1", files: [page("p1.jpg"), page("p2.jpg")] });
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(p).toMatch(/^s-1\/paper-imports\/t-1\/[\w-]+\.jpg$/);
    expect(new Set(paths).size).toBe(2);
    expect(uploadFile.mock.calls.map((c) => [c[0], c[1]])).toEqual([["private-documents", paths[0]], ["private-documents", paths[1]]]);
    expect(deleteFiles).not.toHaveBeenCalled();
  });

  it("takes the pages that did go up down again when a later one fails, and passes the failure on", async () => {
    uploadFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("The upload was refused (413)."));
    await expect(uploadPaperImportFiles({ tenantId: "s-1", profileId: "t-1", files: [page("p1.jpg"), page("p2.jpg")] })).rejects.toThrow("The upload was refused (413).");
    expect(deleteFiles).toHaveBeenCalledTimes(1);
    expect(deleteFiles).toHaveBeenCalledWith("private-documents", [uploadFile.mock.calls[0]![1]]);
  });

  it("still reports the upload's failure when taking the others down fails too", async () => {
    uploadFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("The upload was refused (413)."));
    deleteFiles.mockRejectedValue(new Error("offline"));
    await expect(uploadPaperImportFiles({ tenantId: "s-1", profileId: "t-1", files: [page("p1.jpg"), page("p2.jpg")] })).rejects.toThrow("The upload was refused (413).");
  });

  it("has nothing to take down when the first one fails", async () => {
    uploadFile.mockRejectedValueOnce(new Error("no"));
    await expect(uploadPaperImportFiles({ tenantId: "s-1", profileId: "t-1", files: [page("p1.jpg")] })).rejects.toThrow("no");
    expect(deleteFiles).not.toHaveBeenCalled();
  });

  it("removes the given paths from private-documents, and does nothing for none", async () => {
    await removePaperImportFiles([]);
    expect(deleteFiles).not.toHaveBeenCalled();
    await removePaperImportFiles(["a", "b"]);
    expect(deleteFiles).toHaveBeenCalledWith("private-documents", ["a", "b"]);
  });
});

describe("an exam paper's own file", () => {
  it("goes to private-documents under the paper, and gives back the path and the name to save", async () => {
    const picked = { uri: "file:///paper.pdf", name: "Mid term.pdf", mimeType: "application/pdf", sizeBytes: 1000 };
    const file = { blob: { size: 1000 }, name: "Mid term.pdf", mimeType: "application/pdf" };
    readPickedFile.mockResolvedValue(file);
    const result = await uploadExamPaperFile("s-1", "paper-1", picked);
    expect(result.name).toBe("Mid term.pdf");
    expect(result.path).toMatch(/^s-1\/exam-papers\/paper-1\/\d+-Mid term\.pdf$/);
    expect(uploadFile).toHaveBeenCalledWith("private-documents", result.path, file);
  });
});
