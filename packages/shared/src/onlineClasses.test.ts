import { describe, expect, it } from "vitest";
import {
  formatRemoteRange, linkGaps, meetingProvider, nextRemoteSchoolDate, normaliseMeetingUrl, remoteDayOn,
  remoteDaysAnnouncement, resolveOnlineDay, weekdayOfDate, type RemoteDay,
} from "./onlineClasses";

// 12 Oct 2026 is a Monday
const strike: RemoteDay = {
  id: "r1", tenant_id: "t", starts_on: "2026-10-12", ends_on: "2026-10-13", reason: "Teachers' strike",
  created_by: null, created_at: "2026-10-09T08:00:00Z",
};

const slots = [
  { class_id: "c1", day: "Mon" as const, start_time: "08:00", label: "Maths", room: "Rm 1", subject_id: "maths" },
  { class_id: "c1", day: "Mon" as const, start_time: "09:00", label: "English", room: "Rm 1", subject_id: "eng" },
  { class_id: "c1", day: "Mon" as const, start_time: "10:00", label: "Games", room: null, subject_id: null },
  { class_id: "c1", day: "Tue" as const, start_time: "08:00", label: "Chemistry", room: "Lab", subject_id: "chem" },
];

const MEET = "https://meet.google.com/abc-defg-hij";
const ZOOM = "https://us02web.zoom.us/j/123456789";
const TEAMS = "https://teams.microsoft.com/l/meetup-join/xyz";

describe("meetingProvider", () => {
  it("recognises Meet, Zoom and Teams links", () => {
    expect(meetingProvider(MEET)).toBe("meet");
    expect(meetingProvider(ZOOM)).toBe("zoom");
    expect(meetingProvider(TEAMS)).toBe("teams");
  });
  it("is other for anything else, including look-alike hosts", () => {
    expect(meetingProvider("https://jitsi.example.org/room")).toBe("other");
    expect(meetingProvider("https://notzoom.us/j/1")).toBe("other");
    expect(meetingProvider("not a url")).toBe("other");
  });
});

describe("normaliseMeetingUrl", () => {
  it("adds https to a link pasted without a scheme", () => {
    expect(normaliseMeetingUrl("  meet.google.com/abc-defg-hij ")).toBe(MEET);
  });
  it("upgrades http to https", () => {
    expect(normaliseMeetingUrl("http://zoom.us/j/1")).toBe("https://zoom.us/j/1");
  });
  it("rejects things that aren't web links", () => {
    expect(normaliseMeetingUrl("")).toBeNull();
    expect(normaliseMeetingUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseMeetingUrl("ask the teacher")).toBeNull();
  });
});

describe("weekdayOfDate / remoteDayOn / nextRemoteSchoolDate", () => {
  it("maps dates to timetable days, null at the weekend", () => {
    expect(weekdayOfDate("2026-10-12")).toBe("Mon");
    expect(weekdayOfDate("2026-10-16")).toBe("Fri");
    expect(weekdayOfDate("2026-10-17")).toBeNull();
  });
  it("finds the block covering a date, ends inclusive", () => {
    expect(remoteDayOn("2026-10-13", [strike])?.id).toBe("r1");
    expect(remoteDayOn("2026-10-14", [strike])).toBeNull();
  });
  it("prefers the most recently declared block when two overlap", () => {
    const later = { ...strike, id: "r2", created_at: "2026-10-10T08:00:00Z" };
    expect(remoteDayOn("2026-10-12", [later, strike])?.id).toBe("r2");
  });
  it("skips past and weekend days when finding the next remote school day", () => {
    expect(nextRemoteSchoolDate(strike, "2026-10-09")).toBe("2026-10-12");
    expect(nextRemoteSchoolDate(strike, "2026-10-13")).toBe("2026-10-13");
    expect(nextRemoteSchoolDate(strike, "2026-10-14")).toBeNull();
    expect(nextRemoteSchoolDate({ starts_on: "2026-10-17", ends_on: "2026-10-18" }, "2026-10-09")).toBeNull();
  });
});

describe("resolveOnlineDay", () => {
  it("is all in person on a normal day", () => {
    const day = resolveOnlineDay({ date: "2026-10-19", slots, remoteDays: [strike], links: [], lessons: [] });
    expect(day.remoteDay).toBeNull();
    expect(day.periods.map((p) => p.mode)).toEqual(["in_person", "in_person", "in_person"]);
    expect(day.periods.every((p) => p.joinUrl === null)).toBe(true);
  });

  it("puts every period online on a remote day, using subject then class-wide links", () => {
    const day = resolveOnlineDay({
      date: "2026-10-12", slots, remoteDays: [strike], lessons: [],
      links: [
        { class_id: "c1", subject_id: "maths", url: ZOOM },
        { class_id: "c1", subject_id: null, url: MEET },
      ],
    });
    expect(day.remoteDay?.reason).toBe("Teachers' strike");
    const [maths, english, games] = day.periods;
    expect(maths).toMatchObject({ mode: "online", joinUrl: ZOOM, provider: "zoom", source: "subject_link", needsLink: false });
    expect(english).toMatchObject({ mode: "online", joinUrl: MEET, provider: "meet", source: "class_link" });
    expect(games).toMatchObject({ mode: "online", joinUrl: MEET });
  });

  it("flags academic lessons with no link, but not non-subject periods", () => {
    const day = resolveOnlineDay({ date: "2026-10-12", slots, remoteDays: [strike], links: [], lessons: [] });
    expect(day.periods.map((p) => p.needsLink)).toEqual([true, true, false]);
    expect(linkGaps(day.periods)).toEqual({ lessons: 2, missing: 2 });
  });

  it("makes a single dated lesson online on a normal day, with its own link winning", () => {
    const day = resolveOnlineDay({
      date: "2026-10-19", slots, remoteDays: [],
      links: [{ class_id: "c1", subject_id: "eng", url: MEET }],
      lessons: [
        { id: "l1", class_id: "c1", on_date: "2026-10-19", start_time: "09:00", subject_id: "eng", url: TEAMS, note: "Bring the set book" },
        { id: "l2", class_id: "c1", on_date: "2026-10-20", start_time: "08:00", subject_id: "maths", url: ZOOM, note: null },
      ],
    });
    const [maths, english] = day.periods;
    expect(maths).toMatchObject({ mode: "in_person", joinUrl: null, needsLink: false });
    expect(english).toMatchObject({
      mode: "online", joinUrl: TEAMS, provider: "teams", source: "lesson", note: "Bring the set book", onlineLessonId: "l1",
    });
  });

  it("falls back to the standing link for a dated online lesson without its own", () => {
    const day = resolveOnlineDay({
      date: "2026-10-19", slots, remoteDays: [],
      links: [{ class_id: "c1", subject_id: "maths", url: ZOOM }],
      lessons: [{ id: "l1", class_id: "c1", on_date: "2026-10-19", start_time: "08:00", subject_id: "maths", url: null, note: null }],
    });
    expect(day.periods[0]).toMatchObject({ mode: "online", joinUrl: ZOOM, source: "subject_link" });
  });

  it("has no periods at the weekend", () => {
    expect(resolveOnlineDay({ date: "2026-10-17", slots, remoteDays: [strike], links: [], lessons: [] }).periods).toEqual([]);
  });
});

describe("remote-day notice copy", () => {
  it("lists a short block's days with the month once", () => {
    expect(formatRemoteRange("2026-10-12", "2026-10-13")).toBe("Mon 12 and Tue 13 October");
    expect(formatRemoteRange("2026-10-12", "2026-10-14")).toBe("Mon 12, Tue 13 and Wed 14 October");
    expect(formatRemoteRange("2026-10-12", "2026-10-12")).toBe("Mon 12 October");
  });
  it("leaves the weekend out and names both months across a month end", () => {
    expect(formatRemoteRange("2026-10-30", "2026-11-02")).toBe("Fri 30 October and Mon 2 November");
  });
  it("gives a long block as a range", () => {
    expect(formatRemoteRange("2026-10-12", "2026-10-23")).toBe("Mon 12 to Fri 23 October");
  });
  it("writes the notice the way the office would", () => {
    const n = remoteDaysAnnouncement("2026-10-12", "2026-10-13", "Teachers' strike");
    expect(n.subject).toBe("School is online on Mon 12 and Tue 13 October");
    expect(n.body.startsWith(
      "School is online on Mon 12 and Tue 13 October (teachers' strike). Lessons follow the normal timetable; join links are in the app.",
    )).toBe(true);
  });
});
