import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, adminAccessFor, hasAdminConsole, mayOpenAdminPage } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { AdminClasses } from "../screens/admin/Classes";
import { AdminSubjects } from "../screens/admin/Subjects";
import { TermSetup } from "../screens/admin/TermSetup";
import { ApiOverview, type SchoolSession } from "./ApiOverview";

/**
 * The admin pages that run on the new API, by their address under /s/<slug>/. This is the list that grows: a page is added
 * here, and a route below, once its shared module has an API side (FIG-1890 onwards). Every other entry of the admin menu is
 * hidden, and its address sends the person back to the Dashboard.
 */
export const API_ADMIN_PAGES = ["admin", "admin/settings", "admin/classes", "admin/subjects"] as const;

/**
 * The console of a person with admin access: the same shell, menu and page gate as the Supabase app's AdminShell
 * (App.tsx), without the parts that read Supabase (unread counts, the guide, the visitor alerts, My HR). Full admins see
 * every page this build has; a teacher or other staff member holding admin areas sees the pages of those areas.
 */
function AdminPage({ page, session, children }: { page: string; session: SchoolSession; children: ReactNode }) {
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant);
  if (!mayOpenAdminPage(access, page)) return <Navigate to={`/s/${session.tenant.slug}/admin`} replace />;
  const full = access === "all";
  return (
    <ConsoleShell
      role="school_admin"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.profile.staff_title ?? (full ? "Principal" : "Admin") }}
      hiddenNav={NAV.school_admin.map((i) => i.to).filter((to) => !(API_ADMIN_PAGES as readonly string[]).includes(to) || !mayOpenAdminPage(access, to))}
    >
      {children}
    </ConsoleShell>
  );
}

export function ApiConsole({ session, onSignOut }: { session: SchoolSession; onSignOut: () => Promise<void> }) {
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant);
  // No admin console (a parent, a learner, a teacher with no admin areas): the page that says who they are and nothing else yet.
  if (!hasAdminConsole(access)) return <ApiOverview session={session} onSignOut={onSignOut} inShell={false} />;

  const home = `/s/${session.tenant.slug}/admin`;
  const page = (to: string, element: ReactNode) => <AdminPage page={to} session={session}>{element}</AdminPage>;
  return (
    <Routes>
      <Route path="admin" element={page("admin", <ApiOverview session={session} onSignOut={onSignOut} inShell />)} />
      <Route path="admin/settings" element={page("admin/settings", <TermSetup />)} />
      <Route path="admin/classes" element={page("admin/classes", <AdminClasses />)} />
      <Route path="admin/subjects" element={page("admin/subjects", <AdminSubjects />)} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
