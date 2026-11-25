import { apiLoginWithLoginId, type ApiLogin } from "./authApi";
import { apiClient } from "./client";
import { isApiError } from "./errors";

/**
 * Signing in to a school with a login ID (`ST-0001`, the way the school office hands logins out) on the API.
 *
 * `POST /v1/auth/login/login-id` takes the school's UUID, which nobody knows by heart. The school's address is its slug (the `alliance`
 * of `/s/alliance/...`), and an unauthenticated exact-slug lookup turns it into the UUID: `GET /v1/public/schools/{slug}` answers
 * `{ tenant_id, name }`, or a 404 with a generic body for an unknown or unusable school (no list, no search; rate limited: 429 with Retry-After;
 * the slug must be lower case, so it is lower-cased here before it is sent). Its contract is
 * `apps/api/docs/PUBLIC-SCHOOL-LOOKUP.md`; the answer is still checked by hand (`parseSchoolLookup`), as a sign-in is no place to trust a
 * shape. A school's UUID typed in place of the address needs no lookup and works the same.
 */

export interface SchoolLookup {
  tenantId: string;
  name: string | null;
}

/** The school could not be found from what was typed: no such address, or not a usable one. Its message is for the person. */
export class SchoolNotFoundError extends Error {
  constructor() {
    super("We could not find a school with that address. Check it with your school.");
    this.name = "SchoolNotFoundError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The API's own rule for a school address (migration 001): lower-case letters, digits and hyphens, 3 to 40 characters. */
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

/**
 * What a person typed for "School ID or address", as the school's slug or UUID: the plain slug ("alliance"), a pasted address of the
 * school's pages ("https://app.example.org/s/alliance/student", "/s/alliance"), or the school's UUID. Null when it is none of them.
 */
export function schoolFromInput(input: string): { slug: string } | { tenantId: string } | null {
  const raw = input.trim();
  if (UUID_RE.test(raw)) return { tenantId: raw.toLowerCase() };
  const fromPath = /\/s\/([^/?#\s]+)/i.exec(raw)?.[1];
  const slug = (fromPath ?? raw).trim().toLowerCase();
  return SLUG_RE.test(slug) ? { slug } : null;
}

/** Reads the lookup's answer: the school's UUID and, when it says, its name. Anything else is a failure, never a guess. */
export function parseSchoolLookup(v: unknown): SchoolLookup {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.tenant_id !== "string" || !UUID_RE.test(o.tenant_id)) throw new Error("The server's answer about that school was not understood.");
  return { tenantId: o.tenant_id.toLowerCase(), name: typeof o.name === "string" && o.name ? o.name : null };
}

// ---------------------------------------------------------------- what this device has already found

/**
 * The schools this device has found, by address, so a computer room behind one network address signing learners in all morning does not
 * spend the lookup's rate limit (about 5 at once, then 2 every 5 seconds per address) on asking the same question. Kept in localStorage
 * where there is one (a typed `globalThis` read: the shared code is also compiled for the phone, which has none), and only ever what a
 * successful lookup answered, for a week. A school's id never changes, so a kept answer cannot send a password anywhere new.
 */
const KEPT_KEY = "figbloom.api.schools";
const KEPT_DAYS = 7;
const KEPT_MAX = 20;

type KeptSchools = Record<string, { tenantId: string; name: string | null; at: number }>;
type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };

function storage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readKept(): KeptSchools {
  try {
    const raw = storage()?.getItem(KEPT_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as KeptSchools) : {};
  } catch {
    return {};
  }
}

/** The school this device found at this address within the last week, or null. */
export function keptSchool(slug: string, now: number = Date.now()): SchoolLookup | null {
  const hit = readKept()[slug];
  if (!hit || typeof hit.tenantId !== "string" || !UUID_RE.test(hit.tenantId) || typeof hit.at !== "number" || now - hit.at > KEPT_DAYS * 86_400_000) return null;
  return { tenantId: hit.tenantId, name: typeof hit.name === "string" ? hit.name : null };
}

function keepSchool(slug: string, found: SchoolLookup, now: number = Date.now()): void {
  try {
    const all = readKept();
    all[slug] = { tenantId: found.tenantId, name: found.name, at: now };
    // Past the limit the oldest answers go.
    const newest = Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, KEPT_MAX);
    storage()?.setItem(KEPT_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Private window or blocked storage: the answer is just asked again next time.
  }
}

/**
 * The school at an address. Throws SchoolNotFoundError for one the server does not know (or one that is not usable: an unknown, not yet
 * live, stalled or suspended school all get the same answer, and this does not try to tell them apart). A throttled lookup (429) is
 * passed on for the screen to say "try again in N seconds".
 */
export async function apiLookupSchool(input: string): Promise<SchoolLookup> {
  const school = schoolFromInput(input);
  if (!school) throw new SchoolNotFoundError();
  if ("tenantId" in school) return { tenantId: school.tenantId, name: null };
  const kept = keptSchool(school.slug);
  if (kept) return kept;
  try {
    const res = await apiClient().get("/v1/public/schools/{slug}", { path: { slug: school.slug }, auth: false, tenantId: null });
    const found = parseSchoolLookup(res);
    keepSchool(school.slug, found);
    return found;
  } catch (err) {
    if (isApiError(err) && err.code === "not_found") throw new SchoolNotFoundError();
    throw err;
  }
}

/**
 * Signs in with a school's address (or UUID), a login ID and a password, and keeps the session. A school that cannot be found throws
 * SchoolNotFoundError; a wrong login ID or password is the server's usual 401, the same answer whichever it was.
 */
export async function apiLoginWithSchool(school: string, loginId: string, password: string): Promise<ApiLogin> {
  const found = await apiLookupSchool(school);
  return apiLoginWithLoginId(found.tenantId, loginId.trim(), password);
}
