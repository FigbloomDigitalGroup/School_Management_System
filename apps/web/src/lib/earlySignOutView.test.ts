import { describe, expect, it } from "vitest";
import { earlySignOutProblem } from "@figbloom/shared";
import { absentSignOutWarning, authorisedByText, noteText, signOutPickerLabel, COLLECTOR_RESTRICTED_TEXT, collectorContactText, collectorLine, emptySignOutDraft, leftEarlyLabel, liveSignOutRows, voidReasonText } from "./earlySignOutView";

describe("early sign-out view helpers (FIG-1513 stage A)", () => {
  it("shows the ID number and phone only when the database returned them", () => {
    expect(collectorContactText({ sign_out_id: "a", id_number: "12345678", phone: "0712 345 678", authorised_by: "Deputy head", note: null, void_reason: null })).toBe("ID number 12345678 · phone 0712 345 678");
    expect(collectorContactText(undefined)).toBe(COLLECTOR_RESTRICTED_TEXT);
    expect(collectorContactText(null)).toBe(COLLECTOR_RESTRICTED_TEXT);
  });

  it("never shows an empty value for a blank detail", () => {
    expect(collectorContactText({ sign_out_id: "a", id_number: "", phone: "", authorised_by: "Deputy head", note: null, void_reason: null })).toBe(COLLECTOR_RESTRICTED_TEXT);
  });

  it("words the collector and the time", () => {
    expect(collectorLine({ collected_by_name: "Wanjiru Kamau", collected_by_relationship: "mother" })).toBe("Wanjiru Kamau (mother)");
    expect(leftEarlyLabel({ signed_out_local: "10:45:12" })).toBe("Left early at 10:45");
  });

  it("shows who authorised it and the note only when the database returned them", () => {
    const d = { sign_out_id: "a", id_number: "1", phone: "2", authorised_by: "Deputy head", note: "Dentist", void_reason: null };
    expect(authorisedByText(d)).toBe("Deputy head");
    expect(authorisedByText(undefined)).toBe("restricted");
    expect(noteText(d)).toBe("Dentist");
    expect(noteText({ ...d, note: null })).toBeNull();
    expect(noteText(undefined)).toBe("restricted");
  });

  it("shows the void reason only when the database returned it", () => {
    const d = { sign_out_id: "a", id_number: "1", phone: "2", authorised_by: "Deputy head", note: null, void_reason: "Wrong learner" };
    expect(voidReasonText(d)).toBe("Wrong learner");
    expect(voidReasonText({ ...d, void_reason: null })).toBe("restricted");
    expect(voidReasonText({ ...d, void_reason: "  " })).toBe("restricted");
    expect(voidReasonText(undefined)).toBe("restricted");
    expect(voidReasonText(null)).toBe("restricted");
  });

  it("warns only when the learner is marked absent", () => {
    expect(absentSignOutWarning("Amina", "absent")).toBe("Amina is marked absent today. A sign-out records that they left school: check this is the right learner.");
    for (const m of ["present", "late", "excused", null, undefined] as const) expect(absentSignOutWarning("Amina", m)).toBeNull();
  });

  it("labels the picker with the latest sign-out time and never says ADM", () => {
    expect(signOutPickerLabel("Amina", "123", null)).toBe("Amina · 123");
    expect(signOutPickerLabel("Amina", "123", { signed_out_local: "10:45:12" })).toBe("Amina · 123 (signed out 10:45)");
    expect(signOutPickerLabel("Amina", "123", { signed_out_local: "10:45:12" })).not.toContain("ADM ");
  });

  it("starts as a blank draft that is not yet valid, with every collector field required", () => {
    const d = emptySignOutDraft("s1");
    expect(d.student_id).toBe("s1");
    expect(earlySignOutProblem(d)).not.toBeNull();
    expect(earlySignOutProblem({
      ...d, reason: "Dentist", authorised_by: "Deputy head", collected_by_name: "Wanjiru Kamau", collected_by_relationship: "mother",
      collected_by_id_number: "12345678", collected_by_phone: "0712345678",
    })).toBeNull();
  });

  it("lists every live sign-out in time order, voided ones left out", () => {
    const r = (id: string, at: string, voided: string | null) => ({ id, student_id: "s1", signed_out_at: at, voided_at: voided }) as never;
    const rows = [r("c", "2026-11-06T12:00:00Z", null), r("a", "2026-11-06T08:00:00Z", null), r("v", "2026-11-06T09:00:00Z", "2026-11-06T09:30:00Z")];
    expect(liveSignOutRows(rows).map((x) => x.id)).toEqual(["a", "c"]);
    expect(liveSignOutRows([])).toEqual([]);
  });
});
