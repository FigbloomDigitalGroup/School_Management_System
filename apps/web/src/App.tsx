import type { ReactNode } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { homeRouteFor, roleLabel, supabase, type Role } from "@figbloom/shared";
import { TenantTheme } from "./components/TenantTheme";
import { ToastHost } from "./components/ui/Toast";
import { ConsoleShell } from "./components/ConsoleShell";
import { Skeleton } from "./components/ui/Skeleton";
import { useAsync } from "./lib/useAsync";
import { useSession } from "./lib/useSession";
import { SessionCtx, useTenantSession } from "./lib/sessionContext";
import { ParentDataProvider } from "./lib/parentContext";
import { StudentDataProvider } from "./lib/studentContext";

import { SignIn } from "./screens/SignIn";
import { ResetPassword } from "./screens/ResetPassword";
import { Tenants } from "./screens/platform/Tenants";
import { Organizations } from "./screens/platform/Organizations";
import { Audit, Health, Impersonation, Incidents, Invoices, Subscriptions, Usage } from "./screens/platform/pages";

import { AdminDashboard } from "./screens/admin/Dashboard";
import { People } from "./screens/admin/People";
import { Fees } from "./screens/admin/Fees";
import { Announcements } from "./screens/admin/Announcements";
import { TermSetup } from "./screens/admin/TermSetup";
import { Fleet } from "./screens/admin/Fleet";
import { AdminClasses } from "./screens/admin/Classes";
import { AdminCourses } from "./screens/admin/Courses";
import { AdminReports } from "./screens/admin/Reports";

import { Attendance } from "./screens/teacher/Attendance";
import { Gradebook } from "./screens/teacher/Gradebook";
import { GpaGradebook } from "./screens/teacher/GpaGradebook";
import { TeacherTimetable } from "./screens/teacher/Timetable";
import { TeacherClasses } from "./screens/teacher/Classes";
import { TeacherMySections } from "./screens/teacher/MySections";
import { TeacherMessages } from "./screens/teacher/Messages";

import { ParentHome } from "./screens/parent/Home";
import { ParentFees } from "./screens/parent/Fees";
import { ParentResults } from "./screens/parent/Results";
import { ParentBus } from "./screens/parent/Bus";
import { ParentInbox } from "./screens/parent/Inbox";
import { ParentSettings } from "./screens/parent/Settings";

import { StudentToday } from "./screens/student/Today";
import { StudentTimetable } from "./screens/student/Timetable";
import { StudentWork } from "./screens/student/Work";
import { StudentResults } from "./screens/student/Results";
import { StudentFees } from "./screens/student/Fees";
import { StudentNotices } from "./screens/student/Notices";

import { DriverTrip } from "./screens/driver/Trip";

/**
 * Routing mirrors the tenancy model: /platform/* is cross-tenant and belongs to
 * Figbloom staff; everything else lives under /s/<slug>/ so a school's URL is
 * stable and one deployment serves all of them.
 */
export function App() {
  return (
    <ToastHost>
      <Routes>
        <Route path="/" element={<Navigate to="/signin" replace />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route path="/platform" element={<Navigate to="/platform/tenants" replace />} />
        <Route path="/platform/:page" element={<PlatformShell />} />

        <Route path="/s/:slug/*" element={<TenantRoutes />} />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </ToastHost>
  );
}

const PLATFORM_PAGES: Record<string, JSX.Element> = {
  tenants: <Tenants />,
  organizations: <Organizations />,
  health: <Health />,
  usage: <Usage />,
  incidents: <Incidents />,
  subscriptions: <Subscriptions />,
  invoices: <Invoices />,
  impersonation: <Impersonation />,
  audit: <Audit />,
};

/** Counts, not fake round numbers — a badge is omitted rather than shown as "0". */
async function fetchNavBadges(): Promise<Record<string, string>> {
  const sb = supabase();
  const [{ count: tenantCount }, { count: openIncidents }, { count: dueInvoices }] = await Promise.all([
    sb.from("tenants").select("id", { count: "exact", head: true }),
    sb.from("platform_incidents").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    sb.from("platform_invoices").select("id", { count: "exact", head: true }).eq("status", "due"),
  ]);
  const badges: Record<string, string> = {};
  if (tenantCount) badges["/platform/tenants"] = String(tenantCount);
  if (openIncidents) badges["/platform/incidents"] = String(openIncidents);
  if (dueInvoices) badges["/platform/invoices"] = String(dueInvoices);
  return badges;
}

function PlatformShell() {
  const { page = "tenants" } = useParams();
  const session = useSession(null);
  const { data: badges } = useAsync(() => fetchNavBadges(), []);

  if (session.loading) return <FullPageSkeleton />;
  if (!session.profile) return <Navigate to="/signin" replace />;
  if (session.profile.role !== "super_admin") return <Navigate to={homeRouteFor(session.profile.role, session.tenant?.slug ?? null, session.tenant?.institution_type)} replace />;

  const body = PLATFORM_PAGES[page] ?? <NotFound />;
  const bare = page === "tenants" || page === "organizations";

  return (
    <TenantTheme tenant={null}>
      <ConsoleShell
        role="super_admin"
        user={{ name: session.profile.full_name, roleLabel: "Super admin" }}
        badges={badges ?? {}}
      >
        {bare ? <div className="h-screen">{body}</div> : body}
      </ConsoleShell>
    </TenantTheme>
  );
}

/** Everything inside one school — gated on a real, tenant-matching session. */
function TenantRoutes() {
  const { slug = null } = useParams();
  const session = useSession(slug);

  if (session.loading) return <FullPageSkeleton />;
  if (!session.profile) return <Navigate to="/signin" replace />;
  if (session.profile.role === "super_admin") return <Navigate to="/platform/tenants" replace />;
  if (!session.tenant || session.tenant.slug !== slug) return <Navigate to="/signin" replace />;

  return (
    <SessionCtx.Provider value={session}>
      <TenantTheme tenant={session.tenant}>
        <Routes>
          <Route path="admin" element={<AdminShell allow={["school_admin"]}><AdminDashboard /></AdminShell>} />
          <Route path="admin/people" element={<AdminShell allow={["school_admin"]}><People /></AdminShell>} />
          <Route path="admin/fees" element={<AdminShell allow={["school_admin"]}><Fees /></AdminShell>} />
          <Route path="admin/announcements" element={<AdminShell allow={["school_admin"]}><Announcements /></AdminShell>} />
          <Route path="admin/fleet" element={<AdminShell allow={["school_admin"]}><Fleet /></AdminShell>} />
          <Route path="admin/settings" element={<AdminShell allow={["school_admin"]}><TermSetup /></AdminShell>} />
          <Route path="admin/classes" element={<AdminShell allow={["school_admin"]}><AdminClasses /></AdminShell>} />
          <Route path="admin/courses" element={<AdminShell allow={["school_admin"]}><AdminCourses /></AdminShell>} />
          <Route path="admin/reports" element={<AdminShell allow={["school_admin"]}><AdminReports /></AdminShell>} />

          <Route path="teacher" element={<Navigate to="attendance" replace />} />
          <Route path="teacher/attendance" element={<TeacherShell allow={["teacher"]}><Attendance /></TeacherShell>} />
          <Route path="teacher/gradebook" element={<TeacherShell allow={["teacher"]}><GradebookRouter /></TeacherShell>} />
          <Route path="teacher/timetable" element={<TeacherShell allow={["teacher"]}><TeacherTimetable /></TeacherShell>} />
          <Route path="teacher/classes" element={<TeacherShell allow={["teacher"]}><TeacherClasses /></TeacherShell>} />
          <Route path="teacher/sections" element={<TeacherShell allow={["teacher"]}><TeacherMySections /></TeacherShell>} />
          <Route path="teacher/messages" element={<TeacherShell allow={["teacher"]}><TeacherMessages /></TeacherShell>} />

          <Route path="parent" element={<ParentShell><ParentHome /></ParentShell>} />
          <Route path="parent/fees" element={<ParentShell><ParentFees /></ParentShell>} />
          <Route path="parent/results" element={<ParentShell><ParentResults /></ParentShell>} />
          <Route path="parent/bus" element={<ParentShell><ParentBus /></ParentShell>} />
          <Route path="parent/inbox" element={<ParentShell><ParentInbox /></ParentShell>} />
          <Route path="parent/settings" element={<ParentShell><ParentSettings /></ParentShell>} />

          <Route path="student" element={<StudentShell><StudentToday /></StudentShell>} />
          <Route path="student/timetable" element={<StudentShell><StudentTimetable /></StudentShell>} />
          <Route path="student/work" element={<StudentShell><StudentWork /></StudentShell>} />
          <Route path="student/results" element={<StudentShell><StudentResults /></StudentShell>} />
          <Route path="student/fees" element={<StudentShell><StudentFees /></StudentShell>} />
          <Route path="student/notices" element={<StudentShell><StudentNotices /></StudentShell>} />

          {/* No ConsoleShell — a driver's screen is one full-screen start/end-trip page, not a console. */}
          <Route path="driver" element={<RoleGate allow={["driver"]}><DriverTrip /></RoleGate>} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </TenantTheme>
    </SessionCtx.Provider>
  );
}

/** A signed-in user who wanders into a shell that is not theirs goes home, not to a 404. */
function RoleGate({ allow, children }: { allow: Role[]; children: ReactNode }) {
  const session = useTenantSession();
  if (!allow.includes(session.profile.role)) {
    return <Navigate to={homeRouteFor(session.profile.role, session.tenant.slug, session.tenant.institution_type)} replace />;
  }
  return <>{children}</>;
}

const AdminShell = ({ allow, children }: { allow: Role[]; children: ReactNode }) => {
  const session = useTenantSession();
  return (
    <RoleGate allow={allow}>
      <ConsoleShell role="school_admin" user={{ name: session.profile.full_name, roleLabel: session.profile.staff_title ?? "Principal" }}>
        {children}
      </ConsoleShell>
    </RoleGate>
  );
};

const TeacherShell = ({ allow, children }: { allow: Role[]; children: ReactNode }) => {
  const session = useTenantSession();
  return (
    <RoleGate allow={allow}>
      <ConsoleShell role="teacher" user={{ name: session.profile.full_name, roleLabel: session.profile.staff_title ?? roleLabel(session.tenant, "teacher") }}>
        {children}
      </ConsoleShell>
    </RoleGate>
  );
};

/** One "Gradebook" nav entry, two different screens underneath — K-12's letter-grade/class-mean model vs higher-ed's credit/GPA one (FIG-330). */
function GradebookRouter() {
  const { tenant } = useTenantSession();
  return tenant.institution_type === "higher_ed" ? <GpaGradebook /> : <Gradebook />;
}

const ParentShell = ({ children }: { children: ReactNode }) => {
  const session = useTenantSession();
  return (
    <RoleGate allow={["parent"]}>
      <ParentDataProvider>
        <ConsoleShell role="parent" user={{ name: session.profile.full_name, roleLabel: roleLabel(session.tenant, "parent") }}>
          {children}
        </ConsoleShell>
      </ParentDataProvider>
    </RoleGate>
  );
};

const StudentShell = ({ children }: { children: ReactNode }) => {
  const session = useTenantSession();
  return (
    <RoleGate allow={["student"]}>
      <StudentDataProvider>
        <ConsoleShell role="student" user={{ name: session.profile.full_name, roleLabel: roleLabel(session.tenant, "student") }}>
          {children}
        </ConsoleShell>
      </StudentDataProvider>
    </RoleGate>
  );
};

/** Shaped like the console it is standing in for, so the page does not jump once the session resolves. */
function FullPageSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <div className="flex w-[224px] shrink-0 flex-col gap-2 bg-[#17402A] p-4">
        <Skeleton className="mb-4 h-8 w-8 rounded-[10px] bg-white/10" />
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[38px] rounded-[9px] bg-white/10" />)}
      </div>
      <div className="min-w-0 flex-1 p-7">
        <Skeleton className="mb-2 h-3 w-32" />
        <Skeleton className="mb-6 h-6 w-72" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-page p-6 text-center">
      <div>
        <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-sunken text-lg text-ink-muted">◷</div>
        <h1 className="text-[17px] font-semibold">That page is not here</h1>
        <p className="mx-auto mt-1.5 max-w-[380px] text-[13px] leading-relaxed text-ink-muted">
          Check the school's address in the URL. If you followed a link from an email, it may have expired.
        </p>
        <a href="/signin" className="mt-4 inline-block text-[13px] font-semibold">Back to sign in</a>
      </div>
    </div>
  );
}
