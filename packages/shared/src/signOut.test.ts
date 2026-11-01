import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * supabase-js's signOut() with no scope is global: it ends every session of
 * the account, so signing out on the web logged the parent out of their
 * phone too, and picking the wrong portal at sign-in did the same
 * (FIG-1340). Every sign-out in the apps ends this device's session only.
 */
const ROOT = join(__dirname, "..", "..", "..");
const APPS = ["apps/web/src", "apps/mobile/src", "apps/mobile/App.tsx", "apps/teacher-mobile/src", "apps/teacher-mobile/App.tsx", "packages/shared/src"];

function sources(path: string): string[] {
  let st;
  try { st = statSync(path); } catch { return []; }
  if (st.isFile()) return /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => (name === "node_modules" ? [] : sources(join(path, name))));
}

describe("signing out (FIG-1340)", () => {
  it("ends this device's session only, everywhere in the apps", () => {
    const bare = APPS.flatMap((p) => sources(join(ROOT, p)))
      .flatMap((file) => readFileSync(file, "utf8").split("\n").map((line, i) => ({ file, line, n: i + 1 })))
      .filter(({ line }) => /auth\.signOut\(\s*\)/.test(line))
      .map(({ file, n }) => `${relative(ROOT, file)}:${n}`);
    expect(bare).toEqual([]);
  });
});
