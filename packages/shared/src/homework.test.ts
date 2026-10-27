import { describe, expect, it } from "vitest";
import {
  addNeed, cleanGuide, defaultGuide, dueWords, EMPTY_GUIDE, guideToneFor, homeworkNotice, isGuideEmpty, isYoungLearner,
  minutesWords, normaliseGuide, retoneGuide, splitHomework, validateHomework,
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
