import { describe, expect, it } from "vitest";
import { behaviourPeriod, pointsFromSums } from "../src/modules/behaviour/points.js";

/**
 * The points period and balance (docs/BEHAVIOUR.md, "Points"): the same rules as `behaviourPeriod` and `pointsBalance` in
 * packages/shared/src/behaviour.ts, the live Supabase feature. Pure functions, no database.
 */
const y1 = "year-1";
const y2 = "year-2";
const terms = [
  { academic_year_id: y1, starts_on: "2026-01-05" },
  { academic_year_id: y1, starts_on: "2026-05-04" },
  { academic_year_id: y1, starts_on: "2026-09-07" },
  { academic_year_id: y2, starts_on: "2027-01-04" },
];

describe("behaviourPeriod", () => {
  it("never has no bounds", () => {
    expect(behaviourPeriod("never", terms, "2026-06-01")).toEqual({ start: null, end: null });
  });

  it("term: from the term's start to the day before the next term (the holiday after a term belongs to it)", () => {
    expect(behaviourPeriod("term", terms, "2026-06-01")).toEqual({ start: "2026-05-04", end: "2026-09-06" });
    expect(behaviourPeriod("term", terms, "2026-05-04")).toEqual({ start: "2026-05-04", end: "2026-09-06" });
    expect(behaviourPeriod("term", terms, "2026-05-03")).toEqual({ start: "2026-01-05", end: "2026-05-03" });
    // the long holiday after the last term of the year belongs to that term
    expect(behaviourPeriod("term", terms, "2026-12-20")).toEqual({ start: "2026-09-07", end: "2027-01-03" });
  });

  it("term: open-ended after the last term, and from 1 January before the first", () => {
    expect(behaviourPeriod("term", terms, "2027-02-01")).toEqual({ start: "2027-01-04", end: null });
    expect(behaviourPeriod("term", terms, "2025-11-20")).toEqual({ start: "2025-01-01", end: "2026-01-04" });
    expect(behaviourPeriod("term", [], "2026-06-01")).toEqual({ start: "2026-01-01", end: null });
  });

  it("year: from the year's first term to the day before the next year's first term", () => {
    expect(behaviourPeriod("year", terms, "2026-06-01")).toEqual({ start: "2026-01-05", end: "2027-01-03" });
    expect(behaviourPeriod("year", terms, "2026-12-20")).toEqual({ start: "2026-01-05", end: "2027-01-03" });
    expect(behaviourPeriod("year", terms, "2027-01-04")).toEqual({ start: "2027-01-04", end: null });
  });

  it("year: with no later year set up it is open-ended; before any term it behaves as a term", () => {
    expect(behaviourPeriod("year", terms.slice(0, 3), "2026-12-20")).toEqual({ start: "2026-01-05", end: null });
    expect(behaviourPeriod("year", terms, "2025-11-20")).toEqual({ start: "2025-01-01", end: "2026-01-04" });
  });

  it("does not depend on the order the terms arrive in", () => {
    expect(behaviourPeriod("year", [...terms].reverse(), "2026-06-01")).toEqual(behaviourPeriod("year", terms, "2026-06-01"));
    expect(behaviourPeriod("term", [...terms].reverse(), "2026-06-01")).toEqual(behaviourPeriod("term", terms, "2026-06-01"));
  });
});

describe("pointsFromSums", () => {
  const on = { points_enabled: true, starting_points: 100 };
  it("merits only: the merits", () => {
    expect(pointsFromSums(7, -5, { ...on, mode: "merits_only" })).toEqual({ merit_points: 7, demerit_points: -5, balance: 7 });
  });
  it("demerits only: the starting balance plus the demerits", () => {
    expect(pointsFromSums(7, -5, { ...on, mode: "demerits_only" })).toEqual({ merit_points: 7, demerit_points: -5, balance: 95 });
  });
  it("both: merits plus demerits", () => {
    expect(pointsFromSums(7, -5, { ...on, mode: "both" })).toEqual({ merit_points: 7, demerit_points: -5, balance: 2 });
  });
  it("points off: the balance is null but the totals are still counted", () => {
    expect(pointsFromSums(7, -5, { ...on, points_enabled: false, mode: "both" })).toEqual({ merit_points: 7, demerit_points: -5, balance: null });
  });
});
