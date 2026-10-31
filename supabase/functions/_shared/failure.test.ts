import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { failure } from "./failure.ts";

describe("failure (FIG-1342)", () => {
  it("answers a sentence and keeps the database's words for the log", () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const body = failure("invite-admin", "save the profile", { message: 'duplicate key value violates unique constraint "profiles_login_id_unique"' });
      assertEquals(body, { error: "Could not save the profile. Try again." });
      assertEquals(logged[0], ["invite-admin: could not save the profile:", 'duplicate key value violates unique constraint "profiles_login_id_unique"']);
    } finally {
      console.error = original;
    }
  });
});
