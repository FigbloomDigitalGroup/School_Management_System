import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { leaveCapabilities } from "../capabilities";
import { fetchHrLeaveAccess } from "../hrLeave";
import {
  cancelLeaveRequest, decideLeaveRequest, fetchAllLeaveRequests, fetchMyLeaveRequests, requestLeave, reviewLeaveRequest,
} from "../leave";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { API_LEAVE_REASON_MIN, leaveRequestFromApi, leaveStatusFromApi } from "./leaveApi";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const U_TEACHER = "22222222-2222-4222-8222-222222222222";
const U_OTHER = "33333333-3333-4333-8333-333333333333";
const U_ADMIN = "44444444-4444-4444-8444-444444444444";
const L1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const L2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const L3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const A1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

const apiLeave = (o: Record<string, unknown> = {}) => ({
  id: L1,
  tenant_id: T,
  staff_user_id: U_TEACHER,
  start_on: "2026-12-01",
  end_on: "2026-12-03",
  reason: "Family wedding",
  status: "pending",
  reviewed_by: null,
  reviewed_at: null,
  review_note: null,
  created_at: "2026-11-24T08:00:00Z",
  ...o,
});

const apiStaff = (o: Record<string, unknown> = {}) => ({
  id: "s1111111-1111-4111-8111-111111111111",
  tenantId: T,
  full_name: "David Kamau",
  staff_title: "Senior Mathematics Teacher",
  classification: "teacher",
  phone: null,
  email: "teacher@alliance.sc.ke",
  userId: U_TEACHER,
  active: true,
  archived_at: null,
  created_at: "2026-11-20T08:00:00Z",
  updated_at: "2026-11-20T08:00:00Z",
  ...o,
});

let api: FakeApi;
const P = `/v1/tenants/${T}`;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U_ADMIN }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("capabilities & mappers", () => {
  it("keeps HR staff applications off on API while enabling the approvals page", () => {
    initBackend({ kind: "supabase" });
    expect(leaveCapabilities()).toEqual({ hrLeave: true, optionalReason: true });
    initBackend({ kind: "api", apiUrl: BASE });
    expect(leaveCapabilities()).toEqual({ hrLeave: false, optionalReason: false });
  });

  it("maps declined to rejected and leaves other statuses unchanged", () => {
    expect(leaveStatusFromApi("pending")).toBe("pending");
    expect(leaveStatusFromApi("approved")).toBe("approved");
    expect(leaveStatusFromApi("declined")).toBe("rejected");
    expect(leaveStatusFromApi("cancelled")).toBe("cancelled");
  });

  it("maps an API leave request to the shared LeaveRequest shape", () => {
    expect(leaveRequestFromApi(apiLeave({
      status: "declined",
      reviewed_by: U_ADMIN,
      reviewed_at: "2026-11-24T10:00:00Z",
      review_note: "Exam week",
    }) as never)).toEqual({
      id: L1,
      teacher_id: U_TEACHER,
      starts_on: "2026-12-01",
      ends_on: "2026-12-03",
      reason: "Family wedding",
      status: "rejected",
      reviewed_by: U_ADMIN,
      reviewed_at: "2026-11-24T10:00:00Z",
      review_note: "Exam week",
      created_at: "2026-11-24T08:00:00Z",
      source: "schools",
    });
  });

  it("reads HR leave access from the API", async () => {
    boot({ [`GET ${P}/me/hr/leave/access`]: { body: { status: "off", approver: true } } });
    expect(await fetchHrLeaveAccess()).toEqual({ status: "off", approver: true });
    expect(api.calls).toHaveLength(1);
  });
});

describe("fetchMyLeaveRequests on API", () => {
  it("paginates, keeps only the teacher's own requests, and sorts newest start date first", async () => {
    let calls = 0;
    boot({
      [`GET ${P}/leave-requests`]: () => {
        calls += 1;
        if (calls === 1) {
          return list("leave_requests", [
            apiLeave({ id: L1, staff_user_id: U_TEACHER, start_on: "2026-11-26", end_on: "2026-11-27" }),
            apiLeave({ id: L2, staff_user_id: U_OTHER, start_on: "2026-12-10", end_on: "2026-12-12" }),
          ], "cursor-2");
        }
        return list("leave_requests", [
          apiLeave({ id: L3, staff_user_id: U_TEACHER, start_on: "2026-12-05", end_on: "2026-12-06", status: "declined" }),
        ]);
      },
    });

    const rows = await fetchMyLeaveRequests(U_TEACHER);
    expect(calls).toBe(2);
    expect(rows.map((r) => [r.id, r.starts_on, r.status])).toEqual([
      [L3, "2026-12-05", "rejected"],
      [L1, "2026-11-26", "pending"],
    ]);
  });
});

describe("requestLeave and cancelLeaveRequest on API", () => {
  it("trims the reason and posts start_on, end_on and reason", async () => {
    boot({
      [`POST ${P}/leave-requests`]: { status: 201, body: { leave_request: apiLeave() } },
    });

    await requestLeave({
      tenantId: T,
      teacherId: U_TEACHER,
      startsOn: "2026-12-01",
      endsOn: "2026-12-03",
      reason: "  Family wedding  ",
    });

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.body).toEqual({
      start_on: "2026-12-01",
      end_on: "2026-12-03",
      reason: "Family wedding",
    });
  });

  it("refuses a blank or too-short reason before calling the API", async () => {
    boot({});
    await expect(requestLeave({
      tenantId: T,
      teacherId: U_TEACHER,
      startsOn: "2026-12-01",
      endsOn: "2026-12-03",
      reason: "  hi  ",
    })).rejects.toThrow(`at least ${API_LEAVE_REASON_MIN} characters`);
    expect(api.calls).toHaveLength(0);
  });

  it("surfaces overlap conflicts from the API", async () => {
    boot({
      [`POST ${P}/leave-requests`]: refused("conflict", 409, "Leave dates overlap an existing request"),
    });

    await expect(requestLeave({
      tenantId: T,
      teacherId: U_TEACHER,
      startsOn: "2026-12-01",
      endsOn: "2026-12-03",
      reason: "Medical checkup",
    })).rejects.toThrow("Leave dates overlap an existing request");
  });

  it("cancels a pending leave request with a bodyless POST", async () => {
    boot({
      [`POST ${P}/leave-requests/${L1}/cancel`]: { status: 200, body: { leave_request: apiLeave({ status: "cancelled" }) } },
    });

    await cancelLeaveRequest(L1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.method).toBe("POST");
    expect(api.calls[0]?.path).toBe(`${P}/leave-requests/${L1}/cancel`);
    expect(api.calls[0]?.body).toBeUndefined();
  });
});

describe("fetchAllLeaveRequests on API", () => {
  it("resolves teacher names from the staff directory and falls back to Unknown teacher", async () => {
    boot({
      [`GET ${P}/leave-requests`]: list("leave_requests", [
        apiLeave({ id: L1, staff_user_id: U_TEACHER }),
        apiLeave({ id: L2, staff_user_id: U_OTHER, status: "declined" }),
      ]),
      [`GET ${P}/staff`]: list("staff", [
        apiStaff({ userId: U_TEACHER, full_name: "David Kamau" }),
        apiStaff({ id: "s2222222-2222-4222-8222-222222222222", userId: null, full_name: "Unlinked Staff" }),
      ]),
    });

    const rows = await fetchAllLeaveRequests(T);
    expect(rows.map((r) => [r.id, r.teacherName, r.status])).toEqual([
      [L1, "David Kamau", "pending"],
      [L2, "Unknown teacher", "rejected"],
    ]);
  });

  it("tolerates 403 on /staff for a leave-only reviewer", async () => {
    boot({
      [`GET ${P}/leave-requests`]: list("leave_requests", [apiLeave({ id: L1, staff_user_id: U_TEACHER })]),
      [`GET ${P}/staff`]: refused("forbidden", 403, "missing resource.staff.read"),
    });

    const rows = await fetchAllLeaveRequests(T);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.teacherName).toBe("Unknown teacher");
  });
});

describe("reviewLeaveRequest and decideLeaveRequest on API", () => {
  const req = { id: L1, teacher_id: U_TEACHER, starts_on: "2026-11-09", ends_on: "2026-11-11" };

  it("maps rejected to declined and sends trimmed review_note", async () => {
    boot({
      [`POST ${P}/leave-requests/${L1}/review`]: { status: 200, body: { leave_request: apiLeave({ status: "declined" }) } },
    });

    await reviewLeaveRequest(L1, U_ADMIN, "rejected", "  Exam week  ");
    expect(api.calls[0]?.body).toEqual({ status: "declined", review_note: "Exam week" });
  });

  it("reviews, creates, and publishes an in-app user announcement when approving", async () => {
    boot({
      [`POST ${P}/leave-requests/${L1}/review`]: { status: 200, body: { leave_request: apiLeave({ status: "approved" }) } },
      [`POST ${P}/communications/announcements`]: {
        status: 201,
        body: {
          announcement: {
            id: A1, tenant_id: T, author_id: U_ADMIN, subject: "Your leave request was approved",
            body: "Your leave from 9 Nov to 11 Nov has been approved. Note: Cover arranged",
            audience: { kind: "user", user_id: U_TEACHER }, channels: ["in_app"],
            published_at: null, created_at: "2026-11-24T09:00:00Z",
          },
        },
      },
      [`POST ${P}/communications/announcements/${A1}/publish`]: { status: 200, body: { announcement: { id: A1 } } },
    });

    const out = await decideLeaveRequest({
      tenantId: T, reviewerId: U_ADMIN, request: req, status: "approved", note: "  Cover arranged  ",
    });
    expect(out).toEqual({ notifyError: null });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${P}/leave-requests/${L1}/review`,
      `POST ${P}/communications/announcements`,
      `POST ${P}/communications/announcements/${A1}/publish`,
    ]);
    expect(api.calls[0]?.body).toEqual({ status: "approved", review_note: "Cover arranged" });
    expect(api.calls[1]?.body).toEqual({
      subject: "Your leave request was approved",
      body: "Your leave from 9 Nov to 11 Nov has been approved. Note: Cover arranged",
      audience: { kind: "user", user_id: U_TEACHER },
      channels: ["in_app"],
    });
  });

  it("throws and sends no announcement when the review itself is refused", async () => {
    boot({
      [`POST ${P}/leave-requests/${L1}/review`]: refused("forbidden", 403, "A staff member cannot review their own leave"),
    });

    await expect(decideLeaveRequest({
      tenantId: T, reviewerId: U_TEACHER, request: req, status: "approved", note: "",
    })).rejects.toThrow("A staff member cannot review their own leave");
    expect(api.calls).toHaveLength(1);
  });

  it("keeps the decision and returns notifyError when only the announcement fails", async () => {
    boot({
      [`POST ${P}/leave-requests/${L1}/review`]: { status: 200, body: { leave_request: apiLeave({ status: "declined" }) } },
      [`POST ${P}/communications/announcements`]: refused("forbidden", 403, "missing resource.announcement.write"),
    });

    const out = await decideLeaveRequest({
      tenantId: T, reviewerId: U_ADMIN, request: req, status: "rejected", note: "",
    });
    expect(out.notifyError).toBeTruthy();
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${P}/leave-requests/${L1}/review`,
      `POST ${P}/communications/announcements`,
    ]);
  });
});
