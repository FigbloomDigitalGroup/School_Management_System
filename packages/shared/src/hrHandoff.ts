import type { AdminArea } from "./adminAreas";
import { invokeEdge } from "./edge";
import { supabase } from "./supabase";
import type { Role } from "./types";

/**
 * "HR & Payroll": one click from Figbloom Schools into Figbloom HR, signed in
 * (SCHOOLS_HR_HANDOFF_CONTRACT.md section 3; 20261105700000, the open-hr function).
 *
 * The database's hr_handoff_status(school) is the rule, for the sidebar and
 * for open-hr alike:
 *   forbidden    not the school's admin, an org admin of its organisation, or a holder of the fees area
 *                (the database refuses them, 42501, so it says nothing about other schools)
 *   off          PLATFORM_HANDOFF_ENABLED is off (the default)
 *   not_linked   the platform doesn't know the school yet
 *   not_enabled  the platform said HR isn't on for it, in the last hour
 *   available    show it
 * HR decides real access; this only hides the item from people who can't use it.
 */
export type HrHandoffStatus = "off" | "forbidden" | "not_linked" | "not_enabled" | "available";

export const HR_ITEM_LABEL = "HR & Payroll";

/**
 * Whether this person could ever get the item at the school they're in, from
 * what the console already knows: the school's admin, an org admin acting for
 * it, or a teacher or other staff member holding the fees area (the bursar).
 * Anyone else isn't asked about it at all.
 */
export function mayOfferHr(role: Role, adminAreas: readonly AdminArea[], actingForTenant = false): boolean {
  if (actingForTenant || role === "school_admin") return true;
  return (role === "teacher" || role === "staff") && adminAreas.includes("fees");
}

/** The sidebar shows the item only when the person may have it and the database says it's available. */
export function showsHrItem(eligible: boolean, status: HrHandoffStatus | null | undefined): boolean {
  return eligible && status === "available";
}

const STATUSES: readonly HrHandoffStatus[] = ["off", "forbidden", "not_linked", "not_enabled", "available"];

/** hr_handoff_status() for the signed-in person at this school; "off" for an answer it doesn't know (the item stays hidden). */
export async function fetchHrHandoffStatus(tenantId: string): Promise<HrHandoffStatus> {
  const { data, error } = await supabase().rpc("hr_handoff_status", { p_tenant_id: tenantId });
  if (error?.code === "42501") return "forbidden";
  if (error) throw new Error(error.message);
  return STATUSES.includes(data as HrHandoffStatus) ? (data as HrHandoffStatus) : "off";
}

/** A one-time HR sign-in link for the signed-in person (valid for a minute, once). Throws an EdgeError with the reason. */
export async function requestHrLink(tenantId: string): Promise<{ url: string; expires_at: string }> {
  return invokeEdge<{ url: string; expires_at: string }>("open-hr", { tenant_id: tenantId }, { timeoutMs: 20_000 });
}

