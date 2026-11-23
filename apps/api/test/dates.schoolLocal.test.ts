import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateLearnerFields } from "../src/modules/directory/learners.js";
import { createTestApp } from "./support.js";

/**
 * Residual closure workstream 5: school-LOCAL date boundaries.
 *
 * The model (verified here): calendar dates are date-only values (DATE columns, `YYYY-MM-DD` on the wire, `::text` in SELECT lists);
 * instants are timestamptz (UTC on the wire); "today" for any school rule is the SCHOOL's local date, derived from
 * tenants.timezone (default Africa/Nairobi) with \`(now() AT TIME ZONE tz)::date\` — never the server's UTC date or the database
 * session's CURRENT_DATE. Defects found and fixed by this audit: the learner date-of-birth "in the future" check used the UTC date;
 * activity members' \`joined_on\` defaulted to the database session's CURRENT_DATE; learners.ts read a pg DATE with UTC parts.
 */
describe("school-local date rules", () => {
  describe("validateLearnerFields (pure): date of birth against the school's today", () => {
    const base = { admission_no: "A1", full_name: "N", gender: "male" };
    const dob = (d: string, today?: string) => validateLearnerFields({ ...base, date_of_birth: d, ...(today ? { today } : {}) });
    it("accepts today and earlier, refuses tomorrow, at month, year and leap boundaries", () => {
      expect(dob("2026-06-01", "2026-06-01").valid).toBe(true);
      expect(dob("2026-06-02", "2026-06-01").valid).toBe(false);
      expect(dob("2026-06-02", "2026-06-01").messages.join()).toMatch(/future/);
      expect(dob("2026-12-31", "2027-01-01").valid).toBe(true); // year boundary: yesterday
      expect(dob("2027-01-01", "2027-01-01").valid).toBe(true);
      expect(dob("2027-01-02", "2027-01-01").valid).toBe(false);
      expect(dob("2028-02-29", "2028-02-29").valid).toBe(true); // leap day
      expect(dob("2028-03-01", "2028-02-29").valid).toBe(false);
      expect(dob("2027-02-29", "2027-03-01").valid).toBe(false); // not a real date
      expect(dob("2026-01-31", "2026-02-01").valid).toBe(true);
    });
    it("the school's date decides, not the UTC date: the same birth date is valid or not depending on the school's today", () => {
      // a school whose local date has already moved on (ahead of UTC) versus one that has not (behind UTC)
      expect(dob("2026-06-02", "2026-06-02").valid).toBe(true);
      expect(dob("2026-06-02", "2026-06-01").valid).toBe(false);
    });
  });

  describe("on the database", () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let admin: string;
    beforeAll(async () => {
      ctx = await createTestApp();
      admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token as string;
    }, 120_000);
    afterAll(async () => {
      await ctx.app.close();
      await ctx.pool.end();
    });
    const A = () => ctx.ids.tenantA;
    const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
      ctx.app.inject({ method, url, headers: { authorization: `Bearer ${admin}`, "x-tenant-id": A() }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    const setTz = (tz: string) => ctx.pool.query(`UPDATE tenants SET timezone = $2 WHERE id = $1`, [A(), tz]);
    const localDate = (tz: string, at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    const utcDate = () => new Date().toISOString().slice(0, 10);

    it("the platform contract at fixed instants: school-local dates across midnight, year, leap and daylight-saving boundaries", async () => {
      const q = async (ts: string, tz: string) => (await ctx.pool.query(`SELECT ((timestamptz '${ts}') AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0].d as string;
      // Nairobi (UTC+3, no DST): local midnight is 21:00 UTC
      expect(await q("2026-06-30 20:59:59+00", "Africa/Nairobi")).toBe("2026-06-30");
      expect(await q("2026-06-30 21:00:00+00", "Africa/Nairobi")).toBe("2026-07-01");
      expect(await q("2026-12-31 21:00:00+00", "Africa/Nairobi")).toBe("2027-01-01"); // year boundary
      expect(await q("2028-02-28 21:00:00+00", "Africa/Nairobi")).toBe("2028-02-29"); // leap day starts
      expect(await q("2028-02-29 21:00:00+00", "Africa/Nairobi")).toBe("2028-03-01");
      expect(await q("2027-02-28 21:00:00+00", "Africa/Nairobi")).toBe("2027-03-01"); // non-leap
      // New York: spring forward 2026-03-08 07:00 UTC, fall back 2026-11-01 06:00 UTC; the calendar day never skips or repeats
      expect(await q("2026-03-08 06:59:59+00", "America/New_York")).toBe("2026-03-08");
      expect(await q("2026-03-08 07:00:00+00", "America/New_York")).toBe("2026-03-08");
      expect(await q("2026-03-09 03:59:59+00", "America/New_York")).toBe("2026-03-08"); // 23:59:59 EDT
      expect(await q("2026-03-09 04:00:00+00", "America/New_York")).toBe("2026-03-09");
      expect(await q("2026-11-01 05:30:00+00", "America/New_York")).toBe("2026-11-01"); // 01:30 EDT
      expect(await q("2026-11-01 06:30:00+00", "America/New_York")).toBe("2026-11-01"); // 01:30 EST (repeated hour)
      expect(await q("2026-11-02 04:59:59+00", "America/New_York")).toBe("2026-11-01");
      expect(await q("2026-11-02 05:00:00+00", "America/New_York")).toBe("2026-11-02");
      // Europe/London and Pacific/Auckland (southern-hemisphere summer time), Asia/Kolkata (half-hour offset)
      expect(await q("2026-03-29 00:59:59+00", "Europe/London")).toBe("2026-03-29");
      expect(await q("2026-03-29 23:00:00+00", "Europe/London")).toBe("2026-03-30"); // BST: local midnight is 23:00 UTC
      expect(await q("2026-12-31 11:00:00+00", "Pacific/Auckland")).toBe("2027-01-01"); // NZDT = UTC+13
      expect(await q("2026-12-31 18:29:59+00", "Asia/Kolkata")).toBe("2026-12-31");
      expect(await q("2026-12-31 18:30:00+00", "Asia/Kolkata")).toBe("2027-01-01");
    });

    it("schoolToday (the TypeScript twin) equals the school's local date for many timezones and differs from the UTC date where it must", async () => {
      const { schoolToday } = await import("../src/modules/tenancy/schoolClock.js");
      const { withSystemTenantTransaction } = await import("../src/db/systemTenantTransaction.js");
      for (const tz of ["Africa/Nairobi", "UTC", "America/New_York", "Europe/London", "Asia/Kolkata", "Pacific/Auckland", "Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
        await setTz(tz);
        const got = await withSystemTenantTransaction(ctx.runtimePool, { tenantId: A(), userId: ctx.ids.adminA }, (tx) => schoolToday(tx, A()));
        expect(got, tz).toBe(localDate(tz));
      }
      await setTz("Africa/Nairobi");
      // unknown timezone rows are impossible (validated by 023); a missing school falls back to the platform default
      const fallback = await ctx.pool.query(`SELECT (now() AT TIME ZONE COALESCE((SELECT timezone FROM tenants WHERE id = $1), 'Africa/Nairobi'))::date::text AS d`, [randomUUID()]);
      expect(fallback.rows[0].d).toBe(localDate("Africa/Nairobi"));
    });

    it("API: a date of birth equal to the SCHOOL's today is accepted and one day later is refused, whatever the UTC date is", async () => {
      // choose zones whose local date currently differs from the UTC date (one of the two always exists)
      const behind = ["Pacific/Pago_Pago", "Pacific/Midway", "America/Anchorage"].find((z) => localDate(z) < utcDate());
      const ahead = ["Pacific/Kiritimati", "Pacific/Auckland", "Asia/Tokyo"].find((z) => localDate(z) > utcDate());
      expect(behind ?? ahead, "no zone with a different local date from UTC exists right now").toBeTruthy();
      let n = 0;
      const create = (dobValue: string) => call("POST", `/v1/tenants/${A()}/learners`, { admission_no: `TZ-${randomUUID().slice(0, 6)}-${++n}`, full_name: "Zone Test", gender: "female", date_of_birth: dobValue });
      try {
        if (behind) {
          await setTz(behind);
          const local = localDate(behind); // earlier than the UTC date
          const tomorrowLocal = utcDate(); // is "in the future" for this school although it is "today" in UTC
          expect((await create(local)).statusCode).toBe(201);
          const r = await create(tomorrowLocal);
          expect(r.statusCode, `${behind}: ${tomorrowLocal} is after the school's today ${local}`).toBe(400);
          expect(r.json().error.message).toMatch(/future/);
        }
        if (ahead) {
          await setTz(ahead);
          const local = localDate(ahead); // later than the UTC date
          expect((await create(local)).statusCode, `${ahead}: the school's own today must be accepted`).toBe(201);
          const next = new Date(Date.parse(local + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
          expect((await create(next)).statusCode).toBe(400);
        }
      } finally {
        await setTz("Africa/Nairobi");
      }
    });

    it("API: CSV import judges date of birth against the school's today too (preview and apply)", async () => {
      const behind = ["Pacific/Pago_Pago", "Pacific/Midway"].find((z) => localDate(z) < utcDate());
      if (!behind) return; // only meaningful while the UTC date is ahead of some zone; covered by the pure and API tests otherwise
      await setTz(behind);
      try {
        const csv = `admission_no,full_name,gender,date_of_birth\nCS-${randomUUID().slice(0, 6)},Local Today,female,${localDate(behind)}\nCS-${randomUUID().slice(0, 6)},UTC Today,male,${utcDate()}\n`;
        const r = await call("POST", `/v1/tenants/${A()}/imports/learners/preview`, { csv });
        expect(r.statusCode, r.body).toBe(200);
        const body = r.json();
        expect(body.preview?.valid_count ?? body.valid_count).toBe(1);
        expect(JSON.stringify(body)).toMatch(/future/);
      } finally {
        await setTz("Africa/Nairobi");
      }
    });

    it("activity members join on the SCHOOL's date, not the database session date", async () => {
      const zone = ["Pacific/Pago_Pago", "Pacific/Midway", "Pacific/Kiritimati", "Pacific/Auckland"].find((z) => localDate(z) !== utcDate());
      expect(zone, "a zone with a different local date from UTC must exist").toBeTruthy();
      await setTz(zone!);
      try {
        const act = await call("POST", `/v1/tenants/${A()}/activities`, { name: "Zone Club " + randomUUID().slice(0, 4), category: "club" });
        expect(act.statusCode, act.body).toBe(201);
        const learner = (await ctx.pool.query(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Zone Member', 'male') RETURNING id`, [A(), "ZM" + randomUUID().slice(0, 6)])).rows[0].id as string;
        const add = await call("POST", `/v1/tenants/${A()}/activities/${act.json().activity.id}/members`, { learner_id: learner });
        expect(add.statusCode, add.body).toBe(204);
        const row = (await ctx.pool.query(`SELECT joined_on::text AS d, current_date::text AS db_today FROM activity_members WHERE learner_id = $1`, [learner])).rows[0];
        expect(row.d).toBe(localDate(zone!));
        if (row.db_today !== localDate(zone!)) expect(row.d).not.toBe(row.db_today); // not the database session's CURRENT_DATE
      } finally {
        await setTz("Africa/Nairobi");
      }
    });
  });
});
