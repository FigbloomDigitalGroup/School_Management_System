import type { Role } from "../types";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import type { components } from "./schema";

type FamilyChatContact = components["schemas"]["FamilyChatContact"];

/**
 * Who is who, for the screens that show other people's names (chats, notices). apps/api answers with user ids only: a
 * chat has `peer_user_id`, a notice has `author_id`. The one place a name can be had is the staff directory
 * (`GET /staff`, a record with `userId` linking it to the account), and that needs `resource.staff.read`: a school admin
 * and anyone with the People area have it, a plain teacher does not. So a person may get no names at all (`null`), and
 * the screens say so instead of inventing one. Parents and learners are not in this list (guardian contacts carry no
 * account id yet).
 *
 * The answer, including "not allowed", is kept for a minute per school: a chat list polled every few seconds must not ask
 * for the whole staff list each time.
 */

export interface DirectoryPerson {
  userId: string;
  name: string;
  role: Role;
  title: string | null;
  active: boolean;
}

/** A person's name as far as the directory goes: undefined when the directory has no one by that id. */
export type Directory = Map<string, DirectoryPerson>;

export const DIRECTORY_TTL_MS = 60_000;

let cached: { tenantId: string; at: number; value: Directory | null } | null = null;
let familyCached: { tenantId: string; at: number; value: Directory } | null = null;

/** Forgets the kept answer (a test; a sign-out; a school switch). */
export function resetDirectory(): void {
  cached = null;
  familyCached = null;
}

export function formatFamilyContactTitle(c: FamilyChatContact): string | null {
  if (c.role === "school_admin") return "School office";
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const t of c.teaches) {
    const label = t.subject ? `${t.subject} · ${t.class_name}` : `Class teacher · ${t.class_name}`;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.length ? labels.join(", ") : null;
}

/** The admins and child teachers a parent may talk with (`GET /me/chat-contacts`), cached per tenant for `DIRECTORY_TTL_MS`. */
export async function familyChatDirectory(tenantId: string): Promise<Directory> {
  const now = Date.now();
  if (familyCached && familyCached.tenantId === tenantId && now - familyCached.at < DIRECTORY_TTL_MS) {
    return familyCached.value;
  }
  const r = await apiClient().get("/v1/tenants/{tenantId}/me/chat-contacts", { path: { tenantId }, tenantId });
  const out: Directory = new Map();
  for (const c of r.contacts) {
    out.set(c.user_id, {
      userId: c.user_id,
      name: c.full_name,
      role: c.role,
      title: formatFamilyContactTitle(c),
      active: true,
    });
  }
  familyCached = { tenantId, at: now, value: out };
  return out;
}

async function loadDirectory(tenantId: string): Promise<Directory | null> {
  try {
    const staff = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
      return { items: r.staff, page: r.page };
    });
    const out: Directory = new Map();
    for (const s of staff) {
      if (!s.userId) continue;
      out.set(s.userId, { userId: s.userId, name: s.full_name, role: s.classification, title: s.staff_title, active: s.active });
    }
    return out;
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return null;
    throw err;
  }
}

/** The staff who have an account, by account id; `null` when this person may not read the staff list. */
export async function staffDirectory(tenantId: string): Promise<Directory | null> {
  const now = Date.now();
  if (cached && cached.tenantId === tenantId && now - cached.at < DIRECTORY_TTL_MS) return cached.value;
  const value = await loadDirectory(tenantId);
  cached = { tenantId, at: now, value };
  return value;
}
