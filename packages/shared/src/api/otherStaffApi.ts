import type { AdminArea } from "../adminAreas";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import type { components } from "./schema";

/**
 * Other staff (role "staff") on apps/api: the staff home's own record, and which menu pages the build can open for them.
 *
 * The session's `profile.staff_title` is always null on the API (`GET /v1/auth/me` carries no job title), so the title comes from the
 * signed-in person's own staff directory record, `GET /v1/tenants/{tenantId}/staff/me`. The API says any member of the school may read
 * their own row (no `resource.staff.read` needed). It answers 404 when the account is not linked to an active staff record (the school
 * office never made one, or linked the wrong person), and this returns null then, rather than inventing a title.
 */

type ApiStaffMember = components["schemas"]["StaffMember"];

export interface MyStaffRecord {
  id: string;
  full_name: string;
  staff_title: string | null;
  classification: ApiStaffMember["classification"];
  phone: string | null;
  email: string | null;
}

export function myStaffRecordFromApi(s: ApiStaffMember): MyStaffRecord {
  return {
    id: s.id,
    full_name: s.full_name,
    staff_title: s.staff_title?.trim() || null,
    classification: s.classification,
    phone: s.phone?.trim() || null,
    email: s.email?.trim() || null,
  };
}

/** The signed-in person's own staff record in this school, or null when none is linked to their account. */
export async function apiFetchMyStaffRecord(tenantId: string): Promise<MyStaffRecord | null> {
  try {
    const res = await apiClient().get("/v1/tenants/{tenantId}/staff/me", { path: { tenantId }, tenantId });
    return myStaffRecordFromApi(res.staff);
  } catch (err) {
    if (isApiError(err) && err.code === "not_found") return null;
    throw err;
  }
}

/**
 * Whether "My items" (`staff/items`) can work for a person holding these admin areas. The API lists what the school has issued
 * (`GET /inventory/issues`) only to holders of `resource.inventory.read`, which the Inventory area gives and the staff role does not
 * (finding 13). A plain staff member would get "forbidden", so the page stays out of their menu.
 */
export function staffMayReadItems(areas: readonly AdminArea[]): boolean {
  return areas.includes("inventory");
}
