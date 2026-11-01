import { describe, expect, it } from "vitest";
import {
  allowedMinutes, canStartSitting, countingAttempt, grantNotice, learnerDeadline, learnerPaperStatus, learnerTerms,
  overrideSummary, stillOnTheClock, validateOverride, type LearnerTerms, type OverrideInput, type Sitting,
} from "./examExtensions";

const paper = { opensAt: "2026-11-03T05:00:00.000Z", closesAt: "2026-11-03T07:00:00.000Z", durationMinutes: 60 };
const at = (iso: string) => Date.parse(iso);
const sitting = (attemptNo: number, submittedAt: string | null, finalScore: number | null = null): Sitting => ({ attemptNo, submittedAt, finalScore });

describe("learnerTerms", () => {
  it("is the paper's own terms with no override", () => {
    expect(learnerTerms(paper)).toEqual({
      opensAt: paper.opensAt, closesAt: paper.closesAt, durationMinutes: 60, extraMinutes: 0, attemptsAllowed: 1, counting: "latest",
    });
  });
  it("takes the learner's own window where set, and the paper's for the rest", () => {
    const t = learnerTerms(paper, { opensAt: null, closesAt: "2026-11-04T07:00:00.000Z", extraMinutes: 15, attemptsAllowed: 2, counting: "best" });
    expect(t).toEqual({
      opensAt: paper.opensAt, closesAt: "2026-11-04T07:00:00.000Z", durationMinutes: 60, extraMinutes: 15, attemptsAllowed: 2, counting: "best",
    });
    expect(allowedMinutes(t)).toBe(75);
  });
  it("has no time limit to extend when the paper has none", () => {
    expect(allowedMinutes(learnerTerms({ ...paper, durationMinutes: null }, { opensAt: null, closesAt: null, extraMinutes: 20, attemptsAllowed: 1, counting: "latest" }))).toBe(null);
  });
});

describe("learnerDeadline", () => {
  const terms = (over: Partial<LearnerTerms> = {}): LearnerTerms => ({ ...learnerTerms(paper), ...over });
  it("is start + duration when that comes first", () => {
    expect(learnerDeadline("2026-11-03T05:00:00.000Z", terms())?.toISOString()).toBe("2026-11-03T06:00:00.000Z");
  });
  it("adds extra minutes to the time limit", () => {
    expect(learnerDeadline("2026-11-03T05:00:00.000Z", terms({ extraMinutes: 15 }))?.toISOString()).toBe("2026-11-03T06:15:00.000Z");
  });
  it("adds extra minutes to the closing time too, so a late starter still gets them", () => {
    // starts 06:30: the paper closes at 07:00, the learner's extra 15 minutes push that to 07:15
    expect(learnerDeadline("2026-11-03T06:30:00.000Z", terms())?.toISOString()).toBe("2026-11-03T07:00:00.000Z");
    expect(learnerDeadline("2026-11-03T06:30:00.000Z", terms({ extraMinutes: 15 }))?.toISOString()).toBe("2026-11-03T07:15:00.000Z");
  });
  it("uses the learner's own closing time", () => {
    const t = terms({ opensAt: "2026-11-05T05:00:00.000Z", closesAt: "2026-11-05T05:30:00.000Z" });
    expect(learnerDeadline("2026-11-05T05:10:00.000Z", t)?.toISOString()).toBe("2026-11-05T05:30:00.000Z");
  });
  it("is null with neither a time limit nor a closing time", () => {
    expect(learnerDeadline("2026-11-03T05:00:00.000Z", terms({ durationMinutes: null, closesAt: null, extraMinutes: 10 }))).toBe(null);
  });
});

describe("countingAttempt", () => {
  it("is nothing until a sitting is handed in", () => {
    expect(countingAttempt([sitting(1, null)], "latest")).toBeUndefined();
    expect(countingAttempt([], "best")).toBeUndefined();
  });
  it("latest: the most recent handed-in sitting", () => {
    const list = [sitting(1, "a", 18), sitting(2, "b", 12)];
    expect(countingAttempt(list, "latest")?.attemptNo).toBe(2);
  });
  it("keeps the original while a resit is still being sat", () => {
    expect(countingAttempt([sitting(1, "a", 18), sitting(2, null)], "latest")?.attemptNo).toBe(1);
    expect(countingAttempt([sitting(1, "a", 18), sitting(2, null)], "best")?.attemptNo).toBe(1);
  });
  it("best: the highest score, the later sitting on a tie", () => {
    expect(countingAttempt([sitting(1, "a", 18), sitting(2, "b", 12)], "best")?.attemptNo).toBe(1);
    expect(countingAttempt([sitting(1, "a", 12), sitting(2, "b", 18)], "best")?.attemptNo).toBe(2);
    expect(countingAttempt([sitting(1, "a", 15), sitting(2, "b", 15)], "best")?.attemptNo).toBe(2);
  });
  it("best: an unmarked sitting ranks below any mark", () => {
    expect(countingAttempt([sitting(1, "a", 0), sitting(2, "b", null)], "best")?.attemptNo).toBe(1);
  });
  it("doesn't depend on the order the rows arrive in", () => {
    expect(countingAttempt([sitting(3, "c", 5), sitting(1, "a", 9), sitting(2, "b", 7)], "latest")?.attemptNo).toBe(3);
  });
});

describe("learnerPaperStatus", () => {
  const terms = learnerTerms(paper);
  const base = { mode: "online" as const, terms, attempts: [] as Sitting[], excused: false };
  const before = at("2026-11-03T06:00:00.000Z");
  const after = at("2026-11-03T07:00:00.000Z");

  it("is not started before the paper closes", () => {
    expect(learnerPaperStatus({ ...base, nowMs: at("2026-11-03T04:00:00.000Z") })).toBe("not_started");
    expect(learnerPaperStatus({ ...base, nowMs: before })).toBe("not_started");
  });
  it("is missed once the window has closed with nothing handed in", () => {
    expect(learnerPaperStatus({ ...base, nowMs: after })).toBe("missed");
  });
  it("is not missed while the learner's own window is still open", () => {
    const own = learnerTerms(paper, { opensAt: "2026-11-04T05:00:00.000Z", closesAt: "2026-11-04T07:00:00.000Z", extraMinutes: 0, attemptsAllowed: 1, counting: "latest" });
    expect(learnerPaperStatus({ ...base, terms: own, nowMs: after })).toBe("not_started");
    expect(learnerPaperStatus({ ...base, terms: own, nowMs: at("2026-11-04T07:00:00.000Z") })).toBe("missed");
  });
  it("is never missed when the paper has no closing time", () => {
    expect(learnerPaperStatus({ ...base, terms: learnerTerms({ ...paper, closesAt: null }), nowMs: at("2030-01-01T00:00:00.000Z") })).toBe("not_started");
  });
  it("is excused ahead of anything else", () => {
    expect(learnerPaperStatus({ ...base, excused: true, nowMs: after })).toBe("excused");
  });
  it("is in progress, submitted, then marked", () => {
    expect(learnerPaperStatus({ ...base, attempts: [sitting(1, null)], nowMs: before })).toBe("in_progress");
    expect(learnerPaperStatus({ ...base, attempts: [sitting(1, "x")], nowMs: after })).toBe("submitted");
    expect(learnerPaperStatus({ ...base, attempts: [sitting(1, "x", 14)], nowMs: after })).toBe("marked");
  });
  it("is in progress while a resit is being sat, whatever the original scored", () => {
    expect(learnerPaperStatus({ ...base, attempts: [sitting(1, "x", 14), sitting(2, null)], nowMs: after })).toBe("in_progress");
  });
  it("follows the counting sitting: an unmarked resit under 'latest' is still to mark", () => {
    expect(learnerPaperStatus({ ...base, attempts: [sitting(1, "x", 14), sitting(2, "y")], nowMs: after })).toBe("submitted");
    const best = learnerTerms(paper, { opensAt: null, closesAt: null, extraMinutes: 0, attemptsAllowed: 2, counting: "best" });
    expect(learnerPaperStatus({ ...base, terms: best, attempts: [sitting(1, "x", 14), sitting(2, "y")], nowMs: after })).toBe("marked");
  });
  it("is null for a paper that is read, not sat online", () => {
    expect(learnerPaperStatus({ ...base, mode: "read", nowMs: after })).toBe(null);
  });
});

describe("canStartSitting", () => {
  const terms = learnerTerms(paper);
  const open = at("2026-11-03T06:00:00.000Z");
  it("allows a first sitting only inside the window", () => {
    expect(canStartSitting({ terms, attemptsUsed: 0, lastSubmitted: false, excused: false, nowMs: open })).toBe(true);
    expect(canStartSitting({ terms, attemptsUsed: 0, lastSubmitted: false, excused: false, nowMs: at("2026-11-03T04:59:00.000Z") })).toBe(false);
    expect(canStartSitting({ terms, attemptsUsed: 0, lastSubmitted: false, excused: false, nowMs: at("2026-11-03T07:00:00.000Z") })).toBe(false);
  });
  it("lets a learner start inside their own window after the paper closed for everyone else", () => {
    const own = learnerTerms(paper, { opensAt: "2026-11-04T05:00:00.000Z", closesAt: "2026-11-04T07:00:00.000Z", extraMinutes: 0, attemptsAllowed: 1, counting: "latest" });
    expect(canStartSitting({ terms: own, attemptsUsed: 0, lastSubmitted: false, excused: false, nowMs: at("2026-11-04T06:00:00.000Z") })).toBe(true);
  });
  it("allows a resit only once granted and once the last sitting is in", () => {
    const resit = learnerTerms(paper, { opensAt: null, closesAt: null, extraMinutes: 0, attemptsAllowed: 2, counting: "latest" });
    expect(canStartSitting({ terms, attemptsUsed: 1, lastSubmitted: true, excused: false, nowMs: open })).toBe(false);
    expect(canStartSitting({ terms: resit, attemptsUsed: 1, lastSubmitted: true, excused: false, nowMs: open })).toBe(true);
    expect(canStartSitting({ terms: resit, attemptsUsed: 1, lastSubmitted: false, excused: false, nowMs: open })).toBe(false);
    expect(canStartSitting({ terms: resit, attemptsUsed: 2, lastSubmitted: true, excused: false, nowMs: open })).toBe(false);
  });
  it("never for an excused learner", () => {
    expect(canStartSitting({ terms, attemptsUsed: 0, lastSubmitted: false, excused: true, nowMs: open })).toBe(false);
  });
});

describe("stillOnTheClock", () => {
  it("allows two minutes' grace after the deadline", () => {
    const d = "2026-11-03T06:00:00.000Z";
    expect(stillOnTheClock(d, at("2026-11-03T06:01:59.000Z"))).toBe(true);
    expect(stillOnTheClock(d, at("2026-11-03T06:02:01.000Z"))).toBe(false);
    expect(stillOnTheClock(null, at("2030-01-01T00:00:00.000Z"))).toBe(true);
  });
});

describe("validateOverride", () => {
  const input = (over: Partial<OverrideInput> = {}): OverrideInput => ({
    opensAt: null, closesAt: null, extraMinutes: 15, resit: false, counting: "latest", reason: "Sick on the day", ...over,
  });
  it("accepts extra time and tidies the reason", () => {
    expect(validateOverride(input({ reason: "  Sick   on the day " }), paper)).toEqual({ ok: true, value: input() });
  });
  it("needs a reason", () => {
    expect(validateOverride(input({ reason: " " }), paper).ok).toBe(false);
    expect(validateOverride(input({ reason: "x".repeat(501) }), paper).ok).toBe(false);
  });
  it("needs something to give", () => {
    expect(validateOverride(input({ extraMinutes: 0 }), paper)).toEqual({ ok: false, message: "Give extra time, a window of their own, or a resit." });
    expect(validateOverride(input({ extraMinutes: 0 }), paper, { hasResitAlready: true }).ok).toBe(true);
    expect(validateOverride(input({ extraMinutes: 0, resit: true }), paper).ok).toBe(true);
    expect(validateOverride(input({ extraMinutes: 0, closesAt: "2026-11-04T07:00:00.000Z" }), paper).ok).toBe(true);
  });
  it("checks extra time is whole minutes in range", () => {
    expect(validateOverride(input({ extraMinutes: -5 }), paper).ok).toBe(false);
    expect(validateOverride(input({ extraMinutes: 2.5 }), paper).ok).toBe(false);
    expect(validateOverride(input({ extraMinutes: 601 }), paper).ok).toBe(false);
  });
  it("checks the window closes after it opens, using the paper's for a missing end", () => {
    expect(validateOverride(input({ opensAt: "2026-11-03T08:00:00.000Z" }), paper)).toEqual({ ok: false, message: "The window has to close after it opens." });
    expect(validateOverride(input({ opensAt: "2026-11-04T05:00:00.000Z", closesAt: "2026-11-04T07:00:00.000Z" }), paper).ok).toBe(true);
    expect(validateOverride(input({ closesAt: "2026-11-03T04:00:00.000Z" }), paper).ok).toBe(false);
  });
});

describe("overrideSummary and grantNotice", () => {
  it("summarises what a learner was given", () => {
    expect(overrideSummary({ opensAt: null, closesAt: null, extraMinutes: 15, attemptsAllowed: 1, counting: "latest" })).toBe("+15 min");
    expect(overrideSummary({ opensAt: null, closesAt: null, extraMinutes: 0, attemptsAllowed: 2, counting: "best" })).toBe("resit (2 sittings, best counts)");
  });
  it("tells the learner about a resit", () => {
    const n = grantNotice({ title: "Mid-term Maths", subjectName: "Mathematics" }, { opensAt: null, closesAt: null, extraMinutes: 0, resit: true });
    expect(n.subject).toBe("Resit: Mid-term Maths");
    expect(n.body).toContain("You can sit \"Mid-term Maths\" (Mathematics) again.");
  });
  it("tells the learner about extra time", () => {
    const n = grantNotice({ title: "CAT 2", subjectName: "Biology" }, { opensAt: null, closesAt: null, extraMinutes: 20, resit: false });
    expect(n.subject).toBe("Extra time: CAT 2");
    expect(n.body).toContain("You have 20 extra minutes.");
  });
});
