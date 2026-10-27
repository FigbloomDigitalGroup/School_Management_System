import { describe, expect, it } from "vitest";
import { COMPETENCY_ITEMS, CORE_COMPETENCIES, CORE_VALUES, competencyKey, ratedCount, ratedItems } from "./competencies";

describe("core competencies and values", () => {
  it("has the seven competencies and seven values, with unique codes the database accepts", () => {
    expect(CORE_COMPETENCIES).toHaveLength(7);
    expect(CORE_VALUES).toHaveLength(7);
    const keys = COMPETENCY_ITEMS.map((it) => competencyKey(it.kind, it.code));
    expect(new Set(keys).size).toBe(keys.length);
    for (const it of COMPETENCY_ITEMS) expect(it.code).toMatch(/^[a-z_]{2,40}$/); // mirrors the item check in the migration
  });

  it("lists ratings in the card's order with the level spelled out, skipping what isn't rated", () => {
    const levels = new Map([
      [competencyKey("value", "integrity"), "EE"],
      [competencyKey("competency", "communication"), "ME"],
    ]);
    expect(ratedItems(levels)).toEqual([
      { kind: "competency", label: "Communication and collaboration", level: "ME", levelLabel: "Meeting expectations" },
      { kind: "value", label: "Integrity", level: "EE", levelLabel: "Exceeding expectations" },
    ]);
    expect(ratedCount(levels)).toBe(2);
    expect(ratedItems(undefined)).toEqual([]);
  });
});
