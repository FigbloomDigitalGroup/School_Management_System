import { describe, expect, it } from "vitest";
import {
  COLLECTOR_PHONE_PATTERN, earlySignOutProblem, leftEarlyText, liveSignOutsByStudent, markWithSignOut, mayRecordEarlySignOut,
  maySeeSignOutList, mayVoidEarlySignOut, signOutList, signOutPushText, signOutTime, type EarlySignOut, type EarlySignOutDraft,
} from "./earlySignOut";

const draft = (over: Partial<EarlySignOutDraft> = {}): EarlySignOutDraft => ({
  student_id: "s1", reason: "Fever", authorised_by: "Mrs Njoroge", collected_by_name: "Jane Wanjiru",
  collected_by_relationship: "Aunt", collected_by_id_number: "12345678", collected_by_phone: "0712 345 678",
  ...over,
});

const row = (over: Partial<EarlySignOut> = {}): EarlySignOut => ({
  id: "o1", tenant_id: "t1", student_id: "s1", class_id: "c1", student_name: "Amani Wanjiru Otieno", class_name: "Grade 5 West",
  taken_on: "2026-11-06", signed_out_at: "2026-11-06T07:45:00Z", signed_out_local: "10:45:00", reason: "Fever",
  collected_by_name: "Jane Wanjiru", collected_by_relationship: "Aunt",
  recorded_by: "u1", recorded_at: "2026-11-06T07:46:00Z", voided_at: null,
  ...over,
});

describe("earlySignOutProblem", () => {
  it("accepts a complete draft", () => expect(earlySignOutProblem(draft())).toBeNull());

  it("requires every collected-by detail", () => {
    expect(earlySignOutProblem(draft({ collected_by_name: "  " }))).toBe("Enter the name of the person collecting the learner.");
    expect(earlySignOutProblem(draft({ collected_by_relationship: "" }))).toBe("Enter how the collector is related to the learner.");
    expect(earlySignOutProblem(draft({ collected_by_id_number: "" }))).toBe("Enter the collector's ID number.");
    expect(earlySignOutProblem(draft({ collected_by_phone: "" }))).toBe("Enter the collector's phone number.");
  });

  it("requires a learner, a reason and who authorised it", () => {
    expect(earlySignOutProblem(draft({ student_id: "" }))).toBe("Pick the learner.");
    expect(earlySignOutProblem(draft({ reason: " " }))).toBe("Say why the learner is leaving (up to 200 characters).");
    expect(earlySignOutProblem(draft({ authorised_by: "" }))).toBe("Say who authorised the sign-out.");
  });

  it("keeps to the length limits the database checks", () => {
    expect(earlySignOutProblem(draft({ reason: "x".repeat(201) }))).toBe("Say why the learner is leaving (up to 200 characters).");
    expect(earlySignOutProblem(draft({ reason: "x".repeat(200) }))).toBeNull();
    expect(earlySignOutProblem(draft({ authorised_by: "x".repeat(121) }))).toBe("Say who authorised the sign-out.");
    expect(earlySignOutProblem(draft({ collected_by_name: "x".repeat(121) }))).toBe("Enter the name of the person collecting the learner.");
    expect(earlySignOutProblem(draft({ collected_by_relationship: "x".repeat(61) }))).toBe("Enter how the collector is related to the learner.");
    expect(earlySignOutProblem(draft({ collected_by_id_number: "12" }))).toBe("Enter the collector's ID number.");
    expect(earlySignOutProblem(draft({ collected_by_id_number: "1".repeat(31) }))).toBe("Enter the collector's ID number.");
    expect(earlySignOutProblem(draft({ note: "x".repeat(501) }))).toBe("The note can be up to 500 characters.");
    expect(earlySignOutProblem(draft({ note: "x".repeat(500) }))).toBeNull();
  });

  it("an optional note may be left out", () => expect(earlySignOutProblem(draft({ note: undefined }))).toBeNull());

  it("an optional time out is hours and minutes on a 24-hour clock", () => {
    expect(earlySignOutProblem(draft({ signed_out_time: "" }))).toBeNull();
    expect(earlySignOutProblem(draft({ signed_out_time: "10:45" }))).toBeNull();
    expect(earlySignOutProblem(draft({ signed_out_time: "00:00" }))).toBeNull();
    expect(earlySignOutProblem(draft({ signed_out_time: "23:59" }))).toBeNull();
    for (const bad of ["24:00", "9:45", "10:60", "10.45", "ten"]) {
      expect(earlySignOutProblem(draft({ signed_out_time: bad }))).toBe("Enter the time as hours and minutes, like 10:45.");
    }
  });
});

describe("COLLECTOR_PHONE_PATTERN (the same shape as the database check)", () => {
  it.each(["0712345678", "+254712345678", "0712 345 678", "020 555-1234", "254712345678"])("accepts %s", (p) => {
    expect(COLLECTOR_PHONE_PATTERN.test(p)).toBe(true);
  });
  it.each(["", "abc", "12345", "+", "0712-ABC-678", "07123456789012345678901", "-0712345678", " 0712345678"])("refuses %j", (p) => {
    expect(COLLECTOR_PHONE_PATTERN.test(p)).toBe(false);
  });
});

describe("display helpers", () => {
  it("shows the time as HH:MM", () => {
    expect(signOutTime(row())).toBe("10:45");
    expect(leftEarlyText(row())).toBe("left early at 10:45");
  });

  it("adds the sign-out to a register mark, unless it was voided", () => {
    expect(markWithSignOut("Present", row())).toBe("Present, left early at 10:45");
    expect(markWithSignOut("Present", row({ voided_at: "2026-11-06T08:00:00Z" }))).toBe("Present");
    expect(markWithSignOut("Present", null)).toBe("Present");
    expect(markWithSignOut("Present", undefined)).toBe("Present");
  });

  it("ignores voided sign-outs", () => {
    const rows = [
      row({ id: "a", student_id: "s1", voided_at: "2026-11-06T08:00:00Z" }),
      row({ id: "b", student_id: "s1" }),
      row({ id: "c", student_id: "s2", voided_at: "2026-11-06T08:00:00Z" }),
    ];
    const live = liveSignOutsByStudent(rows);
    expect(live.get("s1")?.id).toBe("b");
    expect(live.has("s2")).toBe(false);
  });

  it("a learner who leaves, returns and leaves again shows their last departure, whatever order the rows arrive in", () => {
    const first = row({ id: "a", signed_out_at: "2026-11-06T06:00:00Z", signed_out_local: "09:00:00" });
    const second = row({ id: "b", signed_out_at: "2026-11-06T10:00:00Z", signed_out_local: "13:00:00" });
    expect(liveSignOutsByStudent([first, second]).get("s1")?.id).toBe("b");
    expect(liveSignOutsByStudent([second, first]).get("s1")?.id).toBe("b");
    // voiding the later one brings the earlier one back
    const voided = { ...second, voided_at: "2026-11-06T10:05:00Z" };
    expect(liveSignOutsByStudent([first, voided]).get("s1")?.id).toBe("a");
  });

  it("lists live sign-outs first in the order they left, voided ones after", () => {
    const rows = [
      row({ id: "late", signed_out_at: "2026-11-06T11:00:00Z" }),
      row({ id: "void", signed_out_at: "2026-11-06T06:00:00Z", voided_at: "2026-11-06T07:00:00Z" }),
      row({ id: "early", signed_out_at: "2026-11-06T08:00:00Z" }),
    ];
    expect(signOutList(rows).map((r) => r.id)).toEqual(["early", "late", "void"]);
  });
});

describe("who is offered what (mirrors the database policies)", () => {
  it("recording: full admins, the attendance area and the class teacher; nobody else", () => {
    expect(mayRecordEarlySignOut("all", false)).toBe(true);
    expect(mayRecordEarlySignOut(["attendance"], false)).toBe(true);
    expect(mayRecordEarlySignOut([], true)).toBe(true);
    expect(mayRecordEarlySignOut(["visitors", "fees", "medical"], false)).toBe(false);
    expect(mayRecordEarlySignOut([], false)).toBe(false);
  });

  it("voiding: full admins, the attendance area, or whoever recorded it", () => {
    expect(mayVoidEarlySignOut("all", "u2", "u1")).toBe(true);
    expect(mayVoidEarlySignOut(["attendance"], "u2", "u1")).toBe(true);
    expect(mayVoidEarlySignOut([], "u1", "u1")).toBe(true);
    expect(mayVoidEarlySignOut([], "u2", "u1")).toBe(false);
    expect(mayVoidEarlySignOut(["visitors"], null, "u1")).toBe(false);
  });

  it("the daily list: full admins, the attendance area and the visitors area (the gate)", () => {
    expect(maySeeSignOutList("all")).toBe(true);
    expect(maySeeSignOutList(["attendance"])).toBe(true);
    expect(maySeeSignOutList(["visitors"])).toBe(true);
    expect(maySeeSignOutList(["fees"])).toBe(false);
    expect(maySeeSignOutList([])).toBe(false);
  });
});

describe("signOutPushText", () => {
  it("tells the parent who, when and who collected, in the first name", () => {
    expect(signOutPushText(row())).toEqual({
      title: "Amani was signed out early",
      body: "Signed out at 10:45, collected by Jane Wanjiru (Aunt).",
    });
  });

  it("never carries the collector's ID number or phone", () => {
    const text = JSON.stringify(signOutPushText(row()));
    expect(text).not.toMatch(/12345678|0712/);
  });
});
