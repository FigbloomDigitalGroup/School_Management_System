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
const ReportCards = lazy(() => import("../screens/admin/ReportCards").then((m) => ({ default: m.ReportCards })));
const AdminInventory = lazy(() => import("../screens/admin/Inventory").then((m) => ({ default: m.AdminInventory })));
const AccessRoles = lazy(() => import("../screens/admin/AccessRoles").then((m) => ({ default: m.AccessRoles })));
const AdminAccount = lazy(() => import("../screens/admin/Account").then((m) => ({ default: m.AdminAccount })));
const TeacherAccount = lazy(() => import("../screens/teacher/Account").then((m) => ({ default: m.TeacherAccount })));
// The grades screens (the charts and the gradebooks are large) load when they are opened.
const AdminExams = lazy(() => import("../screens/admin/Exams").then((m) => ({ default: m.Exams })));
const AdminReports = lazy(() => import("../screens/admin/Reports").then((m) => ({ default: m.AdminReports })));
const Performance = lazy(() => import("../screens/admin/Performance").then((m) => ({ default: m.Performance })));
const GradebookRouter = lazy(() => import("../screens/teacher/GradebookRouter").then((m) => ({ default: m.GradebookRouter })));

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
  "admin", "admin/people", "admin/fees", "admin/settings", "admin/classes", "admin/subjects", "admin/announcements", "admin/inventory", "admin/leave",
  "admin/access", "admin/account", "admin/exams", "admin/performance", "admin/reports", "admin/report-cards",
] as const;

/** Teacher pages available on the API build (FIG-1891). */
export const API_TEACHER_PAGES = ["teacher", "teacher/attendance", "teacher/leave", "teacher/account", "teacher/gradebook", "teacher/performance", "teacher/report-cards"] as const;

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
          <Route path="teacher/report-cards" element={tPage(<Suspense fallback={pageFallback}><ReportCards teacher /></Suspense>)} />
          <Route path="teacher/account" element={tPage(<Suspense fallback={pageFallback}><TeacherAccount /></Suspense>)} />
          <Route path="teacher/gradebook" element={tPage(<Suspense fallback={pageFallback}><GradebookRouter /></Suspense>)} />
          <Route path="teacher/performance" element={tPage(<Suspense fallback={pageFallback}><Performance teacher /></Suspense>)} />
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
      <Route path="admin/report-cards" element={page("admin/report-cards", <Suspense fallback={pageFallback}><ReportCards /></Suspense>)} />
      <Route path="admin/inventory" element={page("admin/inventory", <Suspense fallback={pageFallback}><AdminInventory /></Suspense>)} />
      <Route path="admin/access" element={page("admin/access", <Suspense fallback={pageFallback}><AccessRoles /></Suspense>)} />
      <Route path="admin/account" element={page("admin/account", <Suspense fallback={pageFallback}><AdminAccount /></Suspense>)} />
      <Route path="admin/exams" element={page("admin/exams", <Suspense fallback={pageFallback}><AdminExams /></Suspense>)} />
      <Route path="admin/performance" element={page("admin/performance", <Suspense fallback={pageFallback}><Performance /></Suspense>)} />
      <Route path="admin/reports" element={page("admin/reports", <Suspense fallback={pageFallback}><AdminReports /></Suspense>)} />
      <Route path="admin/bank-reconciliation" element={page("admin/fees", <BankReconciliation />)} />
      <Route path="teacher/attendance" element={page("admin", <TeacherAttendance />)} />
      <Route path="teacher/leave" element={page("admin", <Suspense fallback={pageFallback}><TeacherLeave /></Suspense>)} />
      <Route path="teacher/report-cards" element={page("admin", <Suspense fallback={pageFallback}><ReportCards teacher /></Suspense>)} />
      <Route path="teacher/reports" element={page("admin", <TeacherReports />)} />
      <Route path="teacher/gradebook" element={page("admin", <Suspense fallback={pageFallback}><GradebookRouter /></Suspense>)} />
      <Route path="teacher/performance" element={page("admin", <Suspense fallback={pageFallback}><Performance teacher /></Suspense>)} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
