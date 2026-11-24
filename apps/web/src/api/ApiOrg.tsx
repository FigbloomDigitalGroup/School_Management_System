import type { ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { fetchMyOrganizations, signOutHere, type Organization } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { TenantTheme } from "../components/TenantTheme";
import { Skeleton } from "../components/ui/Skeleton";
import { OrgSessionCtx, useOrgSessionCtx } from "../lib/orgSessionContext";
import { useAsync } from "../lib/useAsync";
import { useOrgSession } from "../lib/useOrgSession";
import { OrgPicker } from "../screens/OrgPicker";
import { OrgAdmins } from "../screens/org/OrgAdmins";
import { OrgAudit } from "../screens/org/OrgAudit";
import { OrgDashboard } from "../screens/org/OrgDashboard";
import { OrgSchoolDetail } from "../screens/org/OrgSchoolDetail";
import { OrgSchools } from "../screens/org/OrgSchools";

/**
 * The organisation console on an API build (S11, docs/web-on-api/org-console.md): the same screens as the Supabase app's
 * OrgRoutes (App.tsx), with the same gate. The organisation at the address must be one the signed-in org admin runs;
 * anyone else (a school admin, a teacher) goes back through sign-in, which sends them to their own console. What the API
 * cannot back is hidden on the screens themselves (orgCapabilities).
 */
export function ApiOrgRoutes() {
  const { orgSlug = null } = useParams();
  const session = useOrgSession(orgSlug);

  if (session.loading) return <FullPageSkeleton />;
  if (!session.profile || session.profile.role !== "org_admin") return <Navigate to="/signin" replace />;
  if (!session.organization || session.organization.slug !== orgSlug) return <Navigate to="/signin" replace />;
  // The API gives a non-active organisation's admins nothing (no schools, no admins, no audit): say why instead.
  if (session.organization.status !== "active") return <OrgOnHold organization={session.organization} />;

  return (
    <OrgSessionCtx.Provider value={session}>
      <TenantTheme tenant={null}>
        <Routes>
          <Route path="dashboard" element={<OrgShell><OrgDashboard /></OrgShell>} />
          <Route path="schools" element={<OrgShell><OrgSchools /></OrgShell>} />
          <Route path="schools/:tenantId" element={<OrgShell><OrgSchoolDetail /></OrgShell>} />
          <Route path="admins" element={<OrgShell><OrgAdmins /></OrgShell>} />
          <Route path="audit" element={<OrgShell><OrgAudit /></OrgShell>} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </TenantTheme>
    </OrgSessionCtx.Provider>
  );
}

/** `/org-picker` on an API build: the same screen; its data comes from the API (session.ts loadMyWorkspaces). */
export function ApiOrgPicker() {
  return <OrgPicker />;
}

function OrgShell({ children }: { children: ReactNode }) {
  const session = useOrgSessionCtx();
  const { data: myOrgs } = useAsync(() => fetchMyOrganizations(session.profile.id), [session.profile.id]);
  return (
    <ConsoleShell
      role="org_admin"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: "Org admin" }}
      workspaceName={session.organization.name}
      workspaceOptions={myOrgs?.map((o) => ({ slug: o.slug, name: o.name }))}
    >
      {children}
    </ConsoleShell>
  );
}

const HOLD_TEXT: Record<Exclude<Organization["status"], "active">, { title: string; body: string }> = {
  pending: { title: "is under review", body: "A member of the Figbloom team reviews every new organization before it goes live. Sign in again once it is approved." },
  suspended: { title: "is suspended", body: "Its console opens again when Figbloom makes the organization active. Contact Figbloom support if you need it sooner." },
  rejected: { title: "was not approved", body: "Contact Figbloom support if you think this is a mistake." },
};

function OrgOnHold({ organization }: { organization: Organization }) {
  const nav = useNavigate();
  const text = HOLD_TEXT[organization.status as Exclude<Organization["status"], "active">] ?? HOLD_TEXT.pending;
  async function signOut() {
    await signOutHere();
    nav("/signin", { replace: true });
  }
  return (
    <div className="grid min-h-screen place-items-center bg-page p-6 text-center">
      <div className="max-w-[420px]">
        <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-sunken text-lg text-ink-muted" aria-hidden>◷</div>
        <h1 className="text-[17px] font-semibold">{organization.name} {text.title}</h1>
        <p className="mx-auto mt-1.5 text-[13px] leading-relaxed text-ink-muted">{text.body}</p>
        <div className="mt-4 flex justify-center gap-4">
          <button type="button" onClick={() => nav("/org-picker")} className="text-[13px] font-semibold text-forest hover:underline">
            Choose another organization
          </button>
          <button type="button" onClick={() => void signOut()} className="text-[13px] font-semibold text-forest hover:underline">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function FullPageSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-8">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
