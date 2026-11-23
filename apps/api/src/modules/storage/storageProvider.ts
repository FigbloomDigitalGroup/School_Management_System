import { createHash, createHmac } from "node:crypto";

export interface PresignedUploadRequest {
  tenantId: string;
  objectKey: string;
  contentType: string;
  maxBytes: number;
  expiresInSeconds?: number;
}

export interface PresignedDownloadRequest {
  tenantId: string;
  objectKey: string;
  expiresInSeconds?: number;
  downloadFilename?: string;
}

export interface PutObjectRequest {
  tenantId: string;
  objectKey: string;
  contentType: string;
  body: Buffer;
}

export interface ObjectKeyRequest {
  tenantId: string;
  objectKey: string;
}

export type StoragePresignResult =
  | { status: "ready"; url: string; expiresInSeconds: number; requiredHeaders?: Record<string, string> }
  | { status: "not_configured"; reason: "storage_provider_not_configured" };

export type StoragePutResult =
  | { status: "ok"; etag: string | null; checksumSha256: string; byteSize: number }
  | { status: "not_configured"; reason: "storage_provider_not_configured" }
  | { status: "error"; code: string };

export type StorageGetResult =
  | { status: "ok"; body: Buffer; contentType: string; byteSize: number; etag: string | null }
  | { status: "not_found" }
  | { status: "not_configured"; reason: "storage_provider_not_configured" }
  | { status: "error"; code: string };

export type StorageHeadResult =
  | { status: "exists"; contentType: string | null; byteSize: number; etag: string | null }
  | { status: "not_found" }
  | { status: "not_configured"; reason: "storage_provider_not_configured" }
  | { status: "error"; code: string };

export type StorageDeleteResult =
  | { status: "deleted" }
  | { status: "not_configured"; reason: "storage_provider_not_configured" }
  | { status: "error"; code: string };

/**
 * Provider-neutral object-storage boundary (S3-compatible).
 * Supports real AWS S3 / MinIO / R2 via SigV4 (`S3StorageProvider`), local mock testing
 * (`InMemoryStorageProvider`), or honest `not_configured` when credentials are absent.
 */
export interface StorageProvider {
  readonly configured: boolean;
  readonly providerName: "s3" | "mock" | "not_configured";
  createPresignedUpload(req: PresignedUploadRequest): Promise<StoragePresignResult>;
  createPresignedDownload(req: PresignedDownloadRequest): Promise<StoragePresignResult>;
  putObject(req: PutObjectRequest): Promise<StoragePutResult>;
  getObject(req: ObjectKeyRequest): Promise<StorageGetResult>;
  headObject(req: ObjectKeyRequest): Promise<StorageHeadResult>;
  deleteObject(req: ObjectKeyRequest): Promise<StorageDeleteResult>;
}

export class NotConfiguredStorageProvider implements StorageProvider {
  readonly configured = false;
  readonly providerName = "not_configured" as const;

  async createPresignedUpload(): Promise<StoragePresignResult> {
    return { status: "not_configured", reason: "storage_provider_not_configured" };
  }
  async createPresignedDownload(): Promise<StoragePresignResult> {
    return { status: "not_configured", reason: "storage_provider_not_configured" };
  }
  async putObject(): Promise<StoragePutResult> {
    return { status: "not_configured", reason: "storage_provider_not_configured" };
  }
  async getObject(): Promise<StorageGetResult> {
    return { status: "not_configured", reason: "storage_provider_not_configured" };
  }
  async headObject(): Promise<StorageHeadResult> {
    return { status: "not_configured", reason: "storage_provider_not_configured" };
  }
  async deleteObject(): Promise<StorageDeleteResult> {
    return { status: "not_configured", reason: "storage_provider_not_configured" };
  }
}

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Custom S3-compatible endpoint (e.g. MinIO, R2, or local mock HTTP server). */
  endpoint?: string;
  forcePathStyle?: boolean;
  presignTtlSeconds?: number;
  timeoutMs?: number;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function encodeS3Path(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function encodeQueryComponent(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

/**
 * Real AWS S3 / S3-compatible storage provider using AWS Signature Version 4 (SigV4).
 * Zero third-party SDK dependencies: uses Node.js `node:crypto` + `fetch`.
 */
export class S3StorageProvider implements StorageProvider {
  readonly configured = true;
  readonly providerName = "s3" as const;

  private readonly defaultTtl: number;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: S3Config) {
    this.defaultTtl = Math.min(Math.max(cfg.presignTtlSeconds ?? 300, 60), 900);
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  private buildObjectUrl(objectKey: string): { origin: string; host: string; canonicalUri: string } {
    const cleanKey = objectKey.replace(/^\/+/, "");
    const encodedKey = encodeS3Path(cleanKey);
    if (this.cfg.endpoint) {
      const u = new URL(this.cfg.endpoint);
      const pathStyle = this.cfg.forcePathStyle ?? true;
      if (pathStyle) {
        const prefix = u.pathname.replace(/\/+$/, "");
        return {
          origin: u.origin,
          host: u.host,
          canonicalUri: `${prefix}/${encodeQueryComponent(this.cfg.bucket)}/${encodedKey}`,
        };
      }
      const host = `${this.cfg.bucket}.${u.host}`;
      return { origin: `${u.protocol}//${host}`, host, canonicalUri: `/${encodedKey}` };
    }
    const host = `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
    return { origin: `https://${host}`, host, canonicalUri: `/${encodedKey}` };
  }

  private signHeaders(
    method: string,
    objectKey: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
    now = new Date(),
  ): { url: string; headers: Record<string, string> } {
    const { origin, host, canonicalUri } = this.buildObjectUrl(objectKey);
    const { amzDate, dateStamp } = amzTimestamps(now);
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    if (this.cfg.sessionToken) headers["x-amz-security-token"] = this.cfg.sessionToken;

    const sortedKeys = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort();
    const lowerMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lowerMap[k.toLowerCase()] = v.trim();

    const canonicalHeaders = sortedKeys.map((k) => `${k}:${lowerMap[k]}\n`).join("");
    const signedHeaders = sortedKeys.join(";");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = deriveSigningKey(this.cfg.secretAccessKey, dateStamp, this.cfg.region);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const outHeaders: Record<string, string> = {};
    for (const k of sortedKeys) {
      if (k !== "host") outHeaders[k] = lowerMap[k]!;
    }
    outHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { url: `${origin}${canonicalUri}`, headers: outHeaders };
  }

  private presign(
    method: "PUT" | "GET",
    objectKey: string,
    expiresInSeconds: number,
    extraQuery: Record<string, string> = {},
    now = new Date(),
    boundHeaders: Record<string, string> = {},
  ): string {
    const ttl = Math.min(Math.max(Math.floor(expiresInSeconds), 60), 900);
    const { origin, host, canonicalUri } = this.buildObjectUrl(objectKey);
    const { amzDate, dateStamp } = amzTimestamps(now);
    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const queryParams: Record<string, string> = {
      ...extraQuery,
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.cfg.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(ttl),
      "X-Amz-SignedHeaders": Object.keys({ host: "", ...Object.fromEntries(Object.keys(boundHeaders).map((k) => [k.toLowerCase(), ""])) })
        .sort()
        .join(";"),
    };
    if (this.cfg.sessionToken) queryParams["X-Amz-Security-Token"] = this.cfg.sessionToken;

    const canonicalQuery = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeQueryComponent(k)}=${encodeQueryComponent(queryParams[k]!)}`)
      .join("&");
    // Headers bound into the signature (content-type and content-length on uploads): the client must send exactly
    // these values, so the declared type and size cannot be changed after the URL is issued.
    const signed: Record<string, string> = {
      host,
      ...Object.fromEntries(Object.entries(boundHeaders).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    };
    const signedNames = Object.keys(signed).sort();
    const canonicalHeaders = signedNames.map((k) => `${k}:${signed[k]}\n`).join("");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedNames.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = deriveSigningKey(this.cfg.secretAccessKey, dateStamp, this.cfg.region);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async createPresignedUpload(req: PresignedUploadRequest): Promise<StoragePresignResult> {
    const ttl = Math.min(Math.max(req.expiresInSeconds ?? this.defaultTtl, 60), 900);
    const bound = { "content-type": req.contentType, "content-length": String(req.maxBytes) };
    return { status: "ready", url: this.presign("PUT", req.objectKey, ttl, {}, new Date(), bound), expiresInSeconds: ttl, requiredHeaders: bound };
  }

  async createPresignedDownload(req: PresignedDownloadRequest): Promise<StoragePresignResult> {
    const ttl = Math.min(Math.max(req.expiresInSeconds ?? this.defaultTtl, 60), 900);
    const extra: Record<string, string> = {};
    if (req.downloadFilename) {
      const safeName = req.downloadFilename.replace(/["\\\r\n]/g, "_");
      extra["response-content-disposition"] = `attachment; filename="${safeName}"`;
    }
    return { status: "ready", url: this.presign("GET", req.objectKey, ttl, extra), expiresInSeconds: ttl };
  }

  async putObject(req: PutObjectRequest): Promise<StoragePutResult> {
    const checksumSha256 = sha256Hex(req.body);
    const { url, headers } = this.signHeaders("PUT", req.objectKey, checksumSha256, {
      "content-type": req.contentType,
      "content-length": String(req.body.byteLength),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(req.body), signal: controller.signal });
      if (!res.ok) return { status: "error", code: `s3_put_${res.status}` };
      return {
        status: "ok",
        etag: res.headers.get("etag"),
        checksumSha256,
        byteSize: req.body.byteLength,
      };
    } catch {
      return { status: "error", code: "s3_network_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  async getObject(req: ObjectKeyRequest): Promise<StorageGetResult> {
    const { url, headers } = this.signHeaders("GET", req.objectKey, sha256Hex(""));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (res.status === 404) return { status: "not_found" };
      if (!res.ok) return { status: "error", code: `s3_get_${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        status: "ok",
        body: buf,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        byteSize: buf.byteLength,
        etag: res.headers.get("etag"),
      };
    } catch {
      return { status: "error", code: "s3_network_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  async headObject(req: ObjectKeyRequest): Promise<StorageHeadResult> {
    const { url, headers } = this.signHeaders("HEAD", req.objectKey, sha256Hex(""));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "HEAD", headers, signal: controller.signal });
      if (res.status === 404) return { status: "not_found" };
      if (!res.ok) return { status: "error", code: `s3_head_${res.status}` };
      return {
        status: "exists",
        contentType: res.headers.get("content-type"),
        byteSize: Number(res.headers.get("content-length") ?? 0),
        etag: res.headers.get("etag"),
      };
    } catch {
      return { status: "error", code: "s3_network_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  async deleteObject(req: ObjectKeyRequest): Promise<StorageDeleteResult> {
    const { url, headers } = this.signHeaders("DELETE", req.objectKey, sha256Hex(""));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "DELETE", headers, signal: controller.signal });
      if (res.ok || res.status === 404) return { status: "deleted" };
      return { status: "error", code: `s3_delete_${res.status}` };
    } catch {
      return { status: "error", code: "s3_network_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic local in-memory storage provider for tests (never calls AWS). */
export class InMemoryStorageProvider implements StorageProvider {
  readonly configured = true;
  readonly providerName = "mock" as const;
  readonly store = new Map<string, { body: Buffer; contentType: string; etag: string; checksumSha256: string }>();
  failNextOp: string | null = null;

  async createPresignedUpload(req: PresignedUploadRequest): Promise<StoragePresignResult> {
    const ttl = Math.min(Math.max(req.expiresInSeconds ?? 300, 60), 900);
    return {
      status: "ready",
      url: `https://mock-s3.local/upload/${encodeS3Path(req.objectKey)}?X-Amz-Expires=${ttl}`,
      expiresInSeconds: ttl,
    };
  }

  async createPresignedDownload(req: PresignedDownloadRequest): Promise<StoragePresignResult> {
    const ttl = Math.min(Math.max(req.expiresInSeconds ?? 300, 60), 900);
    return {
      status: "ready",
      url: `https://mock-s3.local/download/${encodeS3Path(req.objectKey)}?X-Amz-Expires=${ttl}`,
      expiresInSeconds: ttl,
    };
  }

  async putObject(req: PutObjectRequest): Promise<StoragePutResult> {
    if (this.failNextOp === "put") {
      this.failNextOp = null;
      return { status: "error", code: "mock_put_failed" };
    }
    const checksumSha256 = sha256Hex(req.body);
    const etag = `"${checksumSha256.slice(0, 32)}"`;
    this.store.set(req.objectKey, { body: Buffer.from(req.body), contentType: req.contentType, etag, checksumSha256 });
    return { status: "ok", etag, checksumSha256, byteSize: req.body.byteLength };
  }

  async getObject(req: ObjectKeyRequest): Promise<StorageGetResult> {
    const item = this.store.get(req.objectKey);
    if (!item) return { status: "not_found" };
    return { status: "ok", body: Buffer.from(item.body), contentType: item.contentType, byteSize: item.body.byteLength, etag: item.etag };
  }

  async headObject(req: ObjectKeyRequest): Promise<StorageHeadResult> {
    const item = this.store.get(req.objectKey);
    if (!item) return { status: "not_found" };
    return { status: "exists", contentType: item.contentType, byteSize: item.body.byteLength, etag: item.etag };
  }

  async deleteObject(req: ObjectKeyRequest): Promise<StorageDeleteResult> {
    this.store.delete(req.objectKey);
    return { status: "deleted" };
  }
}

export function storageProviderFromEnv(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  const bucket = env.S3_BUCKET?.trim();
  const region = env.S3_REGION?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (bucket && region && accessKeyId && secretAccessKey) {
    return new S3StorageProvider({
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken: env.S3_SESSION_TOKEN?.trim() || undefined,
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true" || Boolean(env.S3_ENDPOINT?.trim()),
      presignTtlSeconds: env.S3_PRESIGN_TTL_SECONDS ? Number(env.S3_PRESIGN_TTL_SECONDS) : 300,
    });
  }
  return new NotConfiguredStorageProvider();
}

let testOverrideStorageProvider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  return testOverrideStorageProvider ?? storageProviderFromEnv();
}

export function setStorageProviderForTesting(
  provider: (Partial<StorageProvider> & Pick<StorageProvider, "configured" | "createPresignedUpload" | "createPresignedDownload">) | null,
): void {
  if (!provider) {
    testOverrideStorageProvider = null;
    return;
  }
  const fallback = new NotConfiguredStorageProvider();
  testOverrideStorageProvider = {
    configured: provider.configured,
    providerName: provider.providerName ?? (provider.configured ? "mock" : "not_configured"),
    createPresignedUpload: provider.createPresignedUpload.bind(provider),
    createPresignedDownload: provider.createPresignedDownload.bind(provider),
    putObject: provider.putObject ? provider.putObject.bind(provider) : fallback.putObject.bind(fallback),
    getObject: provider.getObject ? provider.getObject.bind(provider) : fallback.getObject.bind(fallback),
    headObject: provider.headObject ? provider.headObject.bind(provider) : fallback.headObject.bind(fallback),
    deleteObject: provider.deleteObject ? provider.deleteObject.bind(provider) : fallback.deleteObject.bind(fallback),
  };
}
