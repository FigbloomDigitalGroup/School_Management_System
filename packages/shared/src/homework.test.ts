import { describe, expect, it } from "vitest";
import {
  addNeed, cleanGuide, defaultGuide, dueDateToText, DUE_IN_THE_PAST, dueWords, EMPTY_GUIDE, guideToneFor, homeworkNotice, isGuideEmpty,
  isYoungLearner, minutesWords, normaliseGuide, parseDueDate, retoneGuide, splitHomework, validateHomework,
  type HomeworkInput, type ParentGuide,
} from "./homework";

// Sunday 25 Oct 2026, mid-morning local time.
const NOW = new Date(2026, 9, 25, 10, 30);
const guide = (over: Partial<ParentGuide> = {}): ParentGuide => ({ ...EMPTY_GUIDE, needs: [], ...over });

describe("dueWords", () => {
  it("says today, tomorrow and a weekday for this week", () => {
    expect(dueWords("2026-10-25", NOW)).toBe("Due today");
    expect(dueWords("2026-10-26", NOW)).toBe("Due tomorrow");
    expect(dueWords("2026-10-27", NOW)).toBe("Due on Tuesday");
  });
  it("gives a date a week or more out", () => {
    expect(dueWords("2026-11-01", NOW)).toBe("Due on 1 Nov");
  });
  it("says how long ago past work was due", () => {
    expect(dueWords("2026-10-24", NOW)).toBe("Was due yesterday");
    expect(dueWords("2026-10-22", NOW)).toBe("Was due 3 days ago");
    expect(dueWords("2026-10-10", NOW)).toBe("Was due on 10 Oct");
  });
});

describe("minutesWords", () => {
  it("is empty when unknown", () => {
    expect(minutesWords(null)).toBe("");
    expect(minutesWords(0)).toBe("");
  });
  it("reads minutes and hours", () => {
    expect(minutesWords(1)).toBe("About 1 minute");
    expect(minutesWords(15)).toBe("About 15 minutes");
    expect(minutesWords(60)).toBe("About 1 hour");
    expect(minutesWords(90)).toBe("About 1 hour 30 minutes");
    expect(minutesWords(120)).toBe("About 2 hours");
  });
});

describe("cleanGuide", () => {
  it("stores a guide that says nothing as null", () => {
    expect(cleanGuide(guide())).toBeNull();
    expect(cleanGuide(guide({ about: "   ", help: "\n" }))).toBeNull();
  });
  it("keeps only the keys that say something, trimmed", () => {
    expect(cleanGuide(guide({ about: "  Fractions  ", minutes: 20 }))).toEqual({ about: "Fractions", minutes: 20 });
  });
  it("de-duplicates needs regardless of case", () => {
    expect(cleanGuide(guide({ needs: ["Printing", "printing", " Calculator ", ""] }))).toEqual({ needs: ["Printing", "Calculator"] });
  });
  it("drops minutes out of range", () => {
    expect(cleanGuide(guide({ about: "x", minutes: 0 }))).toEqual({ about: "x" });
    expect(cleanGuide(guide({ about: "x", minutes: 601 }))).toEqual({ about: "x" });
    expect(cleanGuide(guide({ minutes: 29.6 }))).toEqual({ minutes: 30 });
  });
});

describe("normaliseGuide", () => {
  it("is null for anything that isn't a guide object", () => {
    for (const raw of [null, undefined, "x", 3, [], {}]) expect(normaliseGuide(raw)).toBeNull();
  });
  it("fills in what's missing and ignores what's malformed", () => {
    expect(normaliseGuide({ about: " Graphs ", needs: ["Ruler", 4, "ruler"], minutes: "45", extra: true })).toEqual({
      about: "Graphs", needs: ["Ruler"], help: "", avoid: "", minutes: 45,
    });
    expect(normaliseGuide({ help: 7, minutes: -5 })).toBeNull();
  });
  it("reads back what cleanGuide writes", () => {
    const g = guide({ about: "Counting in twos", needs: ["Bottle tops"], help: "Count together", avoid: "Don't count for them", minutes: 15 });
    expect(normaliseGuide(cleanGuide(g))).toEqual(g);
  });
});

describe("guide tone", () => {
  it("treats PP1 to Grade 3 as young", () => {
    expect(isYoungLearner("pre_primary", 1)).toBe(true);
    expect(isYoungLearner("primary", 3)).toBe(true);
    expect(isYoungLearner("primary", 4)).toBe(false);
    expect(isYoungLearner("secondary", 1)).toBe(false);
    expect(isYoungLearner(null, 1)).toBe(false);
  });
  it("starts a young class with a shorter, sit-with-them guide", () => {
    expect(defaultGuide("primary", 2).minutes).toBe(15);
    expect(defaultGuide("secondary", 2).minutes).toBe(40);
    expect(defaultGuide("primary", 2).about).toBe("");
  });
});

describe("retoneGuide", () => {
  const young = guideToneFor("primary", 1);
  const older = guideToneFor("secondary", 3);

  it("swaps fields still holding the old class's defaults", () => {
    expect(retoneGuide(defaultGuide("primary", 1), young, older)).toEqual(defaultGuide("secondary", 3));
  });
  it("never overwrites what the teacher typed", () => {
    const typed = { ...defaultGuide("primary", 1), about: "Shapes", help: "Point at shapes at home", minutes: 25 };
    const next = retoneGuide(typed, young, older);
    expect(next.about).toBe("Shapes");
    expect(next.help).toBe("Point at shapes at home");
    expect(next.minutes).toBe(25);
    expect(next.avoid).toBe(defaultGuide("secondary", 3).avoid);
  });
  it("fills blanks with the new tone and leaves the same tone alone", () => {
    expect(retoneGuide(guide(), young, older).help).toBe(defaultGuide("secondary", 3).help);
    const g = guide({ help: "" });
    expect(retoneGuide(g, older, older)).toBe(g);
  });
});

describe("addNeed", () => {
  it("adds once, trimmed", () => {
    expect(addNeed(["Printing"], "  printing ")).toEqual(["Printing"]);
    expect(addNeed(["Printing"], " Glue ")).toEqual(["Printing", "Glue"]);
    expect(addNeed([], "   ")).toEqual([]);
  });
});

describe("splitHomework", () => {
  const item = (id: string, dueOn: string, done = false) => ({ id, dueOn, done });

  it("puts overdue oldest first, coming up soonest first, done newest first", () => {
    const r = splitHomework([
      item("a", "2026-10-28"), item("b", "2026-10-20"), item("c", "2026-10-23"),
      item("d", "2026-10-25"), item("e", "2026-10-21", true), item("f", "2026-10-30", true),
    ], NOW);
    expect(r.overdue.map((x) => x.id)).toEqual(["b", "c"]);
    expect(r.upcoming.map((x) => x.id)).toEqual(["d", "a"]);
    expect(r.done.map((x) => x.id)).toEqual(["f", "e"]);
  });
  it("counts work due today as coming up, not overdue", () => {
    expect(splitHomework([item("x", "2026-10-25")], NOW).upcoming).toHaveLength(1);
  });
});

describe("validateHomework with a guide", () => {
  const hw = (over: Partial<HomeworkInput> = {}): HomeworkInput => ({
    classId: "c1", subjectId: "s1", title: "Exercise 4.2", body: "", dueOn: "2026-10-27", handIn: "paper", ...over,
  });

  it("accepts a guide with no time or a time in range", () => {
    expect(validateHomework(hw({ guide: guide() }), "2026-10-25").ok).toBe(true);
    expect(validateHomework(hw({ guide: guide({ minutes: 600 }) }), "2026-10-25").ok).toBe(true);
    expect(validateHomework(hw({ guide: null }), "2026-10-25").ok).toBe(true);
  });
  it("rejects a time out of range", () => {
    expect(validateHomework(hw({ guide: guide({ minutes: 0 }) }), "2026-10-25").ok).toBe(false);
    expect(validateHomework(hw({ guide: guide({ minutes: 601 }) }), "2026-10-25").ok).toBe(false);
  });
  it("keeps main's checks ahead of the guide", () => {
    expect(validateHomework(hw({ classId: "", guide: guide({ minutes: 0 }) }), "2026-10-25")).toEqual({ ok: false, message: "Pick the class." });
  });
});

describe("homeworkNotice", () => {
  it("tells parents only what the teacher filled in", () => {
    const n = homeworkNotice(
      { title: " Speed-time graphs ", dueOn: "2026-10-26", guide: guide({ needs: ["Ruler", "Calculator"], minutes: 40 }) },
      "Maths", "Form 2 West", NOW,
    );
    expect(n.subject).toBe("Homework: Speed-time graphs");
    expect(n.body).toContain("New Maths homework for Form 2 West. Due tomorrow.");
    expect(n.body).toContain("Your child will need: Ruler, Calculator.");
    expect(n.body).toContain("About 40 minutes.");
    expect(n.body).not.toContain("How you can help");
  });
  it("works with no guide at all", () => {
    expect(homeworkNotice({ title: "Read ch. 3", dueOn: "2026-10-25" }, "English", "Grade 4", NOW).body)
      .toBe("New English homework for Grade 4. Due today.\n\nYou can see this any time under Homework.");
  });
  it("treats an empty guide as empty", () => {
    expect(isGuideEmpty(guide())).toBe(true);
    expect(isGuideEmpty(null)).toBe(true);
    expect(isGuideEmpty(guide({ needs: ["Glue"] }))).toBe(false);
  });
});

// FIG-1493: the teacher app's due date is a text box, so it has to read the date the way people write it and say what is wrong.
describe("parseDueDate", () => {
  const iso = (text: string) => { const r = parseDueDate(text); return r.ok ? r.iso : r.message; };

  it("reads day/month/year, the usual way here, and gives the stored year-month-day", () => {
    expect(iso("31/10/2026")).toBe("2026-10-31");
    expect(iso("1/2/2026")).toBe("2026-02-01");
    expect(iso("05/11/2026")).toBe("2026-11-05");
  });
  it("takes a dash, a dot or spaces between the parts, and spaces around the whole", () => {
    expect(iso("31-10-2026")).toBe("2026-10-31");
    expect(iso("31.10.2026")).toBe("2026-10-31");
    expect(iso("31 10 2026")).toBe("2026-10-31");
    expect(iso("  31/10/2026 ")).toBe("2026-10-31");
  });
  it("still takes the stored year-month-day (what the edit box and the web form hold)", () => {
    expect(iso("2026-10-31")).toBe("2026-10-31");
    expect(iso("2026-1-5")).toBe("2026-01-05");
  });
  it("knows leap years", () => {
    expect(iso("29/02/2028")).toBe("2028-02-29");
    expect(iso("29/02/2027")).toBe("There is no 29/2/2027: check the day and the month.");
  });
  it("says there is no such day, and which numbers to check", () => {
    expect(iso("31/02/2026")).toBe("There is no 31/2/2026: check the day and the month.");
    expect(iso("31/04/2026")).toBe("There is no 31/4/2026: check the day and the month.");
    expect(iso("0/10/2026")).toBe("There is no 0/10/2026: check the day and the month.");
  });
  it("says a month goes from 1 to 12 when the numbers are the American way round", () => {
    expect(iso("10/31/2026")).toBe("31 is not a month (1 to 12). Type the date as day/month/year, for example 31/10/2026.");
  });
  it("asks for the year in full", () => {
    expect(iso("31/10/26")).toBe("Write the year in full. Type the date as day/month/year, for example 31/10/2026.");
  });
  it("says what it was given and how to type it when it is not a date, and when it is empty", () => {
    expect(iso("tomorrow")).toBe('"tomorrow" is not a date. Type the date as day/month/year, for example 31/10/2026.');
    expect(iso("31/10")).toMatch(/is not a date/);
    expect(iso("")).toBe("Enter the due date. Type the date as day/month/year, for example 31/10/2026.");
    expect(iso("   ").startsWith("Enter the due date. ")).toBe(true);
  });
  it("feeds validateHomework: a date typed the usual way is accepted, and one in the past gets the past-date message", () => {
    const base = { classId: "c", subjectId: "s", title: "Exercise 4.2", body: "", handIn: "paper" as const };
    const typed = parseDueDate("31/10/2026");
    expect(typed.ok && validateHomework({ ...base, dueOn: typed.iso }, "2026-10-25").ok).toBe(true);
    const past = parseDueDate("24/10/2026");
    const checked = past.ok ? validateHomework({ ...base, dueOn: past.iso }, "2026-10-25") : null;
    expect(checked && !checked.ok && checked.message).toBe(DUE_IN_THE_PAST);
  });
});

describe("dueDateToText", () => {
  it("writes a stored date the way the due-date box asks for it, and leaves anything else alone", () => {
    expect(dueDateToText("2026-10-31")).toBe("31/10/2026");
    expect(dueDateToText("2026-02-01")).toBe("01/02/2026");
    expect(dueDateToText("")).toBe("");
    expect(dueDateToText("soon")).toBe("soon");
  });
  it("round-trips through parseDueDate", () => {
    const r = parseDueDate(dueDateToText("2027-03-09"));
    expect(r.ok && r.iso).toBe("2027-03-09");
  });
});
