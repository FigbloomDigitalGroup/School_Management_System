import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, adminAccessFor, apiFetchMyStaffRecord, hasAdminConsole, mayOpenAdminPage, showsAdminSwitch, staffMayReadItems } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { Skeleton } from "../components/ui/Skeleton";
import { useAsync } from "../lib/useAsync";
import { Announcements } from "../screens/admin/Announcements";
import { AdminClasses } from "../screens/admin/Classes";
import { Fees } from "../screens/admin/Fees";
import { AdminSubjects } from "../screens/admin/Subjects";
import { BankReconciliation } from "../screens/admin/BankReconciliation";
import { TermSetup } from "../screens/admin/TermSetup";
import { Attendance as TeacherAttendance } from "../screens/teacher/Attendance";
import { TeacherReports } from "../screens/teacher/TeacherReports";
import { ApiOverview, type SchoolSession } from "./ApiOverview";
import { ApiStaffHome } from "./ApiStaffHome";

// The People screen is large (its modals pull in a lot), so it loads when it is opened.
const People = lazy(() => import("../screens/admin/People").then((m) => ({ default: m.People })));
const AdminLeave = lazy(() => import("../screens/admin/Leave").then((m) => ({ default: m.AdminLeave })));
const TeacherLeave = lazy(() => import("../screens/teacher/Leave").then((m) => ({ default: m.TeacherLeave })));
const AdminCourses = lazy(() => import("../screens/admin/Courses").then((m) => ({ default: m.AdminCourses })));
const TeacherTimetable = lazy(() => import("../screens/teacher/Timetable").then((m) => ({ default: m.TeacherTimetable })));
const TeacherClasses = lazy(() => import("../screens/teacher/Classes").then((m) => ({ default: m.TeacherClasses })));
const AdminInventory = lazy(() => import("../screens/admin/Inventory").then((m) => ({ default: m.AdminInventory })));
const AccessRoles = lazy(() => import("../screens/admin/AccessRoles").then((m) => ({ default: m.AccessRoles })));
const AdminAccount = lazy(() => import("../screens/admin/Account").then((m) => ({ default: m.AdminAccount })));
const TeacherAccount = lazy(() => import("../screens/teacher/Account").then((m) => ({ default: m.TeacherAccount })));
const StaffAccount = lazy(() => import("../screens/staff/Staff").then((m) => ({ default: m.StaffAccount })));
const StaffNotices = lazy(() => import("../screens/staff/Staff").then((m) => ({ default: m.StaffNotices })));
const StaffItems = lazy(() => import("../screens/teacher/Items").then((m) => ({ default: m.TeacherItems })));
const AdminChats = lazy(() => import("../screens/admin/Chats").then((m) => ({ default: m.AdminChats })));
const MyChats = lazy(() => import("../screens/chat/MyChats").then((m) => ({ default: m.MyChats })));
const TeacherNotices = lazy(() => import("../screens/teacher/Notices").then((m) => ({ default: m.TeacherNotices })));
const TeacherMessages = lazy(() => import("../screens/teacher/Messages").then((m) => ({ default: m.TeacherMessages })));
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
  "admin/access", "admin/account", "admin/chats", "admin/exams", "admin/performance", "admin/reports", "admin/courses",
] as const;

/** Teacher pages available on the API build (FIG-1891). */
export const API_TEACHER_PAGES = ["teacher", "teacher/attendance", "teacher/leave", "teacher/account", "teacher/chats", "teacher/notices", "teacher/messages", "teacher/gradebook", "teacher/performance", "teacher/timetable", "teacher/classes"] as const;

/**
 * Staff pages (role "staff") on the API build, by their address under /s/<slug>/. Not here, and so not in the menu: Visitors (the
 * visitors module is not on the API yet), Loans and My HR (there is no HR product on the API). `staff/items` joins for people
 * holding the Inventory area (see staffPages).
 */
export const API_STAFF_PAGES = ["staff", "staff/notices", "staff/chats", "staff/leave", "staff/account"] as const;

/** The staff pages in this person's menu: the fixed list, plus My items for someone the API lets read it (staffMayReadItems). */
function staffPages(session: SchoolSession): readonly string[] {
  return staffMayReadItems(session.adminAreas) ? [...API_STAFF_PAGES, "staff/items"] : API_STAFF_PAGES;
}

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
      hiddenNav={NAV.teacher.map((i) => i.to).filter((to) => !(API_TEACHER_PAGES as readonly string[]).includes(to))}
    >
      {children}
    </ConsoleShell>
  );
}

/**
 * The console of other staff (role "staff"): the librarian, the nurse, the receptionist. Its own menu (NAV.staff, cut down to what
 * runs on the API) and, for someone holding admin areas, the same "Staff | Admin" switch as the Supabase app.
 */
function StaffPage({ session, children }: { session: SchoolSession; children: ReactNode }) {
  // The job title is the person's own staff record: the session carries none on the API. Until it is read (or if it cannot be), "Staff".
  const { data: record } = useAsync(() => apiFetchMyStaffRecord(session.tenant.id).catch(() => null), [session.tenant.id]);
  const pages = staffPages(session);
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
  const pages = staffPages(session);
  const sPage = (element: ReactNode) => <StaffPage session={session}>{element}</StaffPage>;
  return (
    <>
      <Route path="staff" element={sPage(<ApiStaffHome session={session} pages={pages} />)} />
      <Route path="staff/notices" element={sPage(<Suspense fallback={pageFallback}><StaffNotices /></Suspense>)} />
      <Route path="staff/chats" element={sPage(<Suspense fallback={pageFallback}><MyChats role="staff" /></Suspense>)} />
      <Route path="staff/leave" element={sPage(<Suspense fallback={pageFallback}><TeacherLeave /></Suspense>)} />
      <Route path="staff/account" element={sPage(<Suspense fallback={pageFallback}><StaffAccount /></Suspense>)} />
      {pages.includes("staff/items") && <Route path="staff/items" element={sPage(<Suspense fallback={pageFallback}><StaffItems /></Suspense>)} />}
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
          <Route path="teacher/attendance" element={tPage(<TeacherAttendance />)} />
          <Route path="teacher/leave" element={tPage(<Suspense fallback={pageFallback}><TeacherLeave /></Suspense>)} />
          <Route path="teacher/timetable" element={tPage(<Suspense fallback={pageFallback}><TeacherTimetable /></Suspense>)} />
          <Route path="teacher/classes" element={tPage(<Suspense fallback={pageFallback}><TeacherClasses /></Suspense>)} />
          <Route path="teacher/account" element={tPage(<Suspense fallback={pageFallback}><TeacherAccount /></Suspense>)} />
          <Route path="teacher/chats" element={tPage(<Suspense fallback={pageFallback}><MyChats role="teacher" /></Suspense>)} />
          <Route path="teacher/notices" element={tPage(<Suspense fallback={pageFallback}><TeacherNotices /></Suspense>)} />
          <Route path="teacher/messages" element={tPage(<Suspense fallback={pageFallback}><TeacherMessages /></Suspense>)} />
          <Route path="teacher/gradebook" element={tPage(<Suspense fallback={pageFallback}><GradebookRouter /></Suspense>)} />
          <Route path="teacher/performance" element={tPage(<Suspense fallback={pageFallback}><Performance teacher /></Suspense>)} />
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
      <Route path="admin/people" element={page("admin/people", <Suspense fallback={pageFallback}><People /></Suspense>)} />
      <Route path="admin/fees" element={page("admin/fees", <Fees />)} />
      <Route path="admin/settings" element={page("admin/settings", <TermSetup />)} />
      <Route path="admin/classes" element={page("admin/classes", <AdminClasses />)} />
      <Route path="admin/subjects" element={page("admin/subjects", <AdminSubjects />)} />
      <Route path="admin/announcements" element={page("admin/announcements", <Announcements />)} />
      <Route path="admin/leave" element={page("admin/leave", <Suspense fallback={pageFallback}><AdminLeave /></Suspense>)} />
      <Route path="admin/courses" element={page("admin/courses", <Suspense fallback={pageFallback}><AdminCourses /></Suspense>)} />
      <Route path="admin/inventory" element={page("admin/inventory", <Suspense fallback={pageFallback}><AdminInventory /></Suspense>)} />
      <Route path="admin/access" element={page("admin/access", <Suspense fallback={pageFallback}><AccessRoles /></Suspense>)} />
      <Route path="admin/account" element={page("admin/account", <Suspense fallback={pageFallback}><AdminAccount /></Suspense>)} />
      <Route path="admin/chats" element={page("admin/chats", <Suspense fallback={pageFallback}><AdminChats /></Suspense>)} />
      <Route path="admin/exams" element={page("admin/exams", <Suspense fallback={pageFallback}><AdminExams /></Suspense>)} />
      <Route path="admin/performance" element={page("admin/performance", <Suspense fallback={pageFallback}><Performance /></Suspense>)} />
      <Route path="admin/reports" element={page("admin/reports", <Suspense fallback={pageFallback}><AdminReports /></Suspense>)} />
      <Route path="admin/bank-reconciliation" element={page("admin/fees", <BankReconciliation />)} />
      <Route path="teacher/attendance" element={page("admin", <TeacherAttendance />)} />
      <Route path="teacher/leave" element={page("admin", <Suspense fallback={pageFallback}><TeacherLeave /></Suspense>)} />
      <Route path="teacher/timetable" element={page("admin", <Suspense fallback={pageFallback}><TeacherTimetable /></Suspense>)} />
      <Route path="teacher/classes" element={page("admin", <Suspense fallback={pageFallback}><TeacherClasses /></Suspense>)} />
      <Route path="teacher/reports" element={page("admin", <TeacherReports />)} />
      {/* A teacher who holds admin areas lands here and has no console switch on the API build yet: their teacher chats, notices and
          messages are reachable by address only, as teacher/leave is. */}
      <Route path="teacher/chats" element={page("admin", <Suspense fallback={pageFallback}><MyChats role="teacher" /></Suspense>)} />
      <Route path="teacher/notices" element={page("admin", <Suspense fallback={pageFallback}><TeacherNotices /></Suspense>)} />
      <Route path="teacher/messages" element={page("admin", <Suspense fallback={pageFallback}><TeacherMessages /></Suspense>)} />
      <Route path="teacher/gradebook" element={page("admin", <Suspense fallback={pageFallback}><GradebookRouter /></Suspense>)} />
      <Route path="teacher/performance" element={page("admin", <Suspense fallback={pageFallback}><Performance teacher /></Suspense>)} />
      {isStaff && staffRoutes(session)}
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
