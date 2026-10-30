import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The storage client the helper talks to: a fake with the two calls it uses.
const upload = vi.fn();
const createSignedUploadUrl = vi.fn();
const from = vi.fn(() => ({ upload, createSignedUploadUrl }));
vi.mock("./supabase", () => ({ supabase: () => ({ storage: { from } }) }));

import { uploadFile } from "./storageUpload";

const SIGNED = "http://127.0.0.1:54321/storage/v1/object/upload/sign/chat-files/t1/a.pdf?token=abc";
const file = (over: Partial<{ name: string; mimeType: string; bytes: string }> = {}) => {
  const bytes = over.bytes ?? "%PDF-1.4 hello";
  return { blob: new Blob([bytes], { type: "" }), name: over.name ?? "a.pdf", mimeType: over.mimeType ?? "application/pdf" };
};

/** The request the helper sent to the signed URL. */
const sent = () => {
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
  return { url: call[0] as string, init: call[1] as { method: string; headers: Record<string, string>; body: Blob } };
};

beforeEach(() => {
  upload.mockReset().mockResolvedValue({ data: {}, error: null });
  createSignedUploadUrl.mockReset().mockResolvedValue({ data: { signedUrl: SIGNED, token: "abc", path: "t1/a.pdf" }, error: null });
  from.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("uploadFile in a browser or Node: the storage client's own upload, as before", () => {
  beforeEach(() => { vi.stubGlobal("navigator", { product: "Gecko" }); vi.stubGlobal("fetch", vi.fn()); });

  it("uploads the blob to the bucket and path with its type, not upserting by default", async () => {
    const f = file();
    await uploadFile("chat-files", "t1/a.pdf", f);
    expect(from).toHaveBeenCalledWith("chat-files");
    expect(upload).toHaveBeenCalledWith("t1/a.pdf", f.blob, { contentType: "application/pdf", upsert: false });
  });

  it("passes upsert through", async () => {
    await uploadFile("public-assets", "t1/avatars/x.png", file({ name: "x.png", mimeType: "image/png" }), { upsert: true });
    expect(upload).toHaveBeenCalledWith("t1/avatars/x.png", expect.anything(), { contentType: "image/png", upsert: true });
  });

  it("raises the storage client's own message", async () => {
    upload.mockResolvedValue({ data: null, error: { message: "The resource already exists" } });
    await expect(uploadFile("chat-files", "t1/a.pdf", file())).rejects.toThrow("The resource already exists");
  });

  it("never asks for a signed URL or makes a request of its own", async () => {
    await uploadFile("chat-files", "t1/a.pdf", file());
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("uploadFile in React Native: a signed URL and a Blob body, never a FormData", () => {
  beforeEach(() => { vi.stubGlobal("navigator", { product: "ReactNative" }); });

  it("asks for a signed upload URL for the path, not upserting by default", async () => {
    await uploadFile("chat-files", "t1/a.pdf", file());
    expect(from).toHaveBeenCalledWith("chat-files");
    expect(createSignedUploadUrl).toHaveBeenCalledWith("t1/a.pdf", { upsert: false });
    expect(upload).not.toHaveBeenCalled();
  });

  it("PUTs to that URL with the type, cache and upsert headers", async () => {
    await uploadFile("chat-files", "t1/a.pdf", file());
    const { url, init } = sent();
    expect(url).toBe(SIGNED);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "content-type": "application/pdf", "cache-control": "max-age=3600", "x-upsert": "false" });
  });

  it("sends the file itself as the body: the same bytes, labelled with the type the app checked", async () => {
    const f = file({ bytes: "a,b\n1,2\n", name: "marks.csv", mimeType: "text/csv" });
    // Android labels the blob after the file's name; the body must carry ours.
    const labelled = new Blob(["a,b\n1,2\n"], { type: "text/comma-separated-values" });
    await uploadFile("learning-media", "t1/marks.csv", { ...f, blob: labelled });
    const body = sent().init.body;
    expect(body).toBeInstanceOf(Blob);
    expect(body).not.toBeInstanceOf(FormData);
    expect(body.type).toBe("text/csv");
    expect(await body.text()).toBe("a,b\n1,2\n");
  });

  it("passes upsert to both the signed URL and the request", async () => {
    await uploadFile("public-assets", "t1/avatars/x.png", file({ name: "x.png", mimeType: "image/png" }), { upsert: true });
    expect(createSignedUploadUrl).toHaveBeenCalledWith("t1/avatars/x.png", { upsert: true });
    expect(sent().init.headers["x-upsert"]).toBe("true");
  });

  it("stops with the storage client's message, sending nothing, when no URL can be had", async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: "new row violates row-level security policy" } });
    await expect(uploadFile("chat-files", "t1/a.pdf", file())).rejects.toThrow("new row violates row-level security policy");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("says so, rather than carrying on, if the URL comes back empty", async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: null });
    await expect(uploadFile("chat-files", "t1/a.pdf", file())).rejects.toThrow("Could not start the upload.");
  });

  it("raises the server's message when it refuses the file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: "mime type video/x-flv is not supported" }) }));
    await expect(uploadFile("learning-media", "t1/a.flv", file({ name: "a.flv", mimeType: "video/x-flv" }))).rejects.toThrow("mime type video/x-flv is not supported");
  });

  it("falls back to the error field, then to the status, when the refusal has no message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413, json: async () => ({ error: "Payload too large" }) }));
    await expect(uploadFile("chat-files", "t1/a.pdf", file())).rejects.toThrow("Payload too large");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("not json"); } }));
    await expect(uploadFile("chat-files", "t1/a.pdf", file())).rejects.toThrow("The upload was refused (502).");
  });

  it("lets a dropped connection through as the error it is", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network request failed")));
    await expect(uploadFile("chat-files", "t1/a.pdf", file())).rejects.toThrow("Network request failed");
  });
});
