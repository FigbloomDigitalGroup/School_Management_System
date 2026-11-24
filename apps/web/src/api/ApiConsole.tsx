import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, adminAccessFor, hasAdminConsole, mayOpenAdminPage } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { Skeleton } from "../components/ui/Skeleton";
import { Announcements } from "../screens/admin/Announcements";
import { AdminClasses } from "../screens/admin/Classes";
import { Fees } from "../screens/admin/Fees";
import { AdminSubjects } from "../screens/admin/Subjects";
import { BankReconciliation } from "../screens/admin/BankReconciliation";
import { TermSetup } from "../screens/admin/TermSetup";
import { Attendance as TeacherAttendance } from "../screens/teacher/Attendance";
import { TeacherReports } from "../screens/teacher/TeacherReports";
import { ApiOverview, type SchoolSession } from "./ApiOverview";

// The People screen is large (its modals pull in a lot), so it loads when it is opened.
const People = lazy(() => import("../screens/admin/People").then((m) => ({ default: m.People })));
const AdminLeave = lazy(() => import("../screens/admin/Leave").then((m) => ({ default: m.AdminLeave })));
const TeacherLeave = lazy(() => import("../screens/teacher/Leave").then((m) => ({ default: m.TeacherLeave })));
const AdminChats = lazy(() => import("../screens/admin/Chats").then((m) => ({ default: m.AdminChats })));
const MyChats = lazy(() => import("../screens/chat/MyChats").then((m) => ({ default: m.MyChats })));
const TeacherNotices = lazy(() => import("../screens/teacher/Notices").then((m) => ({ default: m.TeacherNotices })));
const TeacherMessages = lazy(() => import("../screens/teacher/Messages").then((m) => ({ default: m.TeacherMessages })));

const pageFallback = (
  <div className="space-y-3 p-8">
    <Skeleton className="h-8 w-64" />
    <Skeleton className="h-64 w-full" />
  </div>
);

/**
 * The admin pages that run on the new API, by their address under /s/<slug>/. This is the list that grows: a page is added
 * here, and a route below, once its shared module has an API side (FIG-1890 onwards). Every other entry of the admin menu is
 * hidden, and its address sends the person back to the Dashboard.
 */
export const API_ADMIN_PAGES = [
  "admin", "admin/people", "admin/fees", "admin/settings", "admin/classes", "admin/subjects", "admin/announcements", "admin/leave", "admin/chats",
] as const;

/** Teacher pages available on the API build (FIG-1891). */
export const API_TEACHER_PAGES = ["teacher", "teacher/attendance", "teacher/leave", "teacher/chats", "teacher/notices", "teacher/messages"] as const;

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

function TeacherPage({ session, children }: { session: SchoolSession; children: ReactNode }) {
  return (
    <ConsoleShell
      role="teacher"
      user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.profile.staff_title ?? "Teacher" }}
      hiddenNav={NAV.teacher.map((i) => i.to).filter((to) => !(API_TEACHER_PAGES as readonly string[]).includes(to))}
    >
      {children}
    </ConsoleShell>
  );
}

export function ApiConsole({ session, onSignOut }: { session: SchoolSession; onSignOut: () => Promise<void> }) {
  const access = adminAccessFor(session.profile.role, session.adminAreas, session.actingForTenant);
  if (!hasAdminConsole(access)) {
    if (session.profile.role === "teacher") {
      const teacherHome = `/s/${session.tenant.slug}/teacher`;
      const tPage = (element: ReactNode) => <TeacherPage session={session}>{element}</TeacherPage>;
      return (
        <Routes>
          <Route path="teacher" element={tPage(<ApiOverview session={session} onSignOut={onSignOut} inShell />)} />
          <Route path="teacher/attendance" element={tPage(<TeacherAttendance />)} />
          <Route path="teacher/leave" element={tPage(<Suspense fallback={pageFallback}><TeacherLeave /></Suspense>)} />
          <Route path="teacher/chats" element={tPage(<Suspense fallback={pageFallback}><MyChats role="teacher" /></Suspense>)} />
          <Route path="teacher/notices" element={tPage(<Suspense fallback={pageFallback}><TeacherNotices /></Suspense>)} />
          <Route path="teacher/messages" element={tPage(<Suspense fallback={pageFallback}><TeacherMessages /></Suspense>)} />
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
      <Route path="admin/people" element={page("admin/people", <Suspense fallback={pageFallback}><People /></Suspense>)} />
      <Route path="admin/fees" element={page("admin/fees", <Fees />)} />
      <Route path="admin/settings" element={page("admin/settings", <TermSetup />)} />
      <Route path="admin/classes" element={page("admin/classes", <AdminClasses />)} />
      <Route path="admin/subjects" element={page("admin/subjects", <AdminSubjects />)} />
      <Route path="admin/announcements" element={page("admin/announcements", <Announcements />)} />
      <Route path="admin/leave" element={page("admin/leave", <Suspense fallback={pageFallback}><AdminLeave /></Suspense>)} />
      <Route path="admin/chats" element={page("admin/chats", <Suspense fallback={pageFallback}><AdminChats /></Suspense>)} />
      <Route path="admin/bank-reconciliation" element={page("admin/fees", <BankReconciliation />)} />
      <Route path="teacher/attendance" element={page("admin", <TeacherAttendance />)} />
      <Route path="teacher/leave" element={page("admin", <Suspense fallback={pageFallback}><TeacherLeave /></Suspense>)} />
      <Route path="teacher/reports" element={page("admin", <TeacherReports />)} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
