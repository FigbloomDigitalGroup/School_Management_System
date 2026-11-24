import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, adminAccessFor, hasAdminConsole, mayOpenAdminPage } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { ApiDriverConsole } from "./ApiDriver";
import { ApiOverview, type SchoolSession } from "./ApiOverview";
import { API_ADMIN_PAGES, API_TEACHER_PAGES, adminPageDefs, teacherPageDefs } from "./pages";

// The pages themselves are registered by each area in `./pages/<area>.pages.tsx`, not here: a new area adds a file there and
// does not edit this one. Every other entry of the menus is hidden, and its address sends the person back to their home page.
export { API_ADMIN_PAGES, API_TEACHER_PAGES };

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
      hiddenNav={NAV.school_admin.map((i) => i.to).filter((to) => !API_ADMIN_PAGES.includes(to) || !mayOpenAdminPage(access, to))}
    >
      {children}
    </ConsoleShell>
  );
}

function TeacherPage({ session, children }: { session: SchoolSession; children: ReactNode }) {
  return (
    <ConsoleShell
      role="teacher"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.profile.staff_title ?? "Teacher" }}
      hiddenNav={NAV.teacher.map((i) => i.to).filter((to) => !API_TEACHER_PAGES.includes(to))}
    >
      {children}
    </ConsoleShell>
  );
}

export function ApiConsole({ session, onSignOut }: { session: SchoolSession; onSignOut: () => Promise<void> }) {
  // A driver has their own full-width pages (ApiDriver.tsx), not the console.
  if (session.profile.role === "driver") return <ApiDriverConsole session={session} />;
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant);
  if (!hasAdminConsole(access)) {
    if (session.profile.role === "teacher") {
      const teacherHome = `/s/${session.tenant.slug}/teacher`;
      const tPage = (element: ReactNode) => <TeacherPage session={session}>{element}</TeacherPage>;
      return (
        <Routes>
          <Route path="teacher" element={tPage(<ApiOverview session={session} onSignOut={onSignOut} inShell />)} />
          {teacherPageDefs
            .filter((p) => p.inTeacherConsole !== false)
            .map((p) => <Route key={p.path} path={p.path} element={tPage(p.element)} />)}
          <Route path="*" element={<Navigate to={teacherHome} replace />} />
        </Routes>
      );
    }
    return <ApiOverview session={session} onSignOut={onSignOut} inShell={false} />;
  }

  const home = `/s/${session.tenant.slug}/admin`;
  const page = (to: string, element: ReactNode) => <AdminPage page={to} session={session}>{element}</AdminPage>;
  return (
    <Routes>
      <Route path="admin" element={page("admin", <ApiOverview session={session} onSignOut={onSignOut} inShell />)} />
      {adminPageDefs.map((p) => <Route key={p.path} path={p.path} element={page(p.menu ?? p.path, p.element)} />)}
      {/* A teacher who holds admin areas lands in this console and has no console switch on the API build yet: their teacher
          pages are reachable by address only. */}
      {teacherPageDefs
        .filter((p) => p.inAdminConsole !== false)
        .map((p) => <Route key={p.path} path={p.path} element={page("admin", p.element)} />)}
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
