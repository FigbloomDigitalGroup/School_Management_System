import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUSPENDED_SCHOOL_MESSAGE } from "../packages/shared/src/suspended";

/**
 * resolve-login-id (Deno) can't import packages/shared, so the suspended-school
 * message is written twice. They must say the same thing.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the suspended-school message", () => {
  it("is the same in the edge functions as in the apps", () => {
    const src = readFileSync(join(root, "supabase/functions/_shared/signInStatuses.ts"), "utf8");
    const m = /export const SUSPENDED_SCHOOL_MESSAGE =\s*"([^"]+)";/.exec(src);
    expect(m?.[1]).toBe(SUSPENDED_SCHOOL_MESSAGE);
  });
});
