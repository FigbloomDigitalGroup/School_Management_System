import { lazy, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { NAV, adminAccessFor, apiFetchMyStaffRecord, fetchAiStatus, hasAdminConsole, logOrganizationAccess, mayOpenAdminPage, showsAdminSwitch, showsLeaveToApprove } from "@figbloom/shared";
import { BloomFab } from "../components/BloomFab";
import { ConsoleShell } from "../components/ConsoleShell";
import { useAsync } from "../lib/useAsync";
import { useHrItem } from "../lib/useHrItem";
import { useHrLeaveAccess } from "../lib/useHrLeave";
import { ApiDriverConsole } from "./ApiDriver";
import { ApiOverview, type SchoolSession } from "./ApiOverview";
import { ApiParentConsole } from "./ApiParent";
import { ApiStaffHome } from "./ApiStaffHome";
import { ApiStudentConsole } from "./ApiStudent";
import { API_ADMIN_PAGES, API_STAFF_PAGES, API_TEACHER_PAGES, adminPageDefs, staffPageDefs, staffPagesFor, teacherPageDefs } from "./pages";
import { Lazy } from "./pages/Lazy";

const AdminDashboard = lazy(() => import("../screens/admin/Dashboard").then((m) => ({ default: m.AdminDashboard })));
const AreasHome = lazy(() => import("../screens/admin/AreasHome").then((m) => ({ default: m.AreasHome })));

function adminPagesFor(leaveAccess: ReturnType<typeof useHrLeaveAccess>, delegatedOrgConsole = false): readonly string[] {
  const pages = showsLeaveToApprove(leaveAccess)
    ? API_ADMIN_PAGES
    : API_ADMIN_PAGES.filter((page) => page !== "admin/leave-to-approve");
  return delegatedOrgConsole ? pages.filter((page) => page !== "admin/my-hr" && page !== "admin/leave-to-approve") : pages;
}

function ApiAdminHome({ session }: { session: SchoolSession }) {
  const leaveAccess = useHrLeaveAccess(session);
  return adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant, session.delegatedOrgConsole) === "all"
    ? <AdminDashboard />
    : <AreasHome allowedPages={adminPagesFor(leaveAccess, session.delegatedOrgConsole)} />;
}

// The pages themselves are registered by each area in `./pages/<area>.pages.tsx`, not here: a new area adds a file there and
// does not edit this one. Every other entry of the menus is hidden, and its address sends the person back to their home page.
export { API_ADMIN_PAGES, API_STAFF_PAGES, API_TEACHER_PAGES };

/**
 * The console of a person with admin access: the same shell, menu and page gate as the Supabase app's AdminShell
 * (App.tsx), without the parts that read Supabase (unread counts, the visitor alerts). The guide and the Ask Bloom button run on /ai/query. Full admins see
 * every page this build has; teachers and other staff see their areas, and organization delegates see only their delegated areas. The "HR & Payroll" side item
 * (`sideActions`, lib/useHrItem.ts) is in all three shells, as on Supabase: it asks the API whether the hand-off is on and shows only then.
 */
function AdminPage({ page, session, children }: { page: string; session: SchoolSession; children: ReactNode }) {
  const nav = useNavigate();
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant, session.delegatedOrgConsole);
  const leaveAccess = useHrLeaveAccess(session);
  const hrItem = useHrItem(session);
  // The guide (and the School assistant's chat) exist only where Bloom is on for the school, as on the Supabase build. While this is
  // being read, or when it cannot be read, the guide stays: it then says why it cannot answer.
  const { data: ai, loading: aiLoading } = useAsync(() => fetchAiStatus(session.tenant.id).catch(() => null), [session.tenant.id]);
  if (!mayOpenAdminPage(access, page) || (session.delegatedOrgConsole && (page === "admin/my-hr" || page === "admin/leave-to-approve"))) return <Navigate to={`/s/${session.tenant.slug}/admin`} replace />;
  const full = access === "all";
  const guideOn = aiLoading || ai === null || ai.aiEnabled;
  async function exitToOrganization() {
    const org = session.actingOrganization;
    if (org) await logOrganizationAccess(org.id, session.profile.id, "exited_school_console", session.tenant.id).catch(() => {});
    nav(org ? `/org/${encodeURIComponent(org.slug)}/schools/${session.tenant.id}` : "/signin");
  }
  return (
    <ConsoleShell
      role="school_admin"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.delegatedOrgConsole ? "Org admin (acting)" : session.profile.staff_title ?? (full ? "Principal" : "Admin") }}
      hiddenNav={NAV.school_admin.map((i) => i.to).filter((to) => !adminPagesFor(leaveAccess, session.delegatedOrgConsole).includes(to) || !mayOpenAdminPage(access, to))}
      consoleSwitch={session.profile.role === "staff" && showsAdminSwitch("staff", session.adminAreas)
        ? { current: "admin", ownLabel: "Staff", ownTo: "staff", adminTo: "admin" }
        : undefined}
      sideActions={hrItem}
      actingBanner={session.actingForTenant && session.actingOrganization ? {
        orgName: session.actingOrganization.name,
        schoolName: session.tenant.name,
        onExit: () => void exitToOrganization(),
      } : undefined}
      guide={guideOn ? { tenantId: session.tenant.id, adminAreas: !full } : undefined}
    >
      {children}
      {full && <BloomFab console="admin" />}
    </ConsoleShell>
  );
}

function TeacherPage({ session, children }: { session: SchoolSession; children: ReactNode }) {
  const hrItem = useHrItem(session);
  return (
    <ConsoleShell
      role="teacher"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.profile.staff_title ?? "Teacher" }}
      hiddenNav={NAV.teacher.map((i) => i.to).filter((to) => !API_TEACHER_PAGES.includes(to))}
      sideActions={hrItem}
    >
      {children}
      <BloomFab console="teacher" />
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
  const hrItem = useHrItem(session);
  return (
    <ConsoleShell
      role="staff"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: record?.staff_title ?? "Staff" }}
      hiddenNav={NAV.staff.map((i) => i.to).filter((to) => !pages.includes(to))}
      consoleSwitch={showsAdminSwitch("staff", session.adminAreas) ? { current: "own", ownLabel: "Staff", ownTo: "staff", adminTo: "admin" } : undefined}
      sideActions={hrItem}
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
  // A parent has their own console (ApiParent.tsx, its pages registered in pages/parent.pages.tsx); everyone else keeps the admin and teacher ones below.
  if (session.profile.role === "parent") return <ApiParentConsole session={session} />;
  // A learner has their own console too (ApiStudent.tsx, its pages registered in pages/student*.pages.tsx).
  if (session.profile.role === "student") return <ApiStudentConsole session={session} />;
  // A driver has their own full-width pages (ApiDriver.tsx), not the console.
  if (session.profile.role === "driver") return <ApiDriverConsole session={session} />;
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant, session.delegatedOrgConsole);
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
      <Route path="admin" element={page("admin", <Lazy><ApiAdminHome session={session} /></Lazy>)} />
      {adminPageDefs.map((p) => <Route key={p.path} path={p.path} element={page(p.menu ?? p.path, p.element)} />)}
      {/* A teacher who holds admin areas lands in this console and has no console switch on the API build yet: their teacher
          pages are reachable by address only. */}
      {(session.delegatedOrgConsole ? [] : teacherPageDefs)
        .filter((p) => p.inAdminConsole !== false)
        .map((p) => <Route key={p.path} path={p.path} element={page("admin", p.element)} />)}
      {isStaff && staffRoutes(session)}
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
