import { useEffect, useState } from "react";
import type { Profile, Tenant } from "@figbloom/shared";
import { supabase } from "@figbloom/shared";

export interface Session {
  loading: boolean;
  profile: Profile | null;
  tenant: Tenant | null;
  /** Set while a super admin is acting inside a school. */
  impersonating: { sessionId: string; tenantName: string } | null;
  /** True when the signed-in profile is an org_admin viewing a school that
   *  belongs to one of their own organizations, not their own school_admin
   *  account (an org_admin's own profile.tenant_id is always null, by a
   *  hard DB constraint). RLS (FIG-391) is what actually authorizes the
   *  underlying data access — this flag only drives UI: the "Acting for
   *  {org}" banner, and treating them as school_admin for route-gating
   *  purposes (App.tsx's RoleGate) so they land on the same admin console
   *  a school_admin would, not a 403-shaped dead end. */
  actingForTenant: boolean;
  /** Populated only while actingForTenant is true — the organization whose
   *  membership is what actually grants this access, and the "Exit to
   *  organization" link's destination. */
  actingOrganization: { id: string; name: string; slug: string } | null;
}

interface InternalState extends Session {
  /** Which slug this state was actually resolved for — lets a render detect
   *  "slug just changed, this state is stale" synchronously, the same fix
   *  FIG-388 established for useOrgSession: an org_admin can act inside more
   *  than one school, and moving between them client-side without a full
   *  reload (both match the same /s/:slug/* route, so TenantRoutes stays
   *  mounted) left a render where the PREVIOUS tenant's already-resolved
   *  session was compared against the NEW slug — read as "wrong school",
   *  bouncing to /signin before the real fetch for the new slug returned. */
  resolvedFor: string | null;
}

const EMPTY: Omit<InternalState, "resolvedFor"> = {
  loading: false, profile: null, tenant: null, impersonating: null, actingForTenant: false, actingOrganization: null,
};

/**
 * The single source of who-is-signed-in. Every route guard reads this rather
 * than querying auth directly, so impersonation is honoured in one place.
 */
export function useSession(slug: string | null): Session {
  const [state, setState] = useState<InternalState>({ loading: true, profile: null, tenant: null, impersonating: null, actingForTenant: false, actingOrganization: null, resolvedFor: null });

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) { if (alive) setState({ ...EMPTY, resolvedFor: slug }); return; }

      const { data: profile } = await supabase()
        .from("profiles").select("*").eq("id", user.id).single<Profile>();

      let tenant: Tenant | null = null;
      if (slug) {
        // maybeSingle, not single — zero rows is an expected outcome here
        // (wrong school, or someone unauthorized for it, e.g. an org_admin
        // acting on a school outside their own organization), not an
        // exceptional one; .single() would still resolve to the same
        // `tenant: null` via the ?? below, just with a noisy 406 on the wire
        // for every legitimately-unauthorized visit.
        const { data } = await supabase()
          .from("tenants").select("*").eq("slug", slug).maybeSingle<Tenant>();
        tenant = data ?? null;
      }

      // org_admin's own tenant_id is always null, so a resolved tenant here
      // can only ever be one they're acting within via their organization —
      // organization_read_own RLS (FIG-391) already denied the tenant fetch
      // above if they don't actually administer it.
      const actingForTenant = profile?.role === "org_admin" && !!tenant;
      let actingOrganization: Session["actingOrganization"] = null;
      if (actingForTenant && tenant?.organization_id) {
        const { data: org } = await supabase()
          .from("organizations").select("id, name, slug").eq("id", tenant.organization_id).maybeSingle();
        actingOrganization = org ?? null;
      }

      const raw = sessionStorage.getItem("figbloom.impersonation");
      const impersonating = raw ? (JSON.parse(raw) as Session["impersonating"]) : null;

      if (alive) setState({ loading: false, profile: profile ?? null, tenant, impersonating, actingForTenant, actingOrganization, resolvedFor: slug });
    }

    load().catch((err) => { if (alive) { console.error(err); setState({ ...EMPTY, resolvedFor: slug }); } });
    const { data: sub } = supabase().auth.onAuthStateChange(() => { load().catch(console.error); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [slug]);

  if (state.resolvedFor !== slug) {
    return { loading: true, profile: null, tenant: null, impersonating: null, actingForTenant: false, actingOrganization: null };
  }
  return state;
}
