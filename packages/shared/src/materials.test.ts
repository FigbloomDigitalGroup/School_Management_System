import { describe, expect, it } from "vitest";
import {
  attachmentFilePath, defaultLinkTitle, draftTitle, fileProblem, formatFileSize, groupBySubject, isHttpsUrl, kindForLink,
  kindForMime, materialFilePath, MAX_FILE_BYTES, mediaSummary, mimeForFile, newMaterialId, parseEmbed, safeFileName, validateLink,
  validateMaterial, type MediaItem,
} from "./materials";

describe("mimeForFile", () => {
  it("keeps the browser's type when the bucket takes it", () => {
    expect(mimeForFile({ name: "notes.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(mimeForFile({ name: "clip", type: "video/webm" })).toBe("video/webm");
  });
  it("falls back to the extension when the browser reports nothing useful", () => {
    expect(mimeForFile({ name: "Lesson 3.MKV", type: "" })).toBe("video/x-matroska");
    expect(mimeForFile({ name: "essay.docx", type: "application/octet-stream" })).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mimeForFile({ name: "voice.m4a" })).toBe("audio/mp4");
  });
  it("is null for files the bucket won't take", () => {
    expect(mimeForFile({ name: "setup.exe", type: "application/x-msdownload" })).toBeNull();
    expect(mimeForFile({ name: "page.html", type: "text/html" })).toBeNull();
    expect(mimeForFile({ name: "noextension", type: "" })).toBeNull();
  });
});

describe("kindForMime", () => {
  it("sorts by the top-level type", () => {
    expect(kindForMime("video/mp4")).toBe("video");
    expect(kindForMime("audio/mpeg")).toBe("audio");
    expect(kindForMime("image/png")).toBe("image");
    expect(kindForMime("application/pdf")).toBe("document");
    expect(kindForMime("VIDEO/QUICKTIME")).toBe("video");
  });
});

describe("fileProblem", () => {
  it("accepts a normal file", () => {
    expect(fileProblem({ name: "a.mp4", size: 500 * 1024 ** 2, type: "video/mp4" })).toBeNull();
  });
  it("refuses empty, too big, and unknown files", () => {
    expect(fileProblem({ name: "a.pdf", size: 0, type: "application/pdf" })).toMatch(/empty/);
    expect(fileProblem({ name: "a.mp4", size: MAX_FILE_BYTES + 1, type: "video/mp4" })).toMatch(/up to 2\.0 GB/);
    expect(fileProblem({ name: "a.exe", size: 10, type: "" })).toMatch(/isn't a type/);
  });
});

describe("formatFileSize", () => {
  it("reads naturally at every size", () => {
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(820 * 1024)).toBe("820 KB");
    expect(formatFileSize(4.2 * 1024 ** 2)).toBe("4.2 MB");
    expect(formatFileSize(1.25 * 1024 ** 3)).toBe("1.3 GB");
    expect(formatFileSize(150 * 1024 ** 2)).toBe("150 MB");
  });
  it("is empty for nothing", () => {
    expect(formatFileSize(null)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});

describe("paths", () => {
  it("puts each file under its owner's folder, with a safe name", () => {
    expect(materialFilePath("t1", "m1", "Cells / part 1?.mp4")).toMatch(/^t1\/materials\/m1\/\d+-Cells _ part 1_\.mp4$/);
    expect(attachmentFilePath("t1", "homework", "a1", "sheet.pdf")).toMatch(/^t1\/homework\/a1\/\d+-sheet\.pdf$/);
    expect(attachmentFilePath("t1", "announcement", "n1", "form.pdf")).toMatch(/^t1\/announcements\/n1\//);
  });
  it("never leaves a name empty or with slashes", () => {
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("../../etc/passwd")).not.toContain("/");
  });
});

describe("validateLink", () => {
  it("fills in https and upgrades http", () => {
    expect(validateLink(" www.youtube.com/watch?v=dQw4w9WgXcQ ")).toEqual({ ok: true, value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(validateLink("http://example.org/notes")).toEqual({ ok: true, value: "https://example.org/notes" });
  });
  it("refuses things that aren't web links", () => {
    expect(validateLink("").ok).toBe(false);
    expect(validateLink("javascript:alert(1)").ok).toBe(false);
    expect(validateLink("ftp://files.example.org/a").ok).toBe(false);
    expect(validateLink("not a link").ok).toBe(false);
    expect(validateLink(`https://example.org/${"a".repeat(2000)}`).ok).toBe(false);
  });
  it("agrees with the database check", () => {
    expect(isHttpsUrl("https://example.org")).toBe(true);
    expect(isHttpsUrl("http://example.org")).toBe(false);
    expect(isHttpsUrl("https://localhost")).toBe(false);
  });
});

describe("parseEmbed", () => {
  const yt = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0";
  it("reads every common YouTube link", () => {
    expect(parseEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.embedUrl).toBe(yt);
    expect(parseEmbed("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")?.embedUrl).toBe(yt);
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?si=abc")?.embedUrl).toBe(yt);
    expect(parseEmbed("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.embedUrl).toBe(yt);
    expect(parseEmbed("https://www.youtube.com/embed/dQw4w9WgXcQ")?.embedUrl).toBe(yt);
    expect(parseEmbed("https://www.youtube.com/live/dQw4w9WgXcQ")?.embedUrl).toBe(yt);
  });
  it("keeps a YouTube start time", () => {
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=90")?.embedUrl).toBe(`${yt}&start=90`);
    expect(parseEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")?.embedUrl).toBe(`${yt}&start=90`);
  });
  it("reads Vimeo, including unlisted links", () => {
    expect(parseEmbed("https://vimeo.com/76979871")).toEqual({ provider: "vimeo", embedUrl: "https://player.vimeo.com/video/76979871", isVideo: true });
    expect(parseEmbed("https://vimeo.com/76979871/8272103f6e")?.embedUrl).toBe("https://player.vimeo.com/video/76979871?h=8272103f6e");
    expect(parseEmbed("https://player.vimeo.com/video/76979871?h=abc123")?.embedUrl).toBe("https://player.vimeo.com/video/76979871?h=abc123");
    expect(parseEmbed("https://vimeo.com/channels/staffpicks/76979871")?.embedUrl).toBe("https://player.vimeo.com/video/76979871");
  });
  it("turns Google Drive and Docs links into their preview", () => {
    expect(parseEmbed("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing")).toEqual({
      provider: "drive", embedUrl: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview", isVideo: false,
    });
    expect(parseEmbed("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp")?.embedUrl).toBe("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview");
    expect(parseEmbed("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit#slide=id.p")?.embedUrl).toBe(
      "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/preview",
    );
  });
  it("is null for anything else, including look-alike hosts", () => {
    expect(parseEmbed("https://example.org/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseEmbed("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseEmbed("https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseEmbed("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseEmbed("https://www.youtube.com/@channel")).toBeNull();
    expect(parseEmbed("https://vimeo.com/about")).toBeNull();
    expect(parseEmbed("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp")).toBeNull();
    expect(parseEmbed("javascript:alert(1)")).toBeNull();
    expect(parseEmbed("not a url")).toBeNull();
  });
});

describe("link kinds and titles", () => {
  it("calls YouTube and Vimeo videos, everything else a link", () => {
    expect(kindForLink("https://youtu.be/dQw4w9WgXcQ")).toBe("video");
    expect(kindForLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view")).toBe("link");
    expect(kindForLink("https://www.bbc.co.uk/bitesize")).toBe("link");
  });
  it("names a link after its site", () => {
    expect(defaultLinkTitle("https://youtu.be/dQw4w9WgXcQ")).toBe("YouTube video");
    expect(defaultLinkTitle("https://www.bbc.co.uk/bitesize")).toBe("bbc.co.uk");
  });
  it("uses what was typed, else the file name or site", () => {
    expect(draftTitle({ type: "file", file: { name: "Cell diagram.png", size: 1 }, title: "  " })).toBe("Cell diagram");
    expect(draftTitle({ type: "link", url: "https://youtu.be/dQw4w9WgXcQ", title: "" })).toBe("YouTube video");
    expect(draftTitle({ type: "link", url: "https://youtu.be/dQw4w9WgXcQ", title: " Cells  intro " })).toBe("Cells intro");
  });
});

describe("mediaSummary", () => {
  const base: MediaItem = { id: "1", kind: "video", title: "x", filePath: null, fileName: null, mimeType: null, sizeBytes: null, url: null };
  it("describes a file by kind and size", () => {
    expect(mediaSummary({ ...base, filePath: "p", sizeBytes: 120 * 1024 ** 2 })).toBe("Video · 120 MB");
  });
  it("describes a link by where it goes", () => {
    expect(mediaSummary({ ...base, url: "https://youtu.be/dQw4w9WgXcQ" })).toBe("YouTube video");
    expect(mediaSummary({ ...base, kind: "link", url: "https://www.bbc.co.uk/bitesize" })).toBe("Link · bbc.co.uk");
  });
});

describe("validateMaterial", () => {
  const ok = { classId: "c", subjectId: "s", title: "  Photosynthesis   notes ", description: " " };
  it("tidies the title and description", () => {
    expect(validateMaterial(ok)).toEqual({ ok: true, value: { ...ok, title: "Photosynthesis notes", description: "" } });
  });
  it("needs a class, subject and title", () => {
    expect(validateMaterial({ ...ok, classId: "" })).toEqual({ ok: false, message: "Pick the class." });
    expect(validateMaterial({ ...ok, subjectId: "" })).toEqual({ ok: false, message: "Pick the subject." });
    expect(validateMaterial({ ...ok, title: " " }).ok).toBe(false);
    expect(validateMaterial({ ...ok, title: "x".repeat(161) }).ok).toBe(false);
  });
});

describe("groupBySubject", () => {
  it("sorts subjects A to Z and keeps each subject's order", () => {
    const g = groupBySubject([
      { id: "1", subjectName: "Physics" },
      { id: "2", subjectName: "Biology" },
      { id: "3", subjectName: "Physics" },
    ]);
    expect(g.map((x) => x.subject)).toEqual(["Biology", "Physics"]);
    expect(g[1]!.items.map((x) => x.id)).toEqual(["1", "3"]);
  });
});

describe("fileProblem with the project's upload limit", () => {
  it("refuses a file over a lower project limit and points to a link instead", () => {
    const fifty = 50 * 1024 ** 2;
    expect(fileProblem({ name: "talk.mp4", size: 120 * 1024 ** 2, type: "video/mp4" }, fifty)).toMatch(/up to 50 MB.*YouTube/);
    expect(fileProblem({ name: "notes.pdf", size: 3 * 1024 ** 2, type: "application/pdf" }, fifty)).toBeNull();
  });

  it("never allows more than the bucket does", () => {
    expect(fileProblem({ name: "a.mp4", size: MAX_FILE_BYTES + 1, type: "video/mp4" }, 10 * MAX_FILE_BYTES)).toMatch(/up to 2\.0 GB/);
  });
});

describe("newMaterialId", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is a version-4 uuid, which the database's uuid column takes", () => {
    for (let i = 0; i < 200; i++) expect(newMaterialId()).toMatch(UUID_V4);
  });

  it("marks the version nibble 4 and the variant nibble 8 to b whatever the random source says", () => {
    expect(newMaterialId(() => 0)).toBe("00000000-0000-4000-8000-000000000000");
    expect(newMaterialId(() => 0.999999)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 2000 }, () => newMaterialId())).size).toBe(2000);
  });

  it("builds the file path the database checks: under the tenant and the material's own folder", () => {
    const id = newMaterialId(() => 0);
    const path = materialFilePath("t1", id, "Notes.pdf");
    expect(path.startsWith(`t1/materials/${id}/`)).toBe(true);
    expect(path.endsWith("-Notes.pdf")).toBe(true);
  });
});
