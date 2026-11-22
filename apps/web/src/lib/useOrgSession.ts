import { useEffect, useState } from "react";
import type { Organization, Profile } from "@figbloom/shared";
import { loadOrgSession, onSessionChange } from "@figbloom/shared";

export interface OrgSession {
  loading: boolean;
  profile: Profile | null;
  organization: Organization | null;
}

interface InternalState extends OrgSession {
  /** Which orgSlug this state was actually resolved for — lets a render
   *  detect "orgSlug just changed, this state is stale" synchronously,
   *  rather than waiting for the effect below to run and call setState. */
  resolvedFor: string | null;
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
  const [state, setState] = useState<InternalState>({ loading: true, profile: null, organization: null, resolvedFor: null });

  useEffect(() => {
    let alive = true;

    async function load() {
      // Who is signed in and the organization at this address (packages/shared/src/session.ts).
      const snapshot = await loadOrgSession(orgSlug);
      if (!snapshot) { if (alive) setState({ loading: false, profile: null, organization: null, resolvedFor: orgSlug }); return; }

      if (alive) setState({ loading: false, profile: snapshot.profile, organization: snapshot.organization, resolvedFor: orgSlug });
    }

    load().catch((err) => { if (alive) { console.error(err); setState({ loading: false, profile: null, organization: null, resolvedFor: orgSlug }); } });
    const stop = onSessionChange(() => { load().catch(console.error); });
    return () => { alive = false; stop(); };
  }, [orgSlug]);

  // Switching orgs client-side (the workspace switcher) changes orgSlug
  // before the effect above has a chance to run — without this check, the
  // render in between saw the PREVIOUS org's already-resolved, not-loading
  // state compared against the NEW orgSlug, read as "you don't administer
  // this org", and OrgRoutes bounced to /signin before the real fetch above
  // ever returned. Treating a resolvedFor mismatch as still-loading is
  // synchronous (computed during render, not via an effect + setState round
  // trip), so it's correct on the very first render after orgSlug changes.
  if (state.resolvedFor !== orgSlug) {
    return { loading: true, profile: null, organization: null };
  }
  return state;
}
