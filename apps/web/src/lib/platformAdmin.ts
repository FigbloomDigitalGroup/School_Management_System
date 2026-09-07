import { supabase, type Tenant } from "@figbloom/shared";

/** A super_admin may insert tenants directly — RLS allows it, no edge function needed. */
export interface NewSchoolInput {
  name: string;
  slug: string;
  county: string;
  level: Tenant["level"];
  moe_registration: string | null;
  plan: Tenant["plan"];
  accent: string;
  licensed_seats: number;
}

export async function createTenant(input: NewSchoolInput): Promise<Tenant> {
  const { data, error } = await supabase()
    .from("tenants")
    .insert({ ...input, status: "onboarding" })
    .select("*")
    .single<Tenant>();
  if (error) throw error;
  return data;
}

/**
 * Creating a login needs the service-role key, so this calls the invite-admin
 * edge function rather than writing to auth.users directly from the browser.
 */
export interface InviteAdminInput {
  tenant_id: string;
  full_name: string;
  staff_title: string;
  email: string;
  phone?: string;
}

export interface InviteAdminResult {
  ok: true;
  email: string;
  password: string;
}

export async function inviteAdmin(input: InviteAdminInput): Promise<InviteAdminResult> {
  const { data, error } = await supabase().functions.invoke<InviteAdminResult | { error: string }>(
    "invite-admin",
    { body: input },
  );
  if (error) {
    // supabase-js puts a non-2xx function response on error.context (a Response), not `data`.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (data && "error" in data) throw new Error(data.error);
  return data as InviteAdminResult;
}
