import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert";
import { tempPassword } from "./tempPassword.ts";

describe("tempPassword", () => {
  it("is 10 characters from the unambiguous alphabet by default", () => {
    const pw = tempPassword();
    assertEquals(pw.length, 10);
    assertMatch(pw, /^[a-hjkmnp-zA-HJ-NP-Z2-9]+$/);
  });

  it("honours a custom length", () => {
    assertEquals(tempPassword(16).length, 16);
  });

  it("is different every time", () => {
    assertNotEquals(tempPassword(), tempPassword());
  });
});
