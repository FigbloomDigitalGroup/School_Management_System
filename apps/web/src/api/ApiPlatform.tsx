import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  apiLoadPlatformSession,
  fetchPlatformNavCounts,
  onSessionChange,
  platformCapabilities,
  type Profile,
} from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { TenantTheme } from "../components/TenantTheme";
import { Skeleton } from "../components/ui/Skeleton";
import { useAsync } from "../lib/useAsync";
import { ApiPlatformAudit } from "../screens/platform/ApiPlatformAudit";
import { ApiPlatformHealth } from "../screens/platform/ApiPlatformHealth";
import { ApiPlatformInvoices } from "../screens/platform/ApiPlatformInvoices";
import { ApiPlatformOrganizations } from "../screens/platform/ApiPlatformOrganizations";
import { ApiPlatformTenants } from "../screens/platform/ApiPlatformTenants";
import { ApiPlatformUsage } from "../screens/platform/ApiPlatformUsage";

/**
 * The Figbloom platform console on an API build (slice P2 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Only `super_admin` may enter; anyone else goes back through `/signin`, which sends them to their own console.
 * Pages whose API endpoints or product decisions are not yet ready are hidden via `platformCapabilities()`.
 */
export function ApiPlatformShell() {
  const { page = "tenants" } = useParams();
  const [session, setSession] = useState<{ loading: boolean; profile: Profile | null }>({ loading: true, profile: null });

  useEffect(() => {
    let alive = true;
    async function load() {
      const snap = await apiLoadPlatformSession();
      if (alive) setSession({ loading: false, profile: snap?.profile ?? null });
    }
    load().catch((err) => {
      if (alive) {
        console.error(err);
        setSession({ loading: false, profile: null });
      }
    });
    const stop = onSessionChange(() => { load().catch(console.error); });
    return () => { alive = false; stop(); };
  }, []);

  const isSuperAdmin = session.profile?.role === "super_admin";
  const { data: counts } = useAsync(
    () => (isSuperAdmin ? fetchPlatformNavCounts() : Promise.resolve(null)),
    [isSuperAdmin],
  );

  if (session.loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!session.profile || !isSuperAdmin) return <Navigate to="/signin" replace />;

  const caps = platformCapabilities();
  const hiddenNav: string[] = [];
  if (!caps.organizationsPage) hiddenNav.push("/platform/organizations");
  if (!caps.curriculumPage) hiddenNav.push("/platform/curriculum");
  if (!caps.usagePage) hiddenNav.push("/platform/usage");
  if (!caps.incidentsPage) hiddenNav.push("/platform/incidents");
  if (!caps.subscriptionsPage) hiddenNav.push("/platform/subscriptions");
  if (!caps.invoicesPage) hiddenNav.push("/platform/invoices");
  if (!caps.impersonationPage) hiddenNav.push("/platform/impersonation");
  if (!caps.auditPage) hiddenNav.push("/platform/audit");

  const badges: Record<string, string> = {};
  if (counts?.tenants) badges["/platform/tenants"] = String(counts.tenants);

  if (page !== "tenants" && page !== "organizations" && page !== "health" && page !== "usage" && page !== "audit" && page !== "invoices") {
    return <Navigate to="/platform/tenants" replace />;
  }

  return (
    <TenantTheme tenant={null}>
      <ConsoleShell
        role="super_admin"
        user={{
          id: session.profile.id,
          name: session.profile.full_name,
          avatarUrl: session.profile.avatar_url,
          roleLabel: "Super admin",
        }}
        badges={badges}
        hiddenNav={hiddenNav}
      >
        {page === "tenants" ? (
          <div className="h-screen"><ApiPlatformTenants /></div>
        ) : page === "organizations" ? (
          <div className="h-screen"><ApiPlatformOrganizations /></div>
        ) : page === "usage" ? (
          <ApiPlatformUsage />
        ) : page === "audit" ? (
          <ApiPlatformAudit />
        ) : page === "invoices" ? (
          <div className="h-screen"><ApiPlatformInvoices /></div>
        ) : (
          <ApiPlatformHealth />
        )}
      </ConsoleShell>
    </TenantTheme>
  );
}
