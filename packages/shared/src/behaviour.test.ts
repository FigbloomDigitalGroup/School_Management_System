import { describe, expect, it } from "vitest";
import {
  behaviourPeriod, DEFAULT_BEHAVIOUR_SETTINGS, familySees, formatPoints, kindCounts, pointsBalance, settingsProblem, thresholdsReached,
  type BehaviourSettings, type TermDates,
} from "./behaviour";

// the same school and history as supabase/rls-checks/behaviour_log.sql, so the two agree
const TERMS: TermDates[] = [
  { year: 2025, starts_on: "2025-09-01" },
  { year: 2026, starts_on: "2026-01-05" },
  { year: 2026, starts_on: "2026-05-04" },
  { year: 2026, starts_on: "2026-08-31" },
];
const E = (points: number, occurred_on: string, voided_at: string | null = null) => ({ points, occurred_on, voided_at });
const HISTORY = [
  E(3, "2025-10-01"), E(3, "2026-02-01"), E(-1, "2026-02-02"), E(2, "2026-05-10"), E(-3, "2026-05-11"), E(-3, "2026-04-15"),
];
const S = (o: Partial<BehaviourSettings> = {}) => ({ ...DEFAULT_BEHAVIOUR_SETTINGS, ...o });

describe("behaviourPeriod", () => {
  it("never: no start or end", () => {
    expect(behaviourPeriod("never", TERMS, "2026-06-01")).toEqual({ start: null, end: null });
  });
  it("term: from the term's start to the day before the next term (the holiday belongs to the term before)", () => {
    expect(behaviourPeriod("term", TERMS, "2026-03-01")).toEqual({ start: "2026-01-05", end: "2026-05-03" });
    expect(behaviourPeriod("term", TERMS, "2026-04-20")).toEqual({ start: "2026-01-05", end: "2026-05-03" });
    expect(behaviourPeriod("term", TERMS, "2026-12-15")).toEqual({ start: "2026-08-31", end: null });
  });
  it("term: before any term, from 1 January", () => {
    expect(behaviourPeriod("term", TERMS, "2025-03-01")).toEqual({ start: "2025-01-01", end: "2025-08-31" });
    expect(behaviourPeriod("term", [], "2026-03-01")).toEqual({ start: "2026-01-01", end: null });
  });
  it("year: the school year of the term, to the day before next year's first term", () => {
    expect(behaviourPeriod("year", TERMS, "2026-06-01")).toEqual({ start: "2026-01-05", end: "2026-12-31" });
    expect(behaviourPeriod("year", TERMS, "2025-12-20")).toEqual({ start: "2025-09-01", end: "2026-01-04" });
    expect(behaviourPeriod("year", [], "2026-06-01")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });
});

describe("pointsBalance", () => {
  it("both, per term: merits add and demerits take away, from 0", () => {
    expect(pointsBalance(HISTORY, S({ mode: "both", reset: "term" }), TERMS, "2026-03-01")).toEqual({ merit_points: 3, demerit_points: -1, balance: 2 });
    expect(pointsBalance(HISTORY, S({ mode: "both", reset: "term" }), TERMS, "2026-04-20").balance).toBe(-1);
    expect(pointsBalance(HISTORY, S({ mode: "both", reset: "term" }), TERMS, "2026-06-01").balance).toBe(-1);
  });
  it("merits only: demerits don't change the balance", () => {
    expect(pointsBalance(HISTORY, S({ mode: "merits_only" }), TERMS, "2026-04-20")).toEqual({ merit_points: 3, demerit_points: -4, balance: 3 });
  });
  it("demerits only: from the starting balance, merits don't change it", () => {
    expect(pointsBalance(HISTORY, S({ mode: "demerits_only", starting_points: 50 }), TERMS, "2026-04-20").balance).toBe(46);
    expect(pointsBalance([], S({ mode: "demerits_only", starting_points: 100 }), TERMS, "2026-04-20").balance).toBe(100);
  });
  it("demerits only, per year: the whole school year counts", () => {
    expect(pointsBalance(HISTORY, S({ mode: "demerits_only", starting_points: 50, reset: "year" }), TERMS, "2026-06-01").balance).toBe(43);
  });
  it("never resets: everything so far", () => {
    expect(pointsBalance(HISTORY, S({ mode: "both", reset: "never" }), TERMS, "2026-06-01").balance).toBe(1);
  });
  it("ignores voided entries and entries after the day asked about", () => {
    const h = [E(5, "2026-02-01", "2026-02-02T08:00:00Z"), E(2, "2026-02-03"), E(4, "2026-03-20")];
    expect(pointsBalance(h, S(), TERMS, "2026-03-01").balance).toBe(2);
  });
  it("points off: no balance, but the sums still show for thresholds", () => {
    expect(pointsBalance(HISTORY, S({ points_enabled: false }), TERMS, "2026-03-01")).toEqual({ merit_points: 3, demerit_points: -1, balance: null });
  });
});

describe("thresholds", () => {
  const T = [{ points: -15, label: "Parent meeting" }, { points: 30, label: "Certificate" }];
  it("a negative one by the period's demerits, a positive one by its merits", () => {
    expect(thresholdsReached({ merit_points: 30, demerit_points: -2 }, T).map((t) => t.label)).toEqual(["Certificate"]);
    expect(thresholdsReached({ merit_points: 4, demerit_points: -15 }, T).map((t) => t.label)).toEqual(["Parent meeting"]);
    expect(thresholdsReached({ merit_points: 29, demerit_points: -14 }, T)).toEqual([]);
  });
});

describe("settings", () => {
  it("accepts the defaults and refuses bad values", () => {
    expect(settingsProblem(DEFAULT_BEHAVIOUR_SETTINGS)).toBeNull();
    expect(settingsProblem({ ...DEFAULT_BEHAVIOUR_SETTINGS, starting_points: -1 })).toMatch(/starting balance/);
    expect(settingsProblem({ ...DEFAULT_BEHAVIOUR_SETTINGS, max_points_per_entry: 0 })).toMatch(/most points/);
    expect(settingsProblem({ ...DEFAULT_BEHAVIOUR_SETTINGS, thresholds: [{ points: 0, label: "x" }] })).toMatch(/threshold/);
    expect(settingsProblem({ ...DEFAULT_BEHAVIOUR_SETTINGS, thresholds: [{ points: 5, label: "  " }] })).toMatch(/label/);
  });
  it("families see merits always, the rest as the school decides", () => {
    expect(familySees(DEFAULT_BEHAVIOUR_SETTINGS)).toEqual(["merit"]);
    expect(familySees({ parents_see_demerits: true, parents_see_incidents: true })).toEqual(["merit", "demerit", "incident"]);
  });
  it("which kinds move the balance in each mode", () => {
    expect(kindCounts("merits_only", "demerit")).toBe(false);
    expect(kindCounts("demerits_only", "merit")).toBe(false);
    expect(kindCounts("both", "incident")).toBe(true);
  });
  it("formats points with a sign", () => {
    expect([formatPoints(2), formatPoints(-3), formatPoints(0)]).toEqual(["+2", "−3", "0"]);
  });
});
