import { toCsv } from "../csv";
import type { LearnerGuardianContact } from "../learnerBio";
import type { ArchivedLearner } from "../learners";
import type { LearnerDetailsChange, NewLearner, PeopleRoster, RosterLearner, RosterStaff } from "../peopleRoster";
import { apiClient } from "./client";
import { ApiError, isApiError, userMessage } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { chunk, settlePool } from "./pool";
import type { components } from "./schema";
import { byYear, classGroupFromApi, currentAcademicYear, listApiSubjects, listClasses, subjectFromApi } from "./setupApi";

/**
 * The People area on the API (FIG-1890): the API side of peopleRoster.ts, learners.ts and learnerBio.ts's guardian list, plus
 * the staff directory, guardian contacts and the CSV import that have no Supabase twin in the shared package. The screens call
 * the same functions; on an API build they land here. What differs from Supabase, and how it is handled:
 *
 *  - A learner's CLASS is a class membership (one active per learner per academic year), not a column. The roster reads every
 *    active membership and gives each learner the one in a class of the current year. Archiving a learner does not end their
 *    membership, so only memberships of listed learners are used.
 *  - Staff here are DIRECTORY RECORDS (a name, a role, contact details), not sign-in accounts; they have no login id or photo.
 *    A teacher id on an API build is a staff id.
 *  - There is no bulk write: archive, restore and "place in class" go one at a time, a few at once, and say how far they got.
 *  - Guardians are contacts linked to learners. Only the school administrator, and staff they have given access one by one,
 *    may read them.
 *  - What a person may read depends on their areas: a teacher holding only People reads learners and staff but not classes, so
 *    the parts that need Academics fall back to "none" instead of failing the page.
 */

type Learner = components["schemas"]["Learner"];
type StaffMember = components["schemas"]["StaffMember"];
type Membership = components["schemas"]["ClassMembership"];

/** The school this tab is acting for, for the calls whose shared signature does not carry it (archive these learners). */
export function activeTenantId(): string {
  const id = apiClient().activeTenant();
  if (!id) throw new Error("No school is open.");
  return id;
}

// ---------------------------------------------------------------- errors a person can read

const FIELD_LABEL: Record<string, string> = {
  admission_no: "Admission number", full_name: "Name", gender: "Gender", date_of_birth: "Date of birth", boarding: "Residence",
  phone: "Phone", alt_phone: "Second phone", email: "Email", staff_title: "Title", classification: "Role", relationship: "Relationship",
  csv: "The file", userId: "Account",
};
const REASON: Record<string, string> = {
  invalid_format: "is not in the right format", too_big: "is too long", too_small: "is too short", invalid_value: "is not valid",
  invalid_type: "is not valid", custom: "is not valid", required: "is required",
};

/**
 * A validation answer from the API says "admission_no, full_name and gender (male|female) are required; optional ..." and puts what
 * is actually wrong in `details`. This swaps the first for the second, in words ("Phone is not in the right format."), keeping the
 * code, status and request id. Every other error (a conflict, a refusal, an outage) is returned as it is.
 */
export function readableApiError(err: unknown): unknown {
  if (!isApiError(err) || err.code !== "validation_error") return err;
  const seen = new Set<string>();
  for (const d of err.details) {
    if (d.field === "(root)") continue;
    const field = d.field.split(".").pop() ?? d.field;
    seen.add(`${FIELD_LABEL[field] ?? field} ${REASON[d.code] ?? "is not valid"}`);
  }
  if (seen.size === 0) return err;
  return new ApiError({
    status: err.status, code: err.code, message: `${[...seen].slice(0, 3).join("; ")}.`,
    requestId: err.requestId, details: err.details, retryAfterSeconds: err.retryAfterSeconds,
  });
}

/** The sentence for a failure, as the screens show it. */
export function peopleErrorText(err: unknown): string {
  return userMessage(readableApiError(err));
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw readableApiError(err);
  }
}

/** Reads something the person may not be allowed to read: "none" instead of an error for a refusal (any other failure still fails). */
async function tolerant<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------- reading the lists (every page)

export function listLearners(tenantId: string, active: boolean): Promise<Learner[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/learners", { path: { tenantId }, query: { active, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.learners, page: r.page };
  });
}

export function listStaffMembers(tenantId: string, active: boolean): Promise<StaffMember[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/staff", { path: { tenantId }, query: { active, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.staff, page: r.page };
  });
}

/** Class memberships: every active one in the school, or one learner's (with `includeEnded`, the ended ones too). */
export function listMemberships(tenantId: string, learnerId?: string, includeEnded = false): Promise<Membership[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
      path: { tenantId }, query: { learnerId, active: includeEnded ? undefined : true, limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    return { items: r.memberships, page: r.page };
  });
}

// ---------------------------------------------------------------- shaping what the screens expect

export function rosterLearnerFromApi(l: Learner, classId: string | null): RosterLearner {
  return {
    id: l.id, admission_no: l.admission_no, full_name: l.full_name, class_id: classId, boarding: l.boarding, gender: l.gender,
    avatar_url: null, profile_id: null, login_id: null, archived_at: l.archived_at,
  };
}

export function rosterStaffFromApi(s: StaffMember): RosterStaff {
  return {
    id: s.id, full_name: s.full_name, role: s.classification, staff_title: s.staff_title, email: s.email, phone: s.phone,
    login_id: null, photo_changed_at: null, handles_visitors: false, avatar_url: null,
  };
}

/** learner id -> class id: each learner's active membership in one of `classIds` (the current year's classes). */
export function classOfLearners(memberships: readonly Pick<Membership, "learner_id" | "class_id">[], classIds: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of memberships) if (classIds.has(m.class_id) && !out.has(m.learner_id)) out.set(m.learner_id, m.class_id);
  return out;
}

const byName = (a: { full_name: string }, b: { full_name: string }) => a.full_name.localeCompare(b.full_name);

// ---------------------------------------------------------------- the roster

/** Everyone in the school with what the People screen shows beside them. No fee figures, subjects of teachers or logins exist on the API. */
export async function apiFetchPeopleRoster(tenantId: string): Promise<PeopleRoster> {
  return guarded(async () => {
    const year = await tolerant(() => currentAcademicYear(tenantId), null);
    const [classes, learners, memberships, staff, subjects] = await Promise.all([
      tolerant(() => listClasses(tenantId, year?.id), []),
      listLearners(tenantId, true),
      tolerant(() => listMemberships(tenantId), []),
      listStaffMembers(tenantId, true),
      tolerant(() => listApiSubjects(tenantId), []),
    ]);
    const shown = classes.map((c) => classGroupFromApi(c, tenantId)).sort(byYear);
    const classOf = classOfLearners(memberships, new Set(classes.map((c) => c.id)));
    return {
      classes: shown.map((c) => ({ id: c.id, name: c.name })),
      students: learners.map((l) => rosterLearnerFromApi(l, classOf.get(l.id) ?? null)),
      staff: staff.map(rosterStaffFromApi).sort(byName),
      feeByStudent: new Map(),
      subjects: subjects.map((s) => subjectFromApi(s, tenantId)).sort((a, b) => a.name.localeCompare(b.name)),
      subjectIdsByTeacher: new Map(),
    };
  });
}

/** Learners who have left, most recently archived first. They keep their class membership, so their class is shown. */
export async function apiFetchArchivedLearners(tenantId: string): Promise<ArchivedLearner[]> {
  return guarded(async () => {
    const year = await tolerant(() => currentAcademicYear(tenantId), null);
    const [learners, classes, memberships] = await Promise.all([
      listLearners(tenantId, false),
      tolerant(() => listClasses(tenantId, year?.id), []),
      tolerant(() => listMemberships(tenantId), []),
    ]);
    const classOf = classOfLearners(memberships, new Set(classes.map((c) => c.id)));
    return learners
      .map((l) => ({
        id: l.id, admission_no: l.admission_no, full_name: l.full_name, class_id: classOf.get(l.id) ?? null, boarding: l.boarding, gender: l.gender,
        avatar_url: null, profile_id: null, archived_at: l.archived_at,
      }))
      .sort((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? "") || a.id.localeCompare(b.id));
  });
}

// ---------------------------------------------------------------- a learner's class

async function assignToClass(tenantId: string, learnerId: string, classId: string): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/class-memberships", { path: { tenantId }, body: { learner_id: learnerId, class_id: classId }, tenantId });
}

async function endMembership(tenantId: string, membershipId: string): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/class-memberships/{membershipId}/archive", { path: { tenantId, membershipId }, tenantId });
}

/**
 * Puts a learner in a class, or (null) takes them out of the current year's class. A learner has one active membership per academic
 * year, so a move ends the one in that year and makes the new one. A class of another year is an addition (the history stays).
 *
 * The API keeps one membership per learner, class and year for good: one that has ENDED still blocks placing the learner in that
 * class again that year (a unique index that also counts ended memberships, answered as "already has an active class membership").
 * So a move back to a class the learner left this year is refused here, before anything changes, and a move cannot be undone by
 * putting the old membership back: if the new one is refused after the old one ended, the learner is left with no class and the
 * message says so.
 */
export async function apiMoveLearnerToClass(tenantId: string, learnerId: string, classId: string | null): Promise<void> {
  const all = await listMemberships(tenantId, learnerId, true);
  const active = all.filter((m) => m.active);
  if (classId === null) {
    const year = await tolerant(() => currentAcademicYear(tenantId), null);
    if (!year) return;
    for (const m of active.filter((x) => x.academic_year_id === year.id)) await endMembership(tenantId, m.id);
    return;
  }
  const target = (await apiClient().get("/v1/tenants/{tenantId}/classes/{classId}", { path: { tenantId, classId }, tenantId })).school_class;
  const sameYear = active.filter((m) => m.academic_year_id === target.academic_year_id);
  if (sameYear.some((m) => m.class_id === classId)) return;
  if (all.some((m) => !m.active && m.class_id === classId && m.academic_year_id === target.academic_year_id)) {
    throw new Error(`This learner was in ${target.name} earlier this year and left it. The new system cannot place them back in it yet.`);
  }
  for (const m of sameYear) await endMembership(tenantId, m.id);
  try {
    await assignToClass(tenantId, learnerId, classId);
  } catch (err) {
    if (sameYear.length === 0) throw err;
    throw new Error(`The learner was taken out of their class but could not be placed in ${target.name}: ${peopleErrorText(err)}. They have no class now: choose one again.`);
  }
}

// ---------------------------------------------------------------- learners

/** The learner was made but could not be placed in their class: they exist, so the screen must reload and say so. */
export class LearnerPlacementError extends Error {
  readonly learnerId: string;
  constructor(learnerId: string, message: string) {
    super(message);
    this.name = "LearnerPlacementError";
    this.learnerId = learnerId;
  }
}

/** Admits a learner and places them in their class. Gives the new learner's id. Home address and pin are not kept by the API. */
export async function apiAddLearner(input: NewLearner): Promise<string> {
  const { tenantId } = input;
  const id = await guarded(async () => {
    const res = await apiClient().post("/v1/tenants/{tenantId}/learners", {
      path: { tenantId }, tenantId,
      body: { admission_no: input.admissionNo, full_name: input.fullName, gender: input.gender, boarding: input.boarding, date_of_birth: input.dateOfBirth },
    });
    return res.learner.id;
  });
  if (input.classId) {
    try {
      await assignToClass(tenantId, id, input.classId);
    } catch (err) {
      throw new LearnerPlacementError(id, peopleErrorText(err));
    }
  }
  return id;
}

/**
 * Saves a learner's details, then moves them if their class changed. With no class given nothing about memberships is read or
 * written: a teacher holding only People may change a name but may not read classes or memberships.
 */
export async function apiUpdateLearnerDetails(studentId: string, change: LearnerDetailsChange): Promise<void> {
  const tenantId = activeTenantId();
  await guarded(async () => {
    await apiClient().patch("/v1/tenants/{tenantId}/learners/{learnerId}", {
      path: { tenantId, learnerId: studentId }, tenantId,
      // The API has no "gender not set": a learner always has one, so a blank choice leaves it alone.
      body: { full_name: change.fullName, admission_no: change.admissionNo, boarding: change.boarding, ...(change.gender ? { gender: change.gender } : {}) },
    });
    if (change.classId !== undefined) await apiMoveLearnerToClass(tenantId, studentId, change.classId);
  });
}

const ALREADY: Record<"archive" | "restore", RegExp> = { archive: /already archived/i, restore: /not archived/i };

/** Archive or restore each learner, four at a time. One already in that state is skipped, not an error. Gives how many changed. */
async function changeEach(ids: string[], action: "archive" | "restore"): Promise<number> {
  if (ids.length === 0) return 0;
  const tenantId = activeTenantId();
  const results = await settlePool(ids, 4, async (learnerId) => {
    try {
      await apiClient().post(action === "archive" ? "/v1/tenants/{tenantId}/learners/{learnerId}/archive" : "/v1/tenants/{tenantId}/learners/{learnerId}/restore", { path: { tenantId, learnerId }, tenantId });
      return true;
    } catch (err) {
      if (isApiError(err) && err.code === "validation_error" && ALREADY[action].test(err.message)) return false;
      throw err;
    }
  });
  const changed = results.filter((r) => r.ok && r.value).length;
  const failed = results.find((r): r is { ok: false; error: unknown } => !r.ok);
  if (failed) {
    const why = peopleErrorText(failed.error);
    throw new Error(changed > 0 ? `${changed} of ${ids.length} ${action === "archive" ? "archived" : "restored"}. ${why}` : why);
  }
  return changed;
}

export const apiArchiveLearners = (ids: string[]): Promise<number> => changeEach(ids, "archive");
export const apiRestoreLearners = (ids: string[]): Promise<number> => changeEach(ids, "restore");

// ---------------------------------------------------------------- staff (directory records)

export interface NewStaffMember {
  tenantId: string;
  fullName: string;
  role: "school_admin" | "teacher" | "driver" | "staff";
  staffTitle: string | null;
  phone: string | null;
  email: string | null;
}

/** Adds a member of staff to the school's directory. Gives their id. */
export async function apiAddStaff(input: NewStaffMember): Promise<string> {
  return guarded(async () => {
    const res = await apiClient().post("/v1/tenants/{tenantId}/staff", {
      path: { tenantId: input.tenantId }, tenantId: input.tenantId,
      body: { full_name: input.fullName, classification: input.role, staff_title: input.staffTitle, phone: input.phone, email: input.email },
    });
    return res.staff.id;
  });
}

export async function apiUpdateStaffDetails(staffId: string, change: { fullName: string; staffTitle: string | null; phone: string | null }): Promise<void> {
  const tenantId = activeTenantId();
  await guarded(async () => {
    await apiClient().patch("/v1/tenants/{tenantId}/staff/{staffId}", {
      path: { tenantId, staffId }, tenantId, body: { full_name: change.fullName, staff_title: change.staffTitle, phone: change.phone },
    });
  });
}

export async function apiArchiveStaff(staffId: string): Promise<void> {
  const tenantId = activeTenantId();
  await guarded(async () => { await apiClient().post("/v1/tenants/{tenantId}/staff/{staffId}/archive", { path: { tenantId, staffId }, tenantId }); });
}

export async function apiRestoreStaff(staffId: string): Promise<void> {
  const tenantId = activeTenantId();
  await guarded(async () => { await apiClient().post("/v1/tenants/{tenantId}/staff/{staffId}/restore", { path: { tenantId, staffId }, tenantId }); });
}

/** Staff who have left, by name. */
export async function apiFetchArchivedStaff(tenantId: string): Promise<RosterStaff[]> {
  return guarded(async () => (await listStaffMembers(tenantId, false)).map(rosterStaffFromApi).sort(byName));
}

// ---------------------------------------------------------------- guardians (contacts)

/** A learner's guardians and how to reach them. Only the school administrator, and staff they have given access, may read them. */
export async function apiFetchLearnerGuardians(studentId: string): Promise<LearnerGuardianContact[]> {
  const tenantId = activeTenantId();
  try {
    const items = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners/{learnerId}/guardians", { path: { tenantId, learnerId: studentId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.items, page: r.page };
    });
    // `profile_id` is a guardian's key on the Supabase side (their account); here it is the guardian record's id.
    return items.map((g) => ({ profile_id: g.id, relationship: g.relationship, full_name: g.full_name, phone: g.phone, alt_phone: g.alt_phone, email: g.email }));
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") throw new Error("Only the school administrator, and staff they allow, can see guardians.");
    throw readableApiError(err);
  }
}

export interface NewGuardianContact {
  fullName: string;
  relationship: "mother" | "father" | "guardian";
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  primaryPayer: boolean;
}

/** Adds a guardian's contact details and links them to this learner. */
export async function apiAddGuardian(studentId: string, g: NewGuardianContact): Promise<void> {
  const tenantId = activeTenantId();
  await guarded(async () => {
    await apiClient().post("/v1/tenants/{tenantId}/guardians", {
      path: { tenantId }, tenantId,
      body: {
        full_name: g.fullName, phone: g.phone, alt_phone: g.altPhone, email: g.email,
        learners: [{ learner_id: studentId, relationship: g.relationship, is_primary_payer: g.primaryPayer }],
      },
    });
  });
}

// ---------------------------------------------------------------- importing learners from a spreadsheet

/** The API reads at most this many learners from one file. */
export const IMPORT_BATCH_ROWS = 1000;

export interface ImportLearnerRow {
  /** The row's line in the person's own file, so a problem points at the right place. */
  line: number;
  admissionNo: string;
  fullName: string;
  gender: "male" | "female";
  dateOfBirth: string | null;
  boarding: boolean;
  /** The class to place them in once they are made. */
  classId: string | null;
}

export interface ImportProblem {
  line: number;
  message: string;
}

/** The API refused the file: nothing was made. */
export class ImportRejectedError extends Error {
  readonly problems: ImportProblem[];
  readonly truncated: boolean;
  /** How many rows were refused: the API counts them all, and lists only the first ones. */
  readonly count: number;
  constructor(problems: ImportProblem[], truncated: boolean, count = problems.length) {
    const n = Math.max(count, problems.length);
    const listed = problems.slice(0, 5).map((p) => `line ${p.line}: ${p.message}`);
    if (listed.length > 0 && n > listed.length) listed.push("and more");
    super(`${n} row${n === 1 ? " needs" : "s need"} fixing${listed.length ? `: ${listed.join("; ")}` : ""}. Nothing was imported.`);
    this.name = "ImportRejectedError";
    this.problems = problems;
    this.truncated = truncated;
    this.count = n;
  }
}

export interface ImportOutcome {
  created: number;
  /** How many of those were placed in their class. */
  placed: number;
  /** The ones that were made but could not be placed, with why. */
  unplaced: { admissionNo: string; reason: string }[];
}

/** The text the API's import reads: its five columns, a row each (line n+2 of the text is row n), no line breaks inside a field. */
export function learnersCsv(rows: readonly ImportLearnerRow[]): string {
  const flat = (s: string) => s.replace(/[\r\n]+/g, " ");
  return toCsv(
    ["admission_no", "full_name", "gender", "date_of_birth", "boarding"],
    rows.map((r) => [flat(r.admissionNo), flat(r.fullName), r.gender, r.dateOfBirth ?? "", r.boarding ? "true" : "false"]),
  );
}

/**
 * Imports learners: the API checks every file (a row it refuses stops the whole import, naming the line in the person's own file),
 * then makes them, then each is placed in their class (the API's import has no class column). A file over 1,000 rows goes in
 * several: all are checked first, then made in turn.
 */
export async function apiImportLearners(tenantId: string, rows: readonly ImportLearnerRow[]): Promise<ImportOutcome> {
  if (rows.length === 0) return { created: 0, placed: 0, unplaced: [] };
  const c = apiClient();
  const batches = chunk(rows, IMPORT_BATCH_ROWS);

  const importIds: string[] = [];
  const problems: ImportProblem[] = [];
  let truncated = false;
  let refused = 0;
  for (const batch of batches) {
    const { preview } = await guarded(() => c.post("/v1/tenants/{tenantId}/imports/learners/preview", { path: { tenantId }, body: { csv: learnersCsv(batch) }, tenantId }));
    for (const e of preview.errors) problems.push({ line: batch[e.line - 2]?.line ?? e.line, message: e.message });
    if (preview.errors_truncated) truncated = true;
    refused += preview.error_count;
    importIds.push(preview.import_id);
  }
  if (problems.length > 0 || truncated || refused > 0) throw new ImportRejectedError(problems, truncated, refused);

  let created = 0;
  for (const importId of importIds) {
    try {
      const { result } = await c.post("/v1/tenants/{tenantId}/imports/learners/apply", { path: { tenantId }, body: { import_id: importId }, tenantId });
      created += result.created_count;
    } catch (err) {
      const why = peopleErrorText(err);
      throw new Error(created > 0 ? `${created} learner${created === 1 ? " was" : "s were"} imported before this stopped: ${why}` : why);
    }
  }

  const wanted = rows.filter((r) => r.classId);
  if (wanted.length === 0) return { created, placed: 0, unplaced: [] };
  let idByAdmission: Map<string, string>;
  try {
    idByAdmission = new Map((await listLearners(tenantId, true)).map((l) => [l.admission_no, l.id]));
  } catch (err) {
    throw new Error(`The ${created} learner${created === 1 ? " was" : "s were"} imported, but could not be placed in their classes: ${peopleErrorText(err)}. Place them from Manage.`);
  }
  const results = await settlePool(wanted, 4, async (r) => {
    const id = idByAdmission.get(r.admissionNo);
    if (!id) throw new Error("not found after the import");
    await assignToClass(tenantId, id, r.classId!);
  });
  const unplaced = results.flatMap((res, i) => (res.ok ? [] : [{ admissionNo: wanted[i]!.admissionNo, reason: peopleErrorText(res.error) }]));
  return { created, placed: wanted.length - unplaced.length, unplaced };
}
