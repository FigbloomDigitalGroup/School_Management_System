import { supabase } from "@figbloom/shared";

/**
 * The one edge function callable with no signed-in session at all (FIG-370)
 * — supabase-js's functions.invoke() falls back to the anon key when there's
 * no active session, which is exactly right here: the person calling this
 * has no account yet.
 */
export interface SignupOrganizationInput {
  name: string;
  slug: string;
  kind: "government" | "county" | "constituency" | "group_owner";
  county?: string;
  admin_full_name: string;
  admin_email: string;
  admin_password: string;
}

export interface SignupOrganizationResult {
  ok: true;
  slug: string;
}

export async function signupOrganization(input: SignupOrganizationInput): Promise<SignupOrganizationResult> {
  const { data, error } = await supabase().functions.invoke<SignupOrganizationResult | { error: string }>(
    "signup-organization",
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
  return data as SignupOrganizationResult;
}
