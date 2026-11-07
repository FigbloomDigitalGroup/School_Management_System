import { beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the Supabase client that records the leave update and the notice, and can refuse either. */
const updates: { table: string; patch: Record<string, unknown>; id: unknown }[] = [];
const inserts: { table: string; row: Record<string, unknown> }[] = [];
const refuse: { update: string | null; insert: string | null } = { update: null, insert: null };

vi.mock("./supabase", () => ({
  supabase: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => { updates.push({ table, patch, id }); return Promise.resolve({ error: refuse.update ? { message: refuse.update } : null }); },
      }),
      insert: (row: Record<string, unknown>) => { inserts.push({ table, row }); return Promise.resolve({ error: refuse.insert ? { message: refuse.insert } : null }); },
    }),
  }),
}));

import { decideLeaveRequest, LEAVE_STATUS_LABEL, LEAVE_STATUS_TONE, splitLeaveRequests, type LeaveStatus } from "./leave";

const request = { id: "lr-1", teacher_id: "t-ann", starts_on: "2026-11-09", ends_on: "2026-11-11" };

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  refuse.update = null;
  refuse.insert = null;
});

describe("how a leave request reads", () => {
  it("has words and a tone for every status", () => {
    const statuses: LeaveStatus[] = ["pending", "approved", "rejected", "cancelled"];
    expect(statuses.map((s) => LEAVE_STATUS_LABEL[s])).toEqual(["Awaiting review", "Approved", "Rejected", "Cancelled"]);
    expect(statuses.map((s) => LEAVE_STATUS_TONE[s])).toEqual(["warn", "ok", "muted", "muted"]);
  });

  it("puts what awaits review apart from what has been reviewed or withdrawn, keeping their order", () => {
    const rows = [{ id: "a", status: "approved" }, { id: "b", status: "pending" }, { id: "c", status: "cancelled" }, { id: "d", status: "pending" }, { id: "e", status: "rejected" }] as const;
    const { pending, decided } = splitLeaveRequests(rows);
    expect(pending.map((r) => r.id)).toEqual(["b", "d"]);
    expect(decided.map((r) => r.id)).toEqual(["a", "c", "e"]);
  });
});

describe("decideLeaveRequest", () => {
  it("records the decision with who made it, and tells the teacher in the app that it was approved", async () => {
    const out = await decideLeaveRequest({ tenantId: "school-1", reviewerId: "admin-1", request, status: "approved", note: "  Cover arranged with Dan  " });
    expect(out).toEqual({ notifyError: null });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ table: "leave_requests", id: "lr-1", patch: { status: "approved", reviewed_by: "admin-1", review_note: "Cover arranged with Dan" } });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe("announcements");
    expect(inserts[0]?.row).toMatchObject({
      tenant_id: "school-1", author_id: "admin-1", subject: "Your leave request was approved", audience: { kind: "user", user_id: "t-ann" }, channels: ["in_app"],
    });
    expect(inserts[0]?.row.body).toBe("Your leave from 9 Nov to 11 Nov has been approved. Note: Cover arranged with Dan");
  });

  it("says it was not approved when it was rejected, with no note when there is none", async () => {
    await decideLeaveRequest({ tenantId: "school-1", reviewerId: "admin-1", request, status: "rejected", note: "   " });
    expect(updates[0]?.patch).toMatchObject({ status: "rejected", review_note: null });
    expect(inserts[0]?.row.subject).toBe("Your leave request was not approved");
    expect(inserts[0]?.row.body).toBe("Your leave from 9 Nov to 11 Nov was not approved.");
  });

  it("fails, and tells nobody, when the decision cannot be recorded", async () => {
    refuse.update = "new row violates row-level security policy";
    await expect(decideLeaveRequest({ tenantId: "school-1", reviewerId: "admin-1", request, status: "approved", note: "" })).rejects.toThrow("new row violates row-level security policy");
    expect(inserts).toEqual([]);
  });

  it("keeps the decision and says why the teacher was not told when only the notice fails", async () => {
    refuse.insert = "could not publish";
    const out = await decideLeaveRequest({ tenantId: "school-1", reviewerId: "admin-1", request, status: "approved", note: "" });
    expect(out).toEqual({ notifyError: "could not publish" });
    expect(updates).toHaveLength(1);
  });
});
