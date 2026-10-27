import { describe, expect, it } from "vitest";
import {
  achievementLabel, diffIds, eventNotice, eventResultLabel, eventToForm, isAchievement, ordinal, splitEvents,
  validateActivity, validateEvent, type ActivityEventRow, type EventForm,
} from "./activities";

const form = (over: Partial<EventForm> = {}): EventForm => ({
  activityId: "a1", title: "Football vs Kakamega School", kind: "fixture", level: "county",
  date: "2026-11-07", startTime: "14:00", endTime: "16:30", venue: "Bukhungu Stadium", opponent: "Kakamega School",
  status: "scheduled", score: "", outcome: "", position: "", notes: "",
  ...over,
});

const event = (over: Partial<ActivityEventRow> = {}): ActivityEventRow => ({
  id: "e1", activityId: "a1", title: "Football vs Kakamega School", kind: "fixture", level: "county",
  startsAt: new Date("2026-11-07T14:00").toISOString(), endsAt: new Date("2026-11-07T16:30").toISOString(),
  venue: "Bukhungu Stadium", opponent: "Kakamega School", status: "scheduled", score: "", outcome: null, position: null,
  notes: "", notifiedAt: null,
  ...over,
});

describe("validateActivity", () => {
  it("trims and accepts a good activity", () => {
    expect(validateActivity({ name: "  Football  ", category: "sport", description: " Boys and girls ", meetingSchedule: " Tue 4pm " }))
      .toEqual({ ok: true, value: { name: "Football", category: "sport", description: "Boys and girls", meetingSchedule: "Tue 4pm" } });
  });
  it("needs a name and a known category", () => {
    expect(validateActivity({ name: " ", category: "sport", description: "", meetingSchedule: "" }).ok).toBe(false);
    expect(validateActivity({ name: "Chess", category: "board" as never, description: "", meetingSchedule: "" }).ok).toBe(false);
  });
  it("holds the same limits as the database", () => {
    expect(validateActivity({ name: "x".repeat(121), category: "club", description: "", meetingSchedule: "" }).ok).toBe(false);
    expect(validateActivity({ name: "Drama", category: "arts", description: "", meetingSchedule: "x".repeat(301) }).ok).toBe(false);
  });
});

describe("validateEvent", () => {
  it("reads the date and times in local time", () => {
    const r = validateEvent(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.startsAt).toBe(new Date("2026-11-07T14:00").toISOString());
    expect(r.value.endsAt).toBe(new Date("2026-11-07T16:30").toISOString());
    expect(r.value.level).toBe("county");
  });
  it("allows no end time and no level", () => {
    const r = validateEvent(form({ endTime: "", level: "" }));
    expect(r.ok && r.value.endsAt === null && r.value.level === null).toBe(true);
  });
  it("refuses an end before the start, a bad time, or a missing title", () => {
    expect(validateEvent(form({ endTime: "13:00" })).ok).toBe(false);
    expect(validateEvent(form({ startTime: "25:00" })).ok).toBe(false);
    expect(validateEvent(form({ title: "  " })).ok).toBe(false);
    expect(validateEvent(form({ date: "" })).ok).toBe(false);
  });
  it("keeps a result only once the event is done", () => {
    const pending = validateEvent(form({ score: "2-1", outcome: "won", position: "1" }));
    expect(pending.ok && pending.value.score === "" && pending.value.outcome === null && pending.value.position === null).toBe(true);
    const done = validateEvent(form({ status: "completed", score: "2-1", outcome: "won", position: "1" }));
    expect(done.ok && done.value.score === "2-1" && done.value.outcome === "won" && done.value.position === 1).toBe(true);
  });
  it("wants a whole-number position", () => {
    expect(validateEvent(form({ status: "completed", position: "1.5" })).ok).toBe(false);
    expect(validateEvent(form({ status: "completed", position: "0" })).ok).toBe(false);
  });
});

describe("eventToForm", () => {
  it("round-trips through validateEvent", () => {
    const f = eventToForm(event());
    expect(f.date).toBe("2026-11-07");
    expect(f.startTime).toBe("14:00");
    expect(f.endTime).toBe("16:30");
    const r = validateEvent(f);
    expect(r.ok && r.value.startsAt === event().startsAt).toBe(true);
  });
});

describe("ordinal", () => {
  it("handles the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"],
    );
  });
});

describe("eventResultLabel", () => {
  it("is empty until the event is done", () => {
    expect(eventResultLabel({ status: "scheduled", score: "2-1", outcome: "won", position: null })).toBe("");
  });
  it("puts outcome, score and place together", () => {
    expect(eventResultLabel({ status: "completed", score: "2-1", outcome: "won", position: null })).toBe("Won 2-1");
    expect(eventResultLabel({ status: "completed", score: "", outcome: null, position: 3 })).toBe("3rd place");
    expect(eventResultLabel({ status: "completed", score: "45 pts", outcome: null, position: 1 })).toBe("45 pts · 1st");
  });
});

describe("splitEvents", () => {
  const now = new Date("2026-11-07T15:00");
  it("keeps an event coming up until it ends, then moves it to past", () => {
    const { upcoming, past } = splitEvents([event()], now);
    expect(upcoming).toHaveLength(1);
    expect(past).toHaveLength(0);
    expect(splitEvents([event()], new Date("2026-11-07T17:00")).past).toHaveLength(1);
  });
  it("with no end time, an event is coming up for the rest of its day", () => {
    const e = event({ endsAt: null });
    expect(splitEvents([e], new Date("2026-11-07T23:00")).upcoming).toHaveLength(1);
    expect(splitEvents([e], new Date("2026-11-08T00:01")).past).toHaveLength(1);
  });
  it("cancelled and finished events are past, whatever the time", () => {
    const later = { startsAt: new Date("2026-12-01T10:00").toISOString(), endsAt: null };
    expect(splitEvents([event({ ...later, status: "cancelled" }), event({ ...later, status: "completed" })], now).past).toHaveLength(2);
  });
  it("orders upcoming soonest first and past newest first", () => {
    const a = event({ id: "a", startsAt: new Date("2026-11-10T10:00").toISOString(), endsAt: null });
    const b = event({ id: "b", startsAt: new Date("2026-11-09T10:00").toISOString(), endsAt: null });
    const c = event({ id: "c", startsAt: new Date("2026-10-01T10:00").toISOString(), endsAt: null });
    const d = event({ id: "d", startsAt: new Date("2026-10-05T10:00").toISOString(), endsAt: null });
    const r = splitEvents([a, b, c, d], now);
    expect(r.upcoming.map((e) => e.id)).toEqual(["b", "a"]);
    expect(r.past.map((e) => e.id)).toEqual(["d", "c"]);
  });
});

describe("achievements", () => {
  it("counts a medal, a place or a named achievement", () => {
    expect(isAchievement({ award: null, position: null, achievement: null })).toBe(false);
    expect(isAchievement({ award: "gold", position: null, achievement: null })).toBe(true);
    expect(isAchievement({ award: null, position: 4, achievement: null })).toBe(true);
    expect(isAchievement({ award: null, position: null, achievement: "Best actor" })).toBe(true);
  });
  it("doesn't say the place twice for a medal", () => {
    expect(achievementLabel({ award: "gold", position: 1, achievement: "400 m" })).toBe("Gold · 400 m");
    expect(achievementLabel({ award: "trophy", position: 2, achievement: null })).toBe("Trophy · 2nd place");
    expect(achievementLabel({ award: null, position: 5, achievement: null })).toBe("5th place");
  });
});

describe("eventNotice", () => {
  it("leaves out what wasn't filled in", () => {
    const n = eventNotice(event({ venue: "", opponent: "", level: null }), "Football");
    expect(n.subject).toBe("Football: Football vs Kakamega School");
    expect(n.body).not.toContain("Where:");
    expect(n.body).not.toContain("Level:");
  });
  it("says where, against whom and at what level", () => {
    const n = eventNotice(event({ notes: "Bring games kit." }), "Football");
    expect(n.body).toContain("Where: Bukhungu Stadium");
    expect(n.body).toContain("Against / hosted by: Kakamega School");
    expect(n.body).toContain("Level: County");
    expect(n.body).toContain("Bring games kit.");
  });
});

describe("diffIds", () => {
  it("adds the new and removes the dropped", () => {
    expect(diffIds(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(diffIds([], [])).toEqual({ add: [], remove: [] });
  });
});
