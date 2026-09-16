import { useNavigate } from "react-router-dom";
import { fetchMyOrganizations, supabase } from "@figbloom/shared";
import { useAsync } from "../lib/useAsync";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * Where an org_admin who administers more than one organization lands after
 * sign-in instead of guessing which one they meant — SignIn.tsx sends them
 * here the moment organization_admins resolves to 2+ rows.
 */
export function OrgPicker() {
  const nav = useNavigate();
  const { data, loading, error } = useAsync(async () => {
    const { data: auth } = await supabase().auth.getUser();
    if (!auth.user) return null;
    const { data: profile } = await supabase()
      .from("profiles").select("id, full_name, role").eq("id", auth.user.id).maybeSingle();
    if (!profile || profile.role !== "org_admin") return null;
    const orgs = await fetchMyOrganizations(profile.id);
    return { name: profile.full_name, orgs };
  }, []);

  async function signOut() {
    await supabase().auth.signOut();
    nav("/signin", { replace: true });
  }

  if (!loading && (!data || data.orgs.length === 0)) {
    nav("/signin", { replace: true });
    return null;
  }

  return (
    <div className="grid min-h-screen place-items-center bg-page p-6">
      <div className="w-full max-w-[480px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-line">
            <img src="/logo-mark.png" alt="Figbloom" className="h-full w-full object-contain" />
          </div>
          <div>
            <div className="text-[15px] font-semibold">Choose a workspace</div>
            <p className="text-[12.5px] text-ink-muted">
              {loading ? "…" : `${data?.name}, you administer more than one organization.`}
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          {loading || !data ? (
            <div className="divide-y divide-line-soft">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                  <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
                  <Skeleton className="h-3 flex-1" />
                </div>
              ))}
            </div>
          ) : error ? (
            <p className="p-4 text-[12.5px] text-warn-ink">Could not load your organizations: {error.message}</p>
          ) : (
            <div className="divide-y divide-line-soft">
              {data.orgs.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  onClick={() => nav(`/org/${org.slug}/dashboard`)}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-page"
                >
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sunken text-[13px] font-semibold text-ink-muted">
                    {org.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{org.name}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-faint">
                      {org.status === "pending" ? "Under review" : org.status === "suspended" ? "Suspended" : "Active"}
                    </div>
                  </div>
                  <span aria-hidden className="text-ink-faint">→</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" onClick={() => void signOut()} className="mt-4 text-[13px] font-semibold text-forest hover:underline">
          Sign out
        </button>
      </div>
    </div>
  );
}
