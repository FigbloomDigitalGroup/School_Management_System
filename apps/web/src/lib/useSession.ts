import { useEffect, useState } from "react";
import type { Profile, Tenant } from "@figbloom/shared";
import { supabase } from "@figbloom/shared";

export interface Session {
  loading: boolean;
  profile: Profile | null;
  tenant: Tenant | null;
  /** Set while a super admin is acting inside a school. */
  impersonating: { sessionId: string; tenantName: string } | null;
}

/**
 * The single source of who-is-signed-in. Every route guard reads this rather
 * than querying auth directly, so impersonation is honoured in one place.
 */
export function useSession(slug: string | null): Session {
  const [state, setState] = useState<Session>({ loading: true, profile: null, tenant: null, impersonating: null });

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) { if (alive) setState({ loading: false, profile: null, tenant: null, impersonating: null }); return; }

      const { data: profile } = await supabase()
        .from("profiles").select("*").eq("id", user.id).single<Profile>();

      let tenant: Tenant | null = null;
      if (slug) {
        const { data } = await supabase()
          .from("tenants").select("*").eq("slug", slug).single<Tenant>();
        tenant = data ?? null;
      }

      const raw = sessionStorage.getItem("figbloom.impersonation");
      const impersonating = raw ? (JSON.parse(raw) as Session["impersonating"]) : null;

      if (alive) setState({ loading: false, profile: profile ?? null, tenant, impersonating });
    }

    load().catch((err) => { if (alive) { console.error(err); setState({ loading: false, profile: null, tenant: null, impersonating: null }); } });
    const { data: sub } = supabase().auth.onAuthStateChange(() => { load().catch(console.error); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [slug]);

  return state;
}
