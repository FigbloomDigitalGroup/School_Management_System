import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { fetchMyOrganizations, fetchParentUnreadCount, fetchTeacherUnreadNoticeCount, homeRouteFor, logOrganizationAccess, roleLabel, subscribeAnnouncements, supabase, type Role } from "@figbloom/shared";
import { TenantTheme } from "./components/TenantTheme";
import { ToastHost } from "./components/ui/Toast";
import { ConsoleShell } from "./components/ConsoleShell";
import { Skeleton } from "./components/ui/Skeleton";
import { useAsync } from "./lib/useAsync";
import { useSession } from "./lib/useSession";
import { SessionCtx, useTenantSession } from "./lib/sessionContext";
import { useOrgSession } from "./lib/useOrgSession";
import { OrgSessionCtx, useOrgSessionCtx } from "./lib/orgSessionContext";
import { ParentDataProvider } from "./lib/parentContext";
import { StudentDataProvider } from "./lib/studentContext";
import { TeacherNoticesProvider } from "./lib/teacherNoticesContext";

import { SignIn } from "./screens/SignIn";
import { OrgPicker } from "./screens/OrgPicker";
import { Signup } from "./screens/Signup";
import { ResetPassword } from "./screens/ResetPassword";
import { Tenants } from "./screens/platform/Tenants";
import { Organizations } from "./screens/platform/Organizations";
import { Curriculum } from "./screens/platform/Curriculum";
import { Audit, Health, Impersonation, Incidents, Invoices, Subscriptions, Usage } from "./screens/platform/pages";

import { OrgDashboard } from "./screens/org/OrgDashboard";
import { OrgSchools } from "./screens/org/OrgSchools";
import { OrgSchoolDetail } from "./screens/org/OrgSchoolDetail";
import { OrgAdmins } from "./screens/org/OrgAdmins";
import { OrgAudit } from "./screens/org/OrgAudit";

import { AdminDashboard } from "./screens/admin/Dashboard";
import { People } from "./screens/admin/People";
import { Fees } from "./screens/admin/Fees";
import { Announcements } from "./screens/admin/Announcements";
import { TermSetup } from "./screens/admin/TermSetup";
import { Fleet } from "./screens/admin/Fleet";
import { AdminClasses } from "./screens/admin/Classes";
import { AdminSubjects } from "./screens/admin/Subjects";
import { AdminCourses } from "./screens/admin/Courses";
import { AdminReports } from "./screens/admin/Reports";
import { AdminLeave } from "./screens/admin/Leave";
import { AdminAccount } from "./screens/admin/Account";

import { Attendance } from "./screens/teacher/Attendance";
import { K12Gradebook } from "./screens/teacher/K12Gradebook";
import { GpaGradebook } from "./screens/teacher/GpaGradebook";
import { TeacherTimetable } from "./screens/teacher/Timetable";
import { TeacherClasses } from "./screens/teacher/Classes";
import { TeacherMySections } from "./screens/teacher/MySections";
import { TeacherMessages } from "./screens/teacher/Messages";
import { TeacherNotices } from "./screens/teacher/Notices";
import { TeacherLeave } from "./screens/teacher/Leave";
import { TeacherAccount } from "./screens/teacher/Account";

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
        <Route path="/org-picker" element={<OrgPicker />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route path="/platform" element={<Navigate to="/platform/tenants" replace />} />
        <Route path="/platform/:page" element={<PlatformShell />} />

        <Route path="/s/:slug/*" element={<TenantRoutes />} />

        <Route path="/org/:orgSlug/*" element={<OrgRoutes />} />

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
  curriculum: <Curriculum />,
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
        user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: "Super admin" }}
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
          <Route path="admin/fleet" element={<AdminShell allow={["school_admin"]}><DeliveryModeGate><Fleet /></DeliveryModeGate></AdminShell>} />
          <Route path="admin/settings" element={<AdminShell allow={["school_admin"]}><TermSetup /></AdminShell>} />
          <Route path="admin/classes" element={<AdminShell allow={["school_admin"]}><AdminClasses /></AdminShell>} />
          <Route path="admin/subjects" element={<AdminShell allow={["school_admin"]}><AdminSubjects /></AdminShell>} />
          <Route path="admin/courses" element={<AdminShell allow={["school_admin"]}><AdminCourses /></AdminShell>} />
          <Route path="admin/reports" element={<AdminShell allow={["school_admin"]}><AdminReports /></AdminShell>} />
          <Route path="admin/leave" element={<AdminShell allow={["school_admin"]}><AdminLeave /></AdminShell>} />
          <Route path="admin/account" element={<AdminShell allow={["school_admin"]}><AdminAccount /></AdminShell>} />

          <Route path="teacher" element={<Navigate to="attendance" replace />} />
          <Route path="teacher/attendance" element={<TeacherShell allow={["teacher"]}><Attendance /></TeacherShell>} />
          <Route path="teacher/gradebook" element={<TeacherShell allow={["teacher"]}><GradebookRouter /></TeacherShell>} />
          <Route path="teacher/timetable" element={<TeacherShell allow={["teacher"]}><TeacherTimetable /></TeacherShell>} />
          <Route path="teacher/classes" element={<TeacherShell allow={["teacher"]}><TeacherClasses /></TeacherShell>} />
          <Route path="teacher/sections" element={<TeacherShell allow={["teacher"]}><TeacherMySections /></TeacherShell>} />
          <Route path="teacher/messages" element={<TeacherShell allow={["teacher"]}><TeacherMessages /></TeacherShell>} />
          <Route path="teacher/notices" element={<TeacherShell allow={["teacher"]}><TeacherNotices /></TeacherShell>} />
          <Route path="teacher/leave" element={<TeacherShell allow={["teacher"]}><TeacherLeave /></TeacherShell>} />
          <Route path="teacher/account" element={<TeacherShell allow={["teacher"]}><TeacherAccount /></TeacherShell>} />

          <Route path="parent" element={<ParentShell><ParentHome /></ParentShell>} />
          <Route path="parent/fees" element={<ParentShell><ParentFees /></ParentShell>} />
          <Route path="parent/results" element={<ParentShell><ParentResults /></ParentShell>} />
          <Route path="parent/bus" element={<ParentShell><DeliveryModeGate><ParentBus /></DeliveryModeGate></ParentShell>} />
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

/** Everything for one organization — gated on a real, org-matching session (org_admin only). */
function OrgRoutes() {
  const { orgSlug = null } = useParams();
  const session = useOrgSession(orgSlug);

  if (session.loading) return <FullPageSkeleton />;
  if (!session.profile) return <Navigate to="/signin" replace />;
  // Any other role wandering onto an /org/* URL: we don't know their real
  // tenant/slug from here (this route never resolved one), so send them
  // through sign-in to re-resolve their actual home rather than guessing.
  if (session.profile.role !== "org_admin") return <Navigate to="/signin" replace />;
  // organization_read_own RLS already denied the fetch if this profile doesn't
  // actually administer this org — a null result here means "not authorized",
  // not "not found", the same way TenantRoutes reads a null tenant.
  if (!session.organization || session.organization.slug !== orgSlug) return <Navigate to="/signin" replace />;
  // A self-registered org (FIG-371) sits here until a super_admin approves it
  // (FIG-375) — no dashboard/schools/audit/add-a-school until then, same as
  // tenant_write_org_admin's RLS already enforces server-side for the "add a
  // school" case (FIG-369); this is just the honest UI for that same gate.
  if (session.organization.status === "pending") return <PendingOrgHold name={session.organization.name} />;

  return (
    <OrgSessionCtx.Provider value={session}>
      <TenantTheme tenant={null}>
        <Routes>
          <Route path="dashboard" element={<OrgShell><OrgDashboard /></OrgShell>} />
          <Route path="schools" element={<OrgShell><OrgSchools /></OrgShell>} />
          <Route path="schools/:tenantId" element={<OrgShell><OrgSchoolDetail /></OrgShell>} />
          <Route path="admins" element={<OrgShell><OrgAdmins /></OrgShell>} />
          <Route path="audit" element={<OrgShell><OrgAudit /></OrgShell>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </TenantTheme>
    </OrgSessionCtx.Provider>
  );
}

const OrgShell = ({ children }: { children: ReactNode }) => {
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
};

/** A signed-in user who wanders into a shell that is not theirs goes home, not to a 404. */
function RoleGate({ allow, children }: { allow: Role[]; children: ReactNode }) {
  const session = useTenantSession();
  // An org_admin acting inside a member school (FIG-391/392) gets treated as
  // that school's own school_admin for gating purposes — their real
  // profile.role stays "org_admin" in the database always, this is purely a
  // route-gating concept. Without it, homeRouteFor(session.profile.role, ...)
  // would build /org/<TENANT-slug>/dashboard on any mismatch — wrong, since
  // a tenant's slug is never the same as its owning organization's slug.
  const effectiveRole: Role = session.actingForTenant ? "school_admin" : session.profile.role;
  if (!allow.includes(effectiveRole)) {
    return <Navigate to={homeRouteFor(effectiveRole, session.tenant.slug, session.tenant.institution_type)} replace />;
  }
  return <>{children}</>;
}

/** Fleet/Bus are meaningless for a fully-online tenant (FIG-358) — previously
 *  reachable by direct URL for any tenant regardless of institution_type,
 *  since only the nav item was ever hidden, never the route itself. */
function DeliveryModeGate({ children }: { children: ReactNode }) {
  const session = useTenantSession();
  if (session.tenant.delivery_mode === "online") {
    const effectiveRole: Role = session.actingForTenant ? "school_admin" : session.profile.role;
    return <Navigate to={homeRouteFor(effectiveRole, session.tenant.slug, session.tenant.institution_type)} replace />;
  }
  return <>{children}</>;
}

const AdminShell = ({ allow, children }: { allow: Role[]; children: ReactNode }) => {
  const session = useTenantSession();
  const nav = useNavigate();
  async function exitToOrganization() {
    const org = session.actingOrganization;
    if (org) await logOrganizationAccess(org.id, session.profile.id, "exited_school_console", session.tenant.id).catch(() => {});
    nav(org ? `/org/${org.slug}/schools/${session.tenant.id}` : "/signin");
  }
  return (
    <RoleGate allow={allow}>
      <ConsoleShell
        role="school_admin"
        user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.actingForTenant ? "Org admin (acting)" : session.profile.staff_title ?? "Principal" }}
        actingBanner={session.actingForTenant && session.actingOrganization ? {
          orgName: session.actingOrganization.name,
          schoolName: session.tenant.name,
          onExit: () => void exitToOrganization(),
        } : undefined}
      >
        {children}
      </ConsoleShell>
    </RoleGate>
  );
};

const NOTICE_POLL_MS = 20_000;

const TeacherShell = ({ allow, children }: { allow: Role[]; children: ReactNode }) => {
  const session = useTenantSession();
  // Polled rather than fetched once, so a reminder sent while this teacher is
  // already sitting on some other page still shows up on the badge without
  // them having to navigate away and back (or hit refresh) to notice it.
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchTeacherUnreadNoticeCount(session.profile.id)
        .then((n) => { if (alive) setUnread(n); })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, NOTICE_POLL_MS);
    const unsubscribe = subscribeAnnouncements(session.tenant.id, load);
    return () => { alive = false; window.clearInterval(id); unsubscribe(); };
  }, [session.profile.id, session.tenant.id]);

  return (
    <RoleGate allow={allow}>
      <TeacherNoticesProvider value={() => setUnread((n) => (n ? n - 1 : n))}>
        <ConsoleShell
          role="teacher"
          user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: session.profile.staff_title ?? roleLabel(session.tenant, "teacher") }}
          badges={unread ? { "teacher/notices": String(unread) } : {}}
        >
          {children}
        </ConsoleShell>
      </TeacherNoticesProvider>
    </RoleGate>
  );
};

/** One "Gradebook" nav entry, two different screens underneath — K-12's letter-grade/class-mean model vs higher-ed's credit/GPA one (FIG-330). */
function GradebookRouter() {
  const { tenant } = useTenantSession();
  return tenant.institution_type === "higher_ed" ? <GpaGradebook /> : <K12Gradebook />;
}

const ParentShell = ({ children }: { children: ReactNode }) => {
  const session = useTenantSession();
  // Polled the same way as the teacher's notice badge, for the same reason —
  // a message sent while a parent is already sitting on some other page
  // should still show up without them navigating away and back.
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchParentUnreadCount(session.profile.id)
        .then((n) => { if (alive) setUnread(n); })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, NOTICE_POLL_MS);
    const unsubscribe = subscribeAnnouncements(session.tenant.id, load);
    return () => { alive = false; window.clearInterval(id); unsubscribe(); };
  }, [session.profile.id, session.tenant.id]);

  return (
    <RoleGate allow={["parent"]}>
      <ParentDataProvider>
        <ConsoleShell
          role="parent"
          user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: roleLabel(session.tenant, "parent") }}
          badges={unread ? { "parent/inbox": String(unread) } : {}}
        >
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
        <ConsoleShell role="student" user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: roleLabel(session.tenant, "student") }}>
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

/** Where a self-registered org's own admin lands until a super_admin approves them. */
function PendingOrgHold({ name }: { name: string }) {
  const nav = useNavigate();
  async function signOut() {
    await supabase().auth.signOut();
    nav("/signin", { replace: true });
  }
  return (
    <div className="grid min-h-screen place-items-center bg-page p-6 text-center">
      <div className="max-w-[420px]">
        <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-xl bg-sunken text-lg text-ink-muted">◷</div>
        <h1 className="text-[17px] font-semibold">{name} is under review</h1>
        <p className="mx-auto mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          A member of our team reviews every new organization before it goes live, usually within a day. Sign in
          again once it's approved — there's nothing else to do here in the meantime.
        </p>
        <button type="button" onClick={() => void signOut()} className="mt-4 text-[13px] font-semibold text-forest hover:underline">
          Sign out
        </button>
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
