import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client: a session token, the API key, and a files_service row (or an error) for the lookup.
const db: { row: unknown; error: { code?: string; message: string } | null; reads: number } = { row: null, error: null, reads: 0 };
vi.mock("./supabase", () => ({
  supabaseApiKey: () => "anon-key",
  supabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    from: () => ({ select: () => ({ maybeSingle: async () => { db.reads++; return { data: db.row, error: db.error }; } }) }),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://supa/storage/v1/object/public/public-assets/${p}` } }) }) },
  }),
}));

import { deleteFiles, fileLink, filesOnS3, initFiles, MULTIPART_THRESHOLD_BYTES, publicFileUrl, storeFile } from "./files";

const API = "https://files.example";
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let answers: ((c: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined)[];

beforeEach(() => {
  calls = [];
  answers = [];
  initFiles({ apiUrl: `${API}/`, publicBaseUrl: "https://cdn.example/" });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const c: Call = {
      url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(c);
    const a = answers.map((f) => f(c)).find(Boolean) ?? { status: 200, body: {} };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: a.headers });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const apiRoute = (c: Call) => (c.url.startsWith(API) ? c.url.slice(`${API}/files/`.length) : null);

describe("uploading to S3", () => {
  it("asks the files API to sign a new file, then PUTs exactly the signed headers to S3", async () => {
    answers.push((c) => (apiRoute(c) === "sign" ? { status: 200, body: { url: "https://s3/put", method: "PUT", headers: { "content-type": "image/png", "x-amz-meta-owner": "u", "if-none-match": "*" } } } : undefined));
    await storeFile("public-assets", "t/logo.png", new Blob(["png"]), "image/png");
    expect(calls[0]).toMatchObject({ url: `${API}/files/sign`, method: "POST", headers: { authorization: "Bearer tok", apikey: "anon-key" },
      body: { bucket: "public-assets", path: "t/logo.png", op: "write", contentType: "image/png", size: 3 } });
    expect(calls[1]).toMatchObject({ url: "https://s3/put", method: "PUT", headers: { "content-type": "image/png", "x-amz-meta-owner": "u", "if-none-match": "*" } });
  });

  it("replaces when upserting onto an existing file, and only then", async () => {
    answers.push((c) => ((c.body as { op?: string })?.op === "write" ? { status: 409, body: { error: "exists" } } : undefined));
    answers.push((c) => (apiRoute(c) === "sign" ? { status: 200, body: { url: "https://s3/put", headers: {} } } : undefined));
    await storeFile("public-assets", "t/a.png", new Blob(["x"]), "image/png", { upsert: true });
    expect(calls.map((c) => (c.body as { op?: string })?.op).filter(Boolean)).toEqual(["write", "replace"]);
    calls = [];
    await expect(storeFile("public-assets", "t/a.png", new Blob(["x"]), "image/png")).rejects.toThrow("already there");
  });

  it("explains refusals in plain words", async () => {
    for (const [status, words] of [[403, "permission"], [413, "bigger"], [415, "type of file"], [401, "signed out"]] as const) {
      answers = [() => ({ status, body: { error: "x" } })];
      await expect(storeFile("chat-files", "t/c/a.pdf", new Blob(["x"]), "application/pdf")).rejects.toThrow(words);
    }
  });

  it("sends a big file in parts, reports progress, and completes with every part's ETag", async () => {
    const size = MULTIPART_THRESHOLD_BYTES + 5;
    answers.push((c) => (apiRoute(c) === "multipart/start" ? { status: 200, body: { uploadId: "up", partSize: MULTIPART_THRESHOLD_BYTES, partCount: 2 } } : undefined));
    answers.push((c) => (apiRoute(c) === "multipart/parts" ? { status: 200, body: { parts: [{ partNumber: 1, url: "https://s3/p1" }, { partNumber: 2, url: "https://s3/p2" }] } } : undefined));
    answers.push((c) => (c.url.startsWith("https://s3/p") ? { status: 200, headers: { etag: `"e${c.url.slice(-1)}"` } } : undefined));
    const progress: number[] = [];
    await storeFile("learning-media", "t/materials/m/v.mp4", new Blob([new Uint8Array(size)]), "video/mp4", { onProgress: (f) => progress.push(f) });
    const parts = calls.filter((c) => c.url.startsWith("https://s3/p"));
    expect(parts.map((c) => (c.body as Blob).size)).toEqual([MULTIPART_THRESHOLD_BYTES, 5]);
    expect(calls.at(-1)).toMatchObject({ url: `${API}/files/multipart/complete`, body: { uploadId: "up", parts: [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }] } });
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
  });

  it("abandons the upload on S3 when a part keeps failing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      answers.push((c) => (apiRoute(c) === "multipart/start" ? { status: 200, body: { uploadId: "up", partSize: MULTIPART_THRESHOLD_BYTES, partCount: 2 } } : undefined));
      answers.push((c) => (apiRoute(c) === "multipart/parts" ? { status: 200, body: { parts: [{ partNumber: 1, url: "https://s3/p1" }] } } : undefined));
      answers.push((c) => (c.url.startsWith("https://s3/p") ? { status: 403 } : undefined));
      const done = storeFile("learning-media", "t/m/v.mp4", new Blob([new Uint8Array(MULTIPART_THRESHOLD_BYTES + 1)]), "video/mp4");
      await expect(done).rejects.toThrow("refused (403)");
      expect(calls.some((c) => apiRoute(c) === "multipart/abort")).toBe(true);
      expect(calls.some((c) => apiRoute(c) === "multipart/complete")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reading and deleting on S3", () => {
  it("asks for a read link, as long as the caller needs (at most an hour), named for download", async () => {
    answers.push(() => ({ status: 200, body: { url: "https://s3/get" } }));
    expect(await fileLink("learning-media", "t/m/v.mp4", 7200, "Lesson.mp4")).toBe("https://s3/get");
    expect(calls[0]!.body).toEqual({ bucket: "learning-media", path: "t/m/v.mp4", op: "read", expiresIn: 3600, downloadName: "Lesson.mp4" });
    calls = [];
    await fileLink("chat-files", "t/c/My file.pdf", 600, true);
    expect(calls[0]!.body).toMatchObject({ expiresIn: 600, downloadName: "My file.pdf" });
  });

  it("serves public assets from the CDN, path segments encoded, without asking the API", async () => {
    expect(publicFileUrl("t/avatars/staff a.png")).toBe("https://cdn.example/t/avatars/staff%20a.png");
    expect(await fileLink("public-assets", "t/logo.png")).toBe("https://cdn.example/t/logo.png");
    expect(calls).toHaveLength(0);
  });

  it("deletes in batches of a hundred, skipping empty paths", async () => {
    await deleteFiles("chat-files", [...Array.from({ length: 150 }, (_, i) => `t/c/${i}`), null, ""]);
    expect(calls.map((c) => (c.body as { paths: string[] }).paths.length)).toEqual([100, 50]);
    calls = [];
    await deleteFiles("chat-files", [null, undefined]);
    expect(calls).toHaveLength(0);
  });
});

describe("where files are kept: the files_service row", () => {
  // each test imports a fresh copy of the module, so the lookup really happens
  beforeEach(() => { initFiles(null); db.row = null; db.error = null; db.reads = 0; });

  it("no row: Supabase Storage, as before", async () => {
    vi.resetModules();
    const m = await import("./files");
    await m.loadFilesService();
    expect(m.filesOnS3()).toBe(false);
    expect(m.publicFileUrl("t/logo.png")).toBe("https://supa/storage/v1/object/public/public-assets/t/logo.png");
  });

  it("a row: the files API and the CDN, looked up once", async () => {
    db.row = { api_url: API, public_base_url: "https://cdn.example" };
    vi.resetModules();
    const m = await import("./files");
    await Promise.all([m.loadFilesService(), m.loadFilesService()]);
    expect(m.filesOnS3()).toBe(true);
    expect(db.reads).toBe(1);
    expect(m.publicFileUrl("t/logo.png")).toBe("https://cdn.example/t/logo.png");
  });

  it("no table yet (app deployed before its migration): Supabase Storage", async () => {
    db.error = { code: "PGRST205", message: "Could not find the table 'public.files_service'" };
    vi.resetModules();
    const m = await import("./files");
    await m.loadFilesService();
    expect(m.filesOnS3()).toBe(false);
  });

  it("a failed lookup fails the file operation rather than guess, and is tried again next time", async () => {
    db.error = { message: "network down" };
    vi.resetModules();
    const m = await import("./files");
    await expect(m.fileLink("chat-files", "t/c/a.pdf")).rejects.toThrow("Could not find out where files are kept");
    db.error = null;
    db.row = { api_url: API, public_base_url: "https://cdn.example" };
    await m.loadFilesService();
    expect(m.filesOnS3()).toBe(true);
    expect(db.reads).toBe(2);
  });

  it("initFiles(null) marks it known without a lookup", () => {
    initFiles(null);
    expect(filesOnS3()).toBe(false);
    expect(db.reads).toBe(0);
  });
});
