import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToHex, sha256, utf8Bytes } from "./sha256";

const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sha256 (the fallback for runtimes without Web Crypto)", () => {
  it("matches the published test vectors", () => {
    expect(bytesToHex(sha256(utf8Bytes("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(bytesToHex(sha256(utf8Bytes("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(bytesToHex(sha256(utf8Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with node:crypto on every length around the block and padding boundaries", () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(bytesToHex(sha256(bytes)), `length ${n}`).toBe(reference(bytes));
    }
  });

  it("agrees with node:crypto on a multi-megabyte file", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
    expect(bytesToHex(sha256(bytes))).toBe(reference(bytes));
  });

  it("encodes text as UTF-8, including characters outside the basic plane", () => {
    for (const text of ["Wanjiku Kamau", "Zoë Ñandú", "名前", "🧾 receipt"]) {
      expect(Array.from(utf8Bytes(text))).toEqual(Array.from(new TextEncoder().encode(text)));
    }
  });
});
