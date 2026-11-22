import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toClientError } from "../src/http/errors.js";
import { isRealCalendarDate } from "../src/http/schemas.js";
import { createTestApp } from "./support.js";

/**
 * Workstream 4: ONE calendar-date validator. The shape regex accepted 2026-02-31 on most routes and PostgreSQL then rejected it
 * with a data exception (mapped differently by different paths). Impossible dates are refused up front with a 400 and are never
 * normalised into a different date. Also pins the database-error safety net and the callback error envelope.
 */
describe("calendar date validation (workstream 4)", () => {
  it("isRealCalendarDate: month ends, leap years, century rules, shape", () => {
    const ok = ["2026-01-31", "2026-02-28", "2024-02-29", "2000-02-29", "2026-04-30", "2026-12-31", "0001-01-01", "9999-12-31"];
    const bad = ["2026-02-29", "2026-02-30", "2026-02-31", "2100-02-29", "1900-02-29", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31",
      "2026-00-10", "2026-13-01", "2026-01-00", "2026-1-01", "26-01-01", "2026-01-01T00:00:00Z", " 2026-01-01", "2026-01-01 ", "", "not-a-date", "0000-01-01"];
    for (const d of ok) expect(isRealCalendarDate(d), d).toBe(true);
    for (const d of bad) expect(isRealCalendarDate(d), d).toBe(false);
  });

  describe("on the wire", () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let admin: string;
    beforeAll(async () => {
      ctx = await createTestApp();
      const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } });
      admin = r.json().token as string;
    }, 120_000);
    afterAll(async () => {
      await ctx.app.close();
      await ctx.pool.end();
    });
    const A = () => ctx.ids.tenantA;
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
      ctx.app.inject({ method, url, headers: { authorization: `Bearer ${admin}`, "x-tenant-id": A() }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    const uuid = "00000000-0000-4000-8000-0000000000aa";
    const T = () => `/v1/tenants/${A()}`;

    const cases: [string, () => Promise<{ statusCode: number; json: () => any }>][] = [
      ["learner date_of_birth", () => call("POST", `${T()}/learners`, { admission_no: "DT-1", full_name: "Date Test", gender: "female", date_of_birth: "2026-02-31" })],
      ["billing run due_on", () => call("POST", `${T()}/finance/billing-runs`, { term_id: uuid, due_on: "2026-02-31" })],
      ["invoice due date", () => call("PUT", `${T()}/finance/invoices/${uuid}/due-date`, { due_on: "2026-04-31" })],
      ["academic year starts_on", () => call("POST", `${T()}/academic-years`, { label: "DT", starts_on: "2026-02-30", ends_on: "2026-12-31" })],
      ["academic year ends_on", () => call("POST", `${T()}/academic-years`, { label: "DT", starts_on: "2026-01-01", ends_on: "2026-06-31" })],
      ["attendance register taken_on", () => call("POST", `${T()}/attendance-registers`, { class_id: uuid, session: "morning", taken_on: "2026-02-31", entries: [] })],
      ["attendance register query takenOn", () => call("GET", `${T()}/attendance-registers?takenOn=2026-04-31`)],
      ["leave start_on", () => call("POST", `${T()}/leave-requests`, { start_on: "2026-02-30", end_on: "2026-03-01", reason: "Family matter" })],
      ["leave end_on", () => call("POST", `${T()}/leave-requests`, { start_on: "2026-03-01", end_on: "2026-09-31", reason: "Family matter" })],
      ["report date", () => call("GET", `${T()}/reports/attendance-daily?date=2026-11-31`)],
      ["inventory due_on", () => call("POST", `${T()}/inventory/issues`, { item_id: uuid, quantity: 1, due_on: "2026-02-31" })],
    ];
    for (const [name, run] of cases) {
      it(`${name}: an impossible calendar date is a 400 validation error, never a 5xx or a silent roll-over`, async () => {
        const res = await run();
        expect(res.statusCode, `${name} -> ${res.statusCode} ${JSON.stringify(res.json())}`).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
        expect(JSON.stringify(res.json())).not.toMatch(/22008|out of range|syntax|pg_|SELECT/i);
      });
    }

    it("a real date on the same learner route is accepted (the validator is not over-strict) and leap day round-trips unchanged", async () => {
      const res = await call("POST", `${T()}/learners`, { admission_no: "DT-LEAP", full_name: "Leap Test", gender: "male", date_of_birth: "2012-02-29" });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
      expect(res.json().learner.date_of_birth).toBe("2012-02-29");
    });
  });
});

describe("database errors are never an opaque 500 when the client caused them (errors.ts safety net)", () => {
  const dbErr = (code: string) => Object.assign(new Error("duplicate key value violates unique constraint \"secret_table_secret_idx\""), { code });
  it.each([
    ["23505", 409, "conflict"],
    ["23503", 409, "conflict"],
    ["23P01", 409, "conflict"],
    ["55000", 409, "conflict"],
    ["42501", 403, "forbidden"],
    ["P0002", 404, "not_found"],
    ["22008", 400, "validation_error"],
    ["22P02", 400, "validation_error"],
    ["23514", 400, "validation_error"],
  ])("SQLSTATE %s -> %i %s with a generic message", (code, status, errCode) => {
    const r = toClientError(dbErr(code));
    expect(r.statusCode).toBe(status);
    expect(r.body.error.code).toBe(errCode);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|constraint|violates|table/i);
  });
  it("an unexpected error (an invariant, a programming error) stays an opaque 500", () => {
    const r = toClientError(new Error("insert returned no row"));
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("insert returned");
    expect(toClientError(Object.assign(new Error("x"), { code: "XX000" })).statusCode).toBe(500);
  });
});
