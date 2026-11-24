import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, adminAccessFor, fetchAiStatus, hasAdminConsole, mayOpenAdminPage } from "@figbloom/shared";
import { BloomFab } from "../components/BloomFab";
import { ConsoleShell } from "../components/ConsoleShell";
import { useAsync } from "../lib/useAsync";
import { ApiOverview, type SchoolSession } from "./ApiOverview";
import { ApiParentConsole } from "./ApiParent";
import { API_ADMIN_PAGES, API_TEACHER_PAGES, adminPageDefs, teacherPageDefs } from "./pages";

// The pages themselves are registered by each area in `./pages/<area>.pages.tsx`, not here: a new area adds a file there and
// does not edit this one. Every other entry of the menus is hidden, and its address sends the person back to their home page.
export { API_ADMIN_PAGES, API_TEACHER_PAGES };

/**
 * The console of a person with admin access: the same shell, menu and page gate as the Supabase app's AdminShell
 * (App.tsx), without the parts that read Supabase (unread counts, the visitor alerts, My HR). The guide and the Ask Bloom button run on /ai/query. Full admins see
 * every page this build has; a teacher or other staff member holding admin areas sees the pages of those areas.
 */
function AdminPage({ page, session, children }: { page: string; session: SchoolSession; children: ReactNode }) {
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant);
  // The guide (and the School assistant's chat) exist only where Bloom is on for the school, as on the Supabase build. While this is
  // being read, or when it cannot be read, the guide stays: it then says why it cannot answer.
  const { data: ai, loading: aiLoading } = useAsync(() => fetchAiStatus(session.tenant.id).catch(() => null), [session.tenant.id]);
  if (!mayOpenAdminPage(access, page)) return <Navigate to={`/s/${session.tenant.slug}/admin`} replace />;
  const full = access === "all";
  const guideOn = aiLoading || ai === null || ai.aiEnabled;
  return (
    <ConsoleShell
      role="school_admin"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.profile.staff_title ?? (full ? "Principal" : "Admin") }}
      hiddenNav={NAV.school_admin.map((i) => i.to).filter((to) => !API_ADMIN_PAGES.includes(to) || !mayOpenAdminPage(access, to))}
      guide={guideOn ? { tenantId: session.tenant.id, adminAreas: !full } : undefined}
    >
      {children}
      {full && <BloomFab console="admin" />}
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
      <BloomFab console="teacher" />
    </ConsoleShell>
  );
}

export function ApiConsole({ session, onSignOut }: { session: SchoolSession; onSignOut: () => Promise<void> }) {
  // A parent has their own console (ApiParent.tsx, its pages registered in pages/parent.pages.tsx); everyone else keeps the admin and teacher ones below.
  if (session.profile.role === "parent") return <ApiParentConsole session={session} />;
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
