import { useNavigate } from "react-router-dom";
import { fetchAllMyOrganizationTenantSummaries, fetchMyOrganizations, formatMoney, supabase } from "@figbloom/shared";
import { useAsync } from "../lib/useAsync";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * Where an org_admin who administers more than one organization lands after
 * sign-in instead of guessing which one they meant — SignIn.tsx sends them
 * here the moment organization_admins resolves to 2+ rows, and it's also
 * reachable any time from the workspace switcher's "All organizations" link.
 */
export function OrgPicker() {
  const nav = useNavigate();
  const { data, loading, error } = useAsync(async () => {
    const { data: auth } = await supabase().auth.getUser();
    if (!auth.user) return null;
    const { data: profile } = await supabase()
      .from("profiles").select("id, full_name, role").eq("id", auth.user.id).maybeSingle();
    if (!profile || profile.role !== "org_admin") return null;
    const [orgs, schools] = await Promise.all([
      fetchMyOrganizations(profile.id),
      fetchAllMyOrganizationTenantSummaries(),
    ]);
    return { name: profile.full_name, orgs, schools };
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

        {!loading && data && data.schools.length > 0 && (
          <div className="mb-4 grid grid-cols-3 gap-2.5">
            <CombinedStat label="Schools" value={data.schools.length.toLocaleString()} />
            <CombinedStat label="Active students" value={data.schools.reduce((a, s) => a + s.active_students, 0).toLocaleString()} />
            {/* Every school in this list can belong to a different org, and today every org is Kenyan-only
                (the country selector is locked to Kenya) — "KE" is safe here for the same reason it is
                elsewhere in the org console; a real cross-country combined total is a currency-aggregation
                problem to solve once that's possible, not a formatting one. */}
            <CombinedStat label="Fees collected" value={formatMoney(data.schools.reduce((a, s) => a + s.fees_collected_cents, 0), "KE")} />
          </div>
        )}

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

function CombinedStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2.5">
      <div className="font-mono text-[10px] tracking-[0.08em] text-ink-faint">{label.toUpperCase()}</div>
      <div className="mt-0.5 text-[16px] font-semibold tracking-tight">{value}</div>
    </div>
  );
}
