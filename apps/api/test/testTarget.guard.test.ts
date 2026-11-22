import { describe, expect, it } from "vitest";
import { assertDisposableMarker, DISPOSABLE_MARKER } from "./support/testTarget.js";

/** The marker check is the structural line of defence: it must fail closed on anything but the exact marker. */
describe("test-target marker guard (fails closed)", () => {
  const db = (marker: unknown, name = "figbloom_api") => ({
    query: async () => ({ rows: [{ marker, name }] }),
  });
  it("accepts only the exact disposable marker", async () => {
    await expect(assertDisposableMarker(db(DISPOSABLE_MARKER))).resolves.toBeUndefined();
  });
  it.each([null, "", "figbloom:disposable-test-db:v0", "disposable", undefined])("refuses marker %s", async (m) => {
    await expect(assertDisposableMarker(db(m))).rejects.toThrow(/not marked disposable/);
  });
  it("refuses when the catalog returns no row", async () => {
    await expect(assertDisposableMarker({ query: async () => ({ rows: [] }) })).rejects.toThrow(/not marked disposable/);
  });
});
