import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { adminAccessFor, apiBaseUrl, apiClient, apiLogout, forgetApiSchools, userMessage, type Role } from "@figbloom/shared";
import { SuspendedNotice } from "../components/SuspendedNotice";
import { TenantTheme } from "../components/TenantTheme";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { useSession, type Session } from "../lib/useSession";

/**
 * Where a person lands after signing in on the new API: who they are, which school, and the connection itself.
 * Nothing else is on the API build yet: each area of the app moves over on its own (FIG-1890 onwards), and this page
 * says so, so a person who finds nothing else here knows it is the build and not their account.
 */
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
    <TenantTheme tenant={session.tenant}>
      <ApiHome session={session as Session & { profile: NonNullable<Session["profile"]>; tenant: NonNullable<Session["tenant"]> }} onSignOut={signOut} />
    </TenantTheme>
  );
}

const ROLE_NAMES: Record<Role, string> = {
  school_admin: "School administrator", teacher: "Teacher", parent: "Parent", student: "Learner", driver: "Driver",
  staff: "Staff", org_admin: "Organization administrator", super_admin: "Platform administrator",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-small font-semibold text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-body">{children}</dd>
    </div>
  );
}

function ApiHome({ session, onSignOut }: { session: Session & { profile: NonNullable<Session["profile"]>; tenant: NonNullable<Session["tenant"]> }; onSignOut: () => Promise<void> }) {
  const { profile, tenant, adminAreas } = session;
  const expires = apiClient().session()?.expiresAt;
  const [check, setCheck] = useState<string>("");
  const [checking, setChecking] = useState(false);

  async function checkConnection() {
    setChecking(true);
    setCheck("");
    const started = performance.now();
    try {
      await apiClient().get("/readyz", { auth: false, tenantId: null });
      setCheck(`The API answered ready in ${Math.round(performance.now() - started)} ms.`);
    } catch (err) {
      setCheck(userMessage(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12" data-testid="api-home">
      <p className="text-small font-semibold uppercase tracking-wide text-forest">Connected to the new system</p>
      <h1 className="mt-1 text-[26px] font-semibold tracking-tight">{tenant.name}</h1>
      <p className="mt-1 text-body text-ink-muted">Signed in as {profile.full_name}, {ROLE_NAMES[profile.role]}.</p>

      <section className="mt-6 rounded-xl border border-line bg-white px-5 py-3">
        <h2 className="py-2 text-body font-semibold">You</h2>
        <dl className="divide-y divide-line-soft">
          <Fact label="Name">{profile.full_name}</Fact>
          <Fact label="Email">{profile.email ?? "none on file"}</Fact>
          <Fact label="Role">{ROLE_NAMES[profile.role]}</Fact>
          {profile.login_id && <Fact label="Login ID">{profile.login_id}</Fact>}
          {(profile.role === "teacher" || profile.role === "staff") && (
            <Fact label="Admin areas">{adminAreas.length ? adminAreas.join(", ") : "none"}</Fact>
          )}
          {profile.role === "school_admin" && <Fact label="Admin areas">{adminAccessFor(profile.role, adminAreas) === "all" ? "all of them" : "none"}</Fact>}
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white px-5 py-3">
        <h2 className="py-2 text-body font-semibold">School</h2>
        <dl className="divide-y divide-line-soft">
          <Fact label="Address">/s/{tenant.slug}</Fact>
          <Fact label="Status">{tenant.status}</Fact>
          {tenant.timezone && <Fact label="Time zone">{tenant.timezone}</Fact>}
          {tenant.county && <Fact label="County">{tenant.county}</Fact>}
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white px-5 py-3">
        <h2 className="py-2 text-body font-semibold">Connection</h2>
        <dl className="divide-y divide-line-soft">
          <Fact label="API">{apiBaseUrl()}</Fact>
          {expires && <Fact label="Sign-in lasts until">{new Date(expires).toLocaleString()}, or sooner if you are idle</Fact>}
        </dl>
        <div className="flex flex-wrap items-center gap-3 py-3">
          <Button onClick={() => void checkConnection()} disabled={checking}>{checking ? "Checking…" : "Check the connection"}</Button>
          {check && <span role="status" className="text-[12.5px] text-ink-muted">{check}</span>}
        </div>
      </section>

      <p className="mt-6 rounded-xl border border-line bg-page px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
        This build is connected to the new system for sign-in and your school's details. The other screens (people, classes,
        attendance, fees and the rest) are being moved over one area at a time, and are not in this build yet.
      </p>

      <Button className="mt-6" onClick={() => void onSignOut()}>Sign out</Button>
    </main>
  );
}
