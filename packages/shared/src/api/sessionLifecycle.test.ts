import { describe, expect, it } from "vitest";
import {
  buildSignInRedirect,
  IDLE_TIMEOUT_MS,
  msUntilExpiry,
  safeReturnPath,
  SESSION_WARN_BEFORE_MS,
  sessionExpiryWarningMinutes,
  signOutReasonNotice,
} from "./sessionLifecycle";
import { encodeQrMatrix, formatInfoBits, versionInfoBits } from "./qrCode";

describe("sessionLifecycle", () => {
  it("computes remaining ms and 10-minute warning window", () => {
    const now = Date.parse("2026-11-24T10:00:00Z");
    const in20Min = new Date(now + 20 * 60_000).toISOString();
    const in9Min10s = new Date(now + 9 * 60_000 + 10_000).toISOString();
    const in30s = new Date(now + 30_000).toISOString();
    const past = new Date(now - 5_000).toISOString();

    expect(IDLE_TIMEOUT_MS).toBe(15 * 60_000);
    expect(SESSION_WARN_BEFORE_MS).toBe(10 * 60_000);
    expect(msUntilExpiry(in20Min, now)).toBe(20 * 60_000);
    expect(msUntilExpiry(past, now)).toBe(0);
    expect(msUntilExpiry("not-a-date", now)).toBeNull();

    expect(sessionExpiryWarningMinutes(in20Min, now)).toBeNull();
    expect(sessionExpiryWarningMinutes(in9Min10s, now)).toBe(10);
    expect(sessionExpiryWarningMinutes(in30s, now)).toBe(1);
    expect(sessionExpiryWarningMinutes(past, now)).toBeNull();
  });

  it("validates safe return paths and blocks open redirects", () => {
    expect(safeReturnPath("/s/alliance/admin/fees?tab=proofs")).toBe("/s/alliance/admin/fees?tab=proofs");
    expect(safeReturnPath("/s/alliance/admin/fees", "/s/alliance")).toBe("/s/alliance/admin/fees");
    expect(safeReturnPath("/s/other/admin/fees", "/s/alliance")).toBeNull();
    expect(safeReturnPath("https://evil.example/s/alliance")).toBeNull();
    expect(safeReturnPath("//evil.example/s/alliance")).toBeNull();
    expect(safeReturnPath("/signin")).toBeNull();
  });

  it("builds sign-in redirect URLs and human notices", () => {
    expect(buildSignInRedirect({ reason: "idle", next: "/s/alliance/admin/people" })).toBe(
      "/signin?reason=idle&next=%2Fs%2Falliance%2Fadmin%2Fpeople",
    );
    expect(buildSignInRedirect({ reason: "expired", next: "https://evil.example" })).toBe("/signin?reason=expired");
    expect(signOutReasonNotice("idle")).toContain("15 minutes");
    expect(signOutReasonNotice("expired")).toContain("8-hour");
    expect(signOutReasonNotice("password_reset")).toContain("new password");
    expect(signOutReasonNotice("unknown")).toBe("");
  });
});

describe("qrCode", () => {
  it("matches ISO/IEC 18004 format info (ECC L) and version info BCH values", () => {
    expect(formatInfoBits(0)).toBe(0x77c4);
    expect(formatInfoBits(1)).toBe(0x72f3);
    expect(formatInfoBits(2)).toBe(0x7daa);
    expect(formatInfoBits(3)).toBe(0x789d);
    expect(formatInfoBits(4)).toBe(0x662f);
    expect(formatInfoBits(5)).toBe(0x6318);
    expect(formatInfoBits(6)).toBe(0x6c41);
    expect(formatInfoBits(7)).toBe(0x6976);

    expect(versionInfoBits(7)).toBe(0x07c94);
    expect(versionInfoBits(8)).toBe(0x085bc);
    expect(versionInfoBits(9)).toBe(0x09a99);
  });

  it("encodes an otpauth TOTP URI into a valid matrix with finder and timing patterns", () => {
    const uri = "otpauth://totp/Figbloom:principal%40alliance.sc.ke?secret=JBSWY3DPEHPK3PXP&issuer=Figbloom&algorithm=SHA1&digits=6&period=30";
    const qr = encodeQrMatrix(uri);

    expect(qr.version).toBe(6);
    expect(qr.size).toBe(41);
    expect(qr.modules.length).toBe(41);
    expect(qr.modules.every((row) => row.length === 41)).toBe(true);

    // Top-left finder pattern center 3x3 is dark, ring around it is light, outer 7x7 border is dark.
    expect(qr.modules[0]![0]).toBe(true);
    expect(qr.modules[1]![1]).toBe(false);
    expect(qr.modules[3]![3]).toBe(true);
    expect(qr.modules[7]![0]).toBe(false);

    // Timing pattern alternates starting dark at (6, 8).
    expect(qr.modules[6]![8]).toBe(true);
    expect(qr.modules[6]![9]).toBe(false);
    expect(qr.modules[6]![10]).toBe(true);
  });

  it("throws when payload exceeds version 9 Level L capacity", () => {
    expect(() => encodeQrMatrix("x".repeat(231))).toThrow(/too long/);
  });
});
