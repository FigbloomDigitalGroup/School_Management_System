import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryTokenStore, initBackend, resetApiClient, setApiActiveTenant, setApiTokenStore } from "@figbloom/shared";
import { csvTemplate, ignoredImportColumns, importStudents, parseStudentCsv, type ParseContext } from "./studentImport";

/**
 * The learner CSV import on a build for the new API. The screen parses and checks the file as it always did; what changes is that home and
 * health columns are left alone (the API keeps neither), the template has only the columns the API keeps, and importing goes through the
 * API's own check and then places each learner in their class (shared/api/peopleApi.ts apiImportLearners, tested there).
 */

const T = "11111111-1111-4111-8111-111111111111";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const CLASSES = new Map([["form 1 east", C1], ["form 2 east", "c2"]]);
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({ classIdByName: CLASSES, existingAdmissionNos: new Set(), ...over });
const FULL = [
  "admission_no,full_name,gender,class,boarding,date_of_birth,home_address,allergies,health_consent_signed_by",
  "4501,Wanjiku Kamau,female,Form 1 East,yes,2010-03-14,Plot 12,Peanuts,",
].join("\n");

afterEach(() => { vi.unstubAllGlobals(); resetApiClient(); initBackend({ kind: "supabase" }); });

describe("a file with home and health columns, on a backend that keeps neither", () => {
  it("is still checked for what the backend keeps, and the extra columns raise no errors", () => {
    // allergies with no consent form is a row error on Supabase, and not a reason to stop a row when nothing would be saved
    const [withExtras] = parseStudentCsv(FULL, ctx());
    expect(withExtras!.errors).toEqual(["Allergies and conditions need the family's consent form: health_consent_signed_by and health_consent_date."]);
    const [r] = parseStudentCsv(FULL, ctx({ skipExtras: true }));
    expect(r).toMatchObject({ admission_no: "4501", full_name: "Wanjiku Kamau", gender: "female", className: "Form 1 East", boarding: true, errors: [], home_address: null, allergies: [], health_consent: null });
  });

  it("still reports every problem with the columns it does keep", () => {
    const [r] = parseStudentCsv("admission_no,full_name,gender,class\n,,x,Nowhere", ctx({ skipExtras: true }));
    expect(r!.errors).toEqual(["Missing admission number.", "Missing name.", '"x" isn\'t male or female.', '"Nowhere" is not one of this school\'s classes.']);
  });

  it("lists the optional columns the file has, so the person is told they are left out", () => {
    expect(ignoredImportColumns(FULL)).toEqual(["home_address", "allergies", "health_consent_signed_by"]);
    expect(ignoredImportColumns("admission_no,full_name,gender,class")).toEqual([]);
    expect(ignoredImportColumns("")).toEqual([]);
    expect(ignoredImportColumns("\n\nADMISSION_NO,Home_Address\n1,x")).toEqual(["home_address"]);
  });
});

describe("the template", () => {
  it("has the home and health columns on Supabase, and only the columns the API keeps on the API", () => {
    initBackend({ kind: "supabase" });
    expect(csvTemplate().split("\n")[0]).toContain("home_address");
    initBackend({ kind: "api", apiUrl: "https://api.test" });
    const t = csvTemplate();
    expect(t.split("\n")[0]).toBe("admission_no,full_name,gender,class,boarding,date_of_birth");
    // and it imports clean, once its classes exist
    const rows = parseStudentCsv(t, ctx({ skipExtras: true, classIdByName: new Map([["form 2 east", "c2"]]) }));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.errors)).toEqual([[], []]);
  });
});

describe("importing on the API", () => {
  /** A stand-in API: answers by "METHOD path", and records what it was sent. */
  function fakeApi(routes: Record<string, (body: unknown) => unknown>) {
    const sent: { key: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const key = `${(init?.method ?? "GET").toUpperCase()} ${path}`;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sent.push({ key, body });
      const handler = routes[key];
      if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }), { status: 404, headers: { "content-type": "application/json" } });
      const out = handler(body) as { status?: number; body: unknown };
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
    });
    initBackend({ kind: "api", apiUrl: "https://api.test" });
    resetApiClient();
    setApiTokenStore(createMemoryTokenStore({ token: "t", expiresAt: "2099-01-01T00:00:00Z" }));
    setApiActiveTenant(T);
    return sent;
  }
  const P = `/v1/tenants/${T}`;
  const learnerRow = (n: number) => ({ id: `new-${n}`, tenantId: T, admission_no: String(4500 + n), full_name: `L${n}`, gender: "female", boarding: false, date_of_birth: null, active: true, archived_at: null, created_at: "x", updated_at: "x" });
  const rows = (text: string) => parseStudentCsv(text, ctx({ skipExtras: true }));
  const TWO = "admission_no,full_name,gender,class\n4501,One,female,Form 1 East\n4502,Two,male,Form 1 East";

  it("sends the learners the API keeps, then places each in the class the file named", async () => {
    const sent = fakeApi({
      [`POST ${P}/imports/learners/preview`]: () => ({ body: { preview: { import_id: "imp", row_count: 2, valid_count: 2, error_count: 0, errors_truncated: false, errors: [], sample_valid: [] } } }),
      [`POST ${P}/imports/learners/apply`]: () => ({ body: { result: { created_count: 2, import_id: "imp" } } }),
      [`GET ${P}/learners`]: () => ({ body: { learners: [learnerRow(1), learnerRow(2)], page: { limit: 200, next_cursor: null } } }),
      [`POST ${P}/class-memberships`]: () => ({ status: 201, body: { membership: {} } }),
    });
    const notify = vi.fn();
    expect(await importStudents(T, CLASSES, rows(TWO), notify)).toBe(2);
    expect(sent.find((s) => s.key.endsWith("/preview"))!.body).toEqual({ csv: "admission_no,full_name,gender,date_of_birth,boarding\n4501,One,female,,false\n4502,Two,male,,false" });
    const placed = sent.filter((s) => s.key === `POST ${P}/class-memberships`).map((s) => s.body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(placed).toEqual([{ learner_id: "new-1", class_id: C1 }, { learner_id: "new-2", class_id: C1 }]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("tells the person when some could not be placed, and still reports the learners that were made", async () => {
    fakeApi({
      [`POST ${P}/imports/learners/preview`]: () => ({ body: { preview: { import_id: "imp", row_count: 2, valid_count: 2, error_count: 0, errors_truncated: false, errors: [], sample_valid: [] } } }),
      [`POST ${P}/imports/learners/apply`]: () => ({ body: { result: { created_count: 2, import_id: "imp" } } }),
      [`GET ${P}/learners`]: () => ({ body: { learners: [learnerRow(1), learnerRow(2)], page: { limit: 200, next_cursor: null } } }),
      [`POST ${P}/class-memberships`]: (b) => ((b as { learner_id: string }).learner_id === "new-2" ? { status: 400, body: { error: { code: "validation_error", message: "Learner or class must belong to this school" } } } : { status: 201, body: { membership: {} } }),
    });
    const notify = vi.fn();
    expect(await importStudents(T, CLASSES, rows(TWO), notify)).toBe(2);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toBe("2 learners were imported, but 1 could not be placed in a class: 4502 (Learner or class must belong to this school). Place them from Manage.");
  });

  it("imports nothing, and says which lines to fix in the person's own file, when the API refuses a row", async () => {
    const sent = fakeApi({
      [`POST ${P}/imports/learners/preview`]: () => ({ body: { preview: { import_id: "imp", row_count: 2, valid_count: 1, error_count: 1, errors_truncated: false, errors: [{ line: 3, message: "admission_no already exists in this school" }], sample_valid: [] } } }),
    });
    // the first row of the file is bad (line 2), the second is on line 3: the API's line 3 is the second valid row we sent
    await expect(importStudents(T, CLASSES, rows(TWO))).rejects.toThrow("1 row needs fixing: line 3: admission_no already exists in this school. Nothing was imported.");
    expect(sent.some((s) => s.key.endsWith("/apply"))).toBe(false);
  });

  it("leaves out the rows that have errors, and does nothing for none", async () => {
    const sent = fakeApi({});
    const bad = parseStudentCsv("admission_no,full_name,gender,class\n,No Number,female,Form 1 East", ctx({ skipExtras: true }));
    expect(await importStudents(T, CLASSES, bad)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
