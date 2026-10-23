import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { maskName } from "./maskName.ts";

describe("maskName", () => {
  it("keeps the first name and the last name's initial", () => {
    assertEquals(maskName("Esther Hawi"), "Esther H.");
  });

  it("uses the last of several names for the initial", () => {
    assertEquals(maskName("Alex Otieno Chebet"), "Alex C.");
  });

  it("upper-cases the initial and ignores extra spaces", () => {
    assertEquals(maskName("  wanjiru   kamau "), "wanjiru K.");
  });

  it("gives only the first letter of a single name", () => {
    assertEquals(maskName("Madonna"), "M•••");
  });

  it("is empty for a missing name", () => {
    assertEquals(maskName(""), "");
    assertEquals(maskName(null), "");
    assertEquals(maskName(undefined), "");
  });

  it("never contains the rest of the last name", () => {
    assertEquals(maskName("Esther Hawi").includes("awi"), false);
  });
});
