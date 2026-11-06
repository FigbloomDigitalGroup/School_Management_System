import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { createHmac } from "node:crypto";
import { signFigbloomWebhook, verifyFigbloomWebhook } from "./platformWebhook.ts";

const SECRET = "x".repeat(64);
const BODY = '{"organization":{"id":"p1","local_id":"o1","status":"suspended"},"decided_by":"console:ann@figbloom.org","decided_at":"2026-11-02T10:00:00.000Z"}';
const NOW = Date.parse("2026-11-02T10:00:00Z");

describe("verifyFigbloomWebhook", () => {
  it("accepts the platform's signature", async () => {
    const { signature, timestamp } = await signFigbloomWebhook(SECRET, BODY, NOW);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, timestamp, NOW), true);
  });

  it("accepts a signature made the platform's way (node:crypto createHmac, as in its README)", async () => {
    const ts = "1762077600";
    const signature = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${BODY}`).digest("hex")}`;
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, ts, 1762077600_000), true);
  });

  it("refuses a wrong signature, another secret, or a changed body", async () => {
    const { signature, timestamp } = await signFigbloomWebhook(SECRET, BODY, NOW);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature.replace(/.$/, (c) => (c === "0" ? "1" : "0")), timestamp, NOW), false);
    assertEquals(await verifyFigbloomWebhook("y".repeat(64), BODY, signature, timestamp, NOW), false);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY.replace("suspended", "active"), signature, timestamp, NOW), false);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature.replace("sha256=", ""), timestamp, NOW), false);
  });

  it("refuses a missing signature, timestamp or secret", async () => {
    const { signature, timestamp } = await signFigbloomWebhook(SECRET, BODY, NOW);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, null, timestamp, NOW), false);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, null, NOW), false);
    assertEquals(await verifyFigbloomWebhook("", BODY, signature, timestamp, NOW), false);
  });

  it("refuses a timestamp more than 5 minutes off, either way, or not a number", async () => {
    const { signature, timestamp } = await signFigbloomWebhook(SECRET, BODY, NOW);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, timestamp, NOW + 299_000), true);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, timestamp, NOW + 301_000), false);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, timestamp, NOW - 301_000), false);
    assertEquals(await verifyFigbloomWebhook(SECRET, BODY, signature, "17620776OO", NOW), false);
  });
});
