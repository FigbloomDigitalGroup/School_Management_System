import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  pageFingerprint,
  pageFromKeysetRows,
  parseLimit,
  parseListQuery,
  validateCursorKey,
} from "../src/http/pagination.js";
import { AppError } from "../src/http/errors.js";
import { parseOrThrow } from "../src/http/validation.js";
import { toClientError } from "../src/http/errors.js";

const TEXT2 = [
  { kind: "text" as const, maxLen: 256 },
  { kind: "text" as const, maxLen: 256 },
];

describe("SQL keyset pagination helpers (FIG-1621)", () => {
  it("defaults limit to 50 and rejects values above 200", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("200")).toBe(200);
    expect(() => parseLimit("201")).toThrow(AppError);
    expect(() => parseLimit("0")).toThrow(AppError);
    expect(() => parseLimit("0x10")).toThrow(AppError);
    expect(() => parseLimit("1e2")).toThrow(AppError);
    expect(() => parseLimit("50.5")).toThrow(AppError);
  });

  it("encodes v2 cursors with string keys and rejects mismatches", () => {
    const sort = "name";
    const fingerprint = pageFingerprint(sort, { status: "active", tenantId: "t1" });
    const cursor = encodeCursor({
      v: CURSOR_VERSION,
      k: ["n1", "id-1"],
      f: fingerprint,
      s: sort,
    });
    const decoded = decodeCursor(cursor, { sort, fingerprint, keySpecs: TEXT2 });
    expect(decoded?.k).toEqual(["n1", "id-1"]);

    expect(() =>
      decodeCursor(cursor, {
        sort,
        fingerprint: pageFingerprint(sort, { status: "revoked", tenantId: "t1" }),
        keySpecs: TEXT2,
      }),
    ).toThrow(/does not match/);

    const wrongVersion = Buffer.from(
      JSON.stringify({ v: 1, k: ["n1", "id-1"], f: fingerprint, s: sort }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(wrongVersion, { sort, fingerprint, keySpecs: TEXT2 })).toThrow(
      /invalid/,
    );

    const nonStringKeys = encodeCursor({
      v: CURSOR_VERSION,
      k: ["n1", "id-1"],
      f: fingerprint,
      s: sort,
    });
    const tampered = Buffer.from(
      JSON.stringify({
        v: CURSOR_VERSION,
        k: ["n1", 42],
        f: fingerprint,
        s: sort,
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(tampered, { sort, fingerprint, keySpecs: TEXT2 })).toThrow(/invalid/);
    expect(() =>
      decodeCursor(nonStringKeys, {
        sort,
        fingerprint,
        keySpecs: [...TEXT2, { kind: "uuid" }],
      }),
    ).toThrow(/invalid/);
    expect(() => decodeCursor("!!!", { sort, fingerprint, keySpecs: TEXT2 })).toThrow(/invalid/);
  });

  it("rejects malformed key content before SQL (uuid, timestamp, NUL, unexpected fields)", () => {
    expect(() => validateCursorKey("not-a-uuid", { kind: "uuid" })).toThrow(AppError);
    expect(() => validateCursorKey("2026-13-45T00:00:00.000000Z", { kind: "timestamptz_micros" })).toThrow(
      AppError,
    );
    expect(() => validateCursorKey("infinity", { kind: "timestamptz_micros" })).toThrow(AppError);
    expect(() => validateCursorKey("a\0b", { kind: "text", maxLen: 256 })).toThrow(AppError);
    expect(() => validateCursorKey("BAD", { kind: "permission_code" })).toThrow(AppError);

    const sort = "org_name_school_name";
    const fingerprint = pageFingerprint(sort, { scopeUserId: "u1" });
    const specs = [
      { kind: "text" as const, maxLen: 256 },
      { kind: "text" as const, maxLen: 256 },
      { kind: "uuid" as const },
    ];
    const badUuid = encodeCursor({
      v: CURSOR_VERSION,
      k: ["Org", "School", "not-a-uuid"],
      f: fingerprint,
      s: sort,
    });
    expect(() => decodeCursor(badUuid, { sort, fingerprint, keySpecs: specs })).toThrow(/invalid/);

    const extraField = Buffer.from(
      JSON.stringify({
        v: CURSOR_VERSION,
        k: ["Org", "School", "11111111-1111-1111-1111-111111111111"],
        f: fingerprint,
        s: sort,
        x: "extra",
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(extraField, { sort, fingerprint, keySpecs: specs })).toThrow(/invalid/);
  });

  it("builds next_cursor from LIMIT n+1 SQL windows only", () => {
    const sort = "id";
    const fingerprint = pageFingerprint(sort, {});
    const rows = [
      { id: "a", k: "a" },
      { id: "b", k: "b" },
      { id: "c", k: "c" },
    ];
    const page = pageFromKeysetRows(rows, {
      limit: 2,
      sort,
      fingerprint,
      keysOf: (r) => [r.k, r.id],
    });
    expect(page.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(page.page.next_cursor).toBeTruthy();
    const next = decodeCursor(page.page.next_cursor, { sort, fingerprint, keySpecs: TEXT2 });
    expect(next?.k).toEqual(["b", "b"]);

    const exact = pageFromKeysetRows(rows.slice(0, 2), {
      limit: 2,
      sort,
      fingerprint,
      keysOf: (r) => [r.k, r.id],
    });
    expect(exact.page.next_cursor).toBeNull();
  });

  it("rejects unsupported sort via parseListQuery", () => {
    expect(() =>
      parseListQuery(
        { sort: "other" },
        { sort: "code", filter: {}, keySpecs: [{ kind: "permission_code" }] },
      ),
    ).toThrow(/sort is not allowed/);
  });

  it("maps SQLSTATE class 22 to HTTP 400 validation_error", () => {
    for (const code of ["22P02", "22007", "22008", "22021"]) {
      const mapped = toClientError({ code, message: "invalid input syntax for type uuid" });
      expect(mapped.statusCode).toBe(400);
      expect(mapped.body.error.code).toBe("validation_error");
      expect(JSON.stringify(mapped)).not.toMatch(/uuid|syntax|22P02/i);
    }
  });

  it("maps SQLSTATE 23514 check_violation to HTTP 400 without leaking constraint text", () => {
    const mapped = toClientError({
      code: "23514",
      message: 'new row for relation "school_profiles" violates check constraint "school_profiles_accent_len"',
    });
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body).toEqual({
      error: { code: "validation_error", message: "Invalid request" },
    });
    expect(JSON.stringify(mapped)).not.toMatch(/school_profiles|accent_len|23514|constraint/i);
  });
});

describe("validation details (FIG-1621 E3a)", () => {
  it("includes field details and never echoes submitted values", () => {
    const schema = z.object({
      secret: z.string().email(),
      areas: z.array(z.string()).min(1),
    });
    try {
      parseOrThrow(schema, { secret: "not-an-email-VALUE", areas: [] }, "Invalid request");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe("validation_error");
      expect(e.details?.length).toBeGreaterThan(0);
      const blob = JSON.stringify(e.details);
      expect(blob).not.toContain("not-an-email-VALUE");
      expect(e.details!.some((d) => d.field === "secret" || d.field === "areas")).toBe(true);
    }
  });
});
