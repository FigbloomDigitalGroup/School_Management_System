import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, adminAccessFor, apiFetchMyStaffRecord, hasAdminConsole, mayOpenAdminPage, showsAdminSwitch } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { useAsync } from "../lib/useAsync";
import { ApiOverview, type SchoolSession } from "./ApiOverview";
import { ApiStaffHome } from "./ApiStaffHome";
import { API_ADMIN_PAGES, API_STAFF_PAGES, API_TEACHER_PAGES, adminPageDefs, staffPageDefs, staffPagesFor, teacherPageDefs } from "./pages";

// The pages themselves are registered by each area in `./pages/<area>.pages.tsx`, not here: a new area adds a file there and
// does not edit this one. Every other entry of the menus is hidden, and its address sends the person back to their home page.
export { API_ADMIN_PAGES, API_STAFF_PAGES, API_TEACHER_PAGES };

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
      consoleSwitch={session.profile.role === "staff" && showsAdminSwitch("staff", session.adminAreas)
        ? { current: "admin", ownLabel: "Staff", ownTo: "staff", adminTo: "admin" }
        : undefined}
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

/**
 * The console of other staff (role "staff"): the librarian, the nurse, the receptionist. Its own menu (NAV.staff, cut down to the
 * pages `staff-shell.pages.tsx` registers) and, for someone holding admin areas, the same "Staff | Admin" switch as the Supabase app.
 */
function StaffPage({ session, children }: { session: SchoolSession; children: ReactNode }) {
  // The job title is the person's own staff record: the session carries none on the API. Until it is read (or if it cannot be), "Staff".
  const { data: record } = useAsync(() => apiFetchMyStaffRecord(session.tenant.id).catch(() => null), [session.tenant.id]);
  const pages = staffPagesFor(session.adminAreas);
  return (
    <ConsoleShell
      role="staff"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: record?.staff_title ?? "Staff" }}
      hiddenNav={NAV.staff.map((i) => i.to).filter((to) => !pages.includes(to))}
      consoleSwitch={showsAdminSwitch("staff", session.adminAreas) ? { current: "own", ownLabel: "Staff", ownTo: "staff", adminTo: "admin" } : undefined}
    >
      {children}
    </ConsoleShell>
  );
}

/** The routes of the staff console, for ApiConsole's two route tables (a staff member with no admin areas, and one with some). */
function staffRoutes(session: SchoolSession) {
  const pages = staffPagesFor(session.adminAreas);
  const sPage = (element: ReactNode) => <StaffPage session={session}>{element}</StaffPage>;
  return (
    <>
      <Route path="staff" element={sPage(<ApiStaffHome session={session} pages={pages} />)} />
      {staffPageDefs
        .filter((p) => pages.includes(p.path))
        .map((p) => <Route key={p.path} path={p.path} element={sPage(p.element)} />)}
    </>
  );
}

export function ApiConsole({ session, onSignOut }: { session: SchoolSession; onSignOut: () => Promise<void> }) {
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant);
  const isStaff = session.profile.role === "staff";
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
    if (isStaff) {
      return (
        <Routes>
          {staffRoutes(session)}
          <Route path="*" element={<Navigate to={`/s/${session.tenant.slug}/staff`} replace />} />
        </Routes>
      );
    }
    return <ApiOverview session={session} onSignOut={onSignOut} inShell={false} />;
  }

  // Other staff who hold admin areas open in their own console, as on Supabase, and switch to the admin one.
  const home = `/s/${session.tenant.slug}/${isStaff ? "staff" : "admin"}`;
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
      {isStaff && staffRoutes(session)}
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
