import { useEffect, useState } from "react";
import type { Organization, Profile } from "@figbloom/shared";
import { supabase } from "@figbloom/shared";

export interface OrgSession {
  loading: boolean;
  profile: Profile | null;
  organization: Organization | null;
}

/**
 * The org-admin equivalent of useSession/useTenantSession. Resolving the
 * organization by slug doubles as the authorization check: organization_read_own
 * RLS only returns a row the caller actually administers (or none, if they
 * aren't an org_admin for it, or aren't an org_admin at all) — no separate
 * client-side membership check needed, the same way useSession leans on
 * tenant_read_own for tenants.
 */
export function useOrgSession(orgSlug: string | null): OrgSession {
  const [state, setState] = useState<OrgSession>({ loading: true, profile: null, organization: null });

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) { if (alive) setState({ loading: false, profile: null, organization: null }); return; }

      const { data: profile } = await supabase().from("profiles").select("*").eq("id", user.id).single<Profile>();

      let organization: Organization | null = null;
      if (orgSlug) {
        const { data } = await supabase().from("organizations").select("*").eq("slug", orgSlug).maybeSingle<Organization>();
        organization = data ?? null;
      }

      if (alive) setState({ loading: false, profile: profile ?? null, organization });
    }

    load().catch((err) => { if (alive) { console.error(err); setState({ loading: false, profile: null, organization: null }); } });
    const { data: sub } = supabase().auth.onAuthStateChange(() => { load().catch(console.error); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [orgSlug]);

  return state;
}
