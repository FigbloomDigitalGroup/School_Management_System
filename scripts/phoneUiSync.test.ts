import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The two phone apps (apps/mobile and apps/teacher-mobile) have no shared React Native package, so
 * their design-system kit (src/theme.ts and everything in src/ui, tests aside) exists twice and must
 * stay the same, character for character. Change one, change the other; this names the file that
 * drifted.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [mobile, teacher] = ["apps/mobile", "apps/teacher-mobile"].map((a) => join(root, a));

/** Components outside src/ui that both apps use as they are (a view of one list, with nothing app-specific in it). */
const alsoShared = ["src/components/IssuedItems.tsx"];

const kitFiles = (app: string) => {
  const ui = join(app, "src/ui");
  const inUi = existsSync(ui) ? readdirSync(ui).filter((f) => !/\.test\.tsx?$/.test(f)).map((f) => `src/ui/${f}`) : [];
  return ["src/theme.ts", ...alsoShared, ...inUi];
};

// Line endings are not drift: git on Windows may check the same file out with CRLF.
const read = (app: string, file: string) =>
  existsSync(join(app, file)) ? readFileSync(join(app, file), "utf8").replace(/\r\n/g, "\n") : null;

describe("phone apps' UI kit", () => {
  const files = [...new Set([...kitFiles(mobile!), ...kitFiles(teacher!)])].sort();

  it("has files to compare", () => {
    expect(files).toContain("src/theme.ts");
    expect(files).toContain("src/ui/Tap.tsx");
  });

  it.each(files)("%s is the same in both apps", (file) => {
    const inMobile = read(mobile!, file);
    const inTeacher = read(teacher!, file);
    expect(inMobile, `${file} is missing from apps/mobile`).not.toBeNull();
    expect(inTeacher, `${file} is missing from apps/teacher-mobile`).not.toBeNull();
    expect(inTeacher, `${file} differs between apps/mobile and apps/teacher-mobile: make the same change in both`).toBe(inMobile);
  });
});
