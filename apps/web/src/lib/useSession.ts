import { useEffect, useState } from "react";
import type { AdminArea, Profile, Tenant } from "@figbloom/shared";
import { loadSchoolSession, onSessionChange } from "@figbloom/shared";
import { setCacheScope } from "./queryCache";

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
  /** A teacher's or other staff member's admin areas (20261031000000): their
   *  own and their school roles'. Empty for everyone else; full admins don't
   *  need any (adminAccessFor). The database checks every one itself. */
  adminAreas: AdminArea[];
  /** The signed-in person's own school is suspended (my_school_suspended()):
   *  their session still works for up to an hour after the ban, but
   *  my_tenant() hides the school, so the console shows the suspended
   *  message instead of bouncing to sign-in with no reason. */
  schoolSuspended: boolean;
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
  loading: false, profile: null, tenant: null, impersonating: null, actingForTenant: false, actingOrganization: null, adminAreas: [],
  schoolSuspended: false,
};

/**
 * The single source of who-is-signed-in. Every route guard reads this rather
 * than querying auth directly, so impersonation is honoured in one place.
 */
export function useSession(slug: string | null): Session {
  const [state, setState] = useState<InternalState>({ loading: true, profile: null, tenant: null, impersonating: null, actingForTenant: false, actingOrganization: null, adminAreas: [], schoolSuspended: false, resolvedFor: null });

  useEffect(() => {
    let alive = true;

    async function load() {
      // Who is signed in, the school at this address and their place in it (packages/shared/src/session.ts).
      const snapshot = await loadSchoolSession(slug);
      if (!snapshot) { if (alive) setState({ ...EMPTY, resolvedFor: slug }); return; }

      const raw = sessionStorage.getItem("figbloom.impersonation");
      const impersonating = raw ? (JSON.parse(raw) as Session["impersonating"]) : null;

      // The screens' cache belongs to this person in this school: signing out, another person
      // signing in, or moving to another school (or impersonating one) starts it empty.
      setCacheScope(snapshot.profile ? `${snapshot.profile.id}:${snapshot.tenant?.id ?? ""}:${impersonating ? JSON.stringify(impersonating) : ""}` : null);
      if (alive) setState({ loading: false, ...snapshot, impersonating, resolvedFor: slug });
    }

    load().catch((err) => { if (alive) { console.error(err); setState({ ...EMPTY, resolvedFor: slug }); } });
    const stop = onSessionChange(() => { load().catch(console.error); });
    return () => { alive = false; stop(); };
  }, [slug]);

  if (state.resolvedFor !== slug) {
    return { loading: true, profile: null, tenant: null, impersonating: null, actingForTenant: false, actingOrganization: null, adminAreas: [], schoolSuspended: false };
  }
  return state;
}
