/**
 * A test for a defect that is filed and still open, written as the behaviour we WANT. It passes while the defect
 * exists (the assertions inside fail) and fails the day someone fixes it, so the fix has to turn it into a normal
 * `it`. Same idea as Vitest's `it.fails`; Deno's test runner has no equivalent. Not published: "_shared".
 */
import { it } from "jsr:@std/testing/bdd";

export function itFails(name: string, fn: () => unknown | Promise<unknown>) {
  it(`KNOWN ${name}`, async () => {
    let behavesCorrectly = true;
    try {
      await fn();
    } catch {
      behavesCorrectly = false;
    }
    if (behavesCorrectly) {
      throw new Error(`${name}: this now behaves correctly, so the defect looks fixed. Change itFails to it.`);
    }
  });
}
