import { Navigate, useNavigate, useParams } from "react-router-dom";
import { apiLogout, forgetApiSchools } from "@figbloom/shared";
import { SuspendedNotice } from "../components/SuspendedNotice";
import { TenantTheme } from "../components/TenantTheme";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { SessionCtx } from "../lib/sessionContext";
import { useSession } from "../lib/useSession";
import { ApiConsole } from "./ApiConsole";
import type { SchoolSession } from "./ApiOverview";

/** `/s/<slug>/*` on an API build: the session gate, then the console. */
export function ApiSchool() {
  const { slug = null } = useParams();
  const session = useSession(slug);
  const nav = useNavigate();

  async function signOut() {
    await apiLogout();
    forgetApiSchools();
    nav("/signin", { replace: true });
  }

  if (session.loading) return <div className="mx-auto max-w-2xl space-y-3 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  if (!session.profile) return <Navigate to="/signin" replace />;
  if (session.schoolSuspended) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <SuspendedNotice />
        <Button className="mt-4" onClick={() => void signOut()}>Sign out</Button>
      </div>
    );
  }
  if (!session.tenant || session.tenant.slug !== slug) return <Navigate to="/signin" replace />;

  return (
    <SessionCtx.Provider value={session}>
      <TenantTheme tenant={session.tenant}>
        <ApiConsole session={session as SchoolSession} onSignOut={signOut} />
      </TenantTheme>
    </SessionCtx.Provider>
  );
}
