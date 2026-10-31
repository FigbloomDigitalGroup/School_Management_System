import { describe, expect, it } from "vitest";
import { isThemePref, pickScheme } from "./scheme";

describe("pickScheme", () => {
  it("a pick of light or dark is the answer, whatever the phone says", () => {
    expect(pickScheme("dark", "light", "light", false)).toBe("dark");
    expect(pickScheme("light", "dark", "dark", false)).toBe("light");
    expect(pickScheme("dark", "light", "light", true)).toBe("dark");
  });

  it("'same as phone' follows what Android reports", () => {
    expect(pickScheme("system", "dark", "light", false)).toBe("dark");
    expect(pickScheme("system", "light", "dark", false)).toBe("light");
  });

  it("'same as phone' uses the last known phone setting while Android still reports the dropped override", () => {
    // They had forced dark on a light phone, then went back to 'same as phone': Android still says dark.
    expect(pickScheme("system", "dark", "light", true)).toBe("light");
    expect(pickScheme("system", "light", "dark", true)).toBe("dark");
  });
});

describe("isThemePref", () => {
  it("accepts exactly the three picks", () => {
    for (const ok of ["system", "light", "dark"]) expect(isThemePref(ok), ok).toBe(true);
    for (const bad of ["Dark", "auto", "", null, undefined, 1, {}]) expect(isThemePref(bad), String(bad)).toBe(false);
  });
});
