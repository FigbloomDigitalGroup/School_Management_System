import { apiLoginWithLoginId, type ApiLogin } from "./authApi";
import { apiClient } from "./client";
import { isApiError } from "./errors";

/**
 * Signing in to a school with a login ID (`ST-0001`, the way the school office hands logins out) on the API.
 *
 * `POST /v1/auth/login/login-id` takes the school's UUID, which nobody knows by heart. The school's address is its slug (the `alliance`
 * of `/s/alliance/...`), and an unauthenticated exact-slug lookup turns it into the UUID: `GET /v1/public/schools/{slug}` answers
 * `{ tenant_id, name }`, or a 404 with a generic body for an unknown or inactive school (no list, no search; rate limited). That
 * endpoint is its own API change (branch feature/api-public-school-lookup); until it is in the OpenAPI file this is the one call in
 * the client that does not go through the generated types, so the answer is checked by hand. A school's UUID typed in place of the
 * address needs no lookup and works the same.
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

type LooseClient = { get(path: string, opts: { path: Record<string, string>; auth: false; tenantId: null }): Promise<unknown> };

/** Reads the lookup's answer: the school's UUID and, when it says, its name. Anything else is a failure, never a guess. */
export function parseSchoolLookup(v: unknown): SchoolLookup {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.tenant_id !== "string" || !UUID_RE.test(o.tenant_id)) throw new Error("The server's answer about that school was not understood.");
  return { tenantId: o.tenant_id.toLowerCase(), name: typeof o.name === "string" && o.name ? o.name : null };
}

/** The school at an address. Throws SchoolNotFoundError for one the server does not know (or one that is not usable). */
export async function apiLookupSchool(input: string): Promise<SchoolLookup> {
  const school = schoolFromInput(input);
  if (!school) throw new SchoolNotFoundError();
  if ("tenantId" in school) return { tenantId: school.tenantId, name: null };
  try {
    const res = await (apiClient() as unknown as LooseClient).get("/v1/public/schools/{slug}", { path: { slug: school.slug }, auth: false, tenantId: null });
    return parseSchoolLookup(res);
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
