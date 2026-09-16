import { supabase, type Tenant } from "@figbloom/shared";
import type { NewSchoolInput } from "./platformAdmin";

/**
 * The org_admin half of "self-service add a school" (FIG-374). Deliberately
 * NOT a reuse of platformAdmin.ts's createTenant() as-is: that function does
 * `.insert(...).select("*").single()`, and an org_admin has no direct SELECT
 * access to `tenants` at all (by FIG-332's original design — org_admin only
 * ever reads organization_tenant_summary, never a raw tenant row). Confirmed
 * live while verifying FIG-369's RLS policy: the INSERT itself succeeds, but
 * PostgREST's RETURNING clause is denied by the missing SELECT policy, which
 * surfaces as the exact same RLS-violation error as a rejected insert would.
 *
 * The fix is to never ask for the row back: generate the id client-side (the
 * caller already knows every field they're inserting) and reconstruct the
 * Tenant shape locally instead of reading it from the database.
 */
export async function createTenantSelfService(input: NewSchoolInput): Promise<Tenant> {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row: Tenant = {
    id,
    created_at,
    status: "onboarding",
    logo_url: null,
    payment_paybill: null,
    payment_till: null,
    payment_bank_details: null,
    payment_notes: null,
    price_cents_override: null,
    trial_ends_at: null,
    renews_on: null,
    role_labels: {},
    ...input,
    organization_id: input.organization_id ?? null,
  };

  const { error } = await supabase().from("tenants").insert(row);
  if (error) throw error;
  return row;
}
