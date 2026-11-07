import { useEffect, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { fetchMyAdminAreas, isNoSignalError, openSession, phoneConsolesFor, sessionSchoolSuspended, supabase, type AdminArea } from "@figbloom/shared";
import "./src/lib/client";
import { AdminNavigation } from "./src/adminNavigation";
import { FingerprintLock } from "./src/components/FingerprintLock";
import { NoConnection, SavedCopyNotice } from "./src/components/OfflineNotice";
import { ConsoleSwitchProvider, type Console } from "./src/lib/consoleSwitch";
import { readSavedSession, saveSession, type AppSession } from "./src/lib/savedSession";
import { signOutOfThisPhone } from "./src/lib/signOut";
import { storedUserId } from "./src/lib/storedLogin";
import type { StaffSession } from "./src/lib/staffSession";
import { ParentDataProvider } from "./src/data";
import { Navigation } from "./src/navigation";
import { registerPushToken } from "./src/pushNotifications";
import { ChoosePassword } from "./src/screens/ChoosePassword";
import { stopLocationTracking } from "./src/screens/driver/locationTask";
import { SignIn } from "./src/screens/SignIn";
import { StudentDataProvider } from "./src/studentData";
import { TeacherNavigation } from "./src/teacherNavigation";
import { accentFor } from "./src/theme";
import { ThemeProvider, useTheme } from "./src/ui/ThemeContext";

/** Everyone this phone can open for: what it saved last time, or a person whose screens are live data. */
type Session = AppSession | StaffSession;
const isStaff = (session: Session): session is StaffSession =>
  session.role === "teacher" || session.role === "school_admin" || session.role === "staff";

/** What only a fresh read of the profile knows: whether the school-issued password still has to be replaced. */
type FreshExtra = { fullName: string; loginId: string | null; mustChoose: boolean };

/**
 * Role and school come from the signed-in profile, not a baked-in constant —
 * mobile has no path to read a tenant slug from, so it is resolved here once
 * at sign-in (and again on every auth state change) and handed down.
 *
 * One app for every role this phone serves: a parent, a learner, a driver, a teacher, a school admin or another
 * member of staff gets their own screens from the role on the profile. A teacher who holds admin areas has the
 * school's admin screens too (a switch in More), and the admin screens always ask for the fingerprint.
 *
 * "Cannot reach the server" is not "signed out" (FIG-1487): with no signal the app opens from the identity the
 * phone saved last time (parent and learner, whose figures are cached too), or on a "No connection" page (a driver
 * or staff, whose screens are all live data).
 * Only an answer from the server, or no login stored on the phone, shows the sign-in screen.
 */
function AppContent() {
  const { t, accentInk } = useTheme();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  // "saved": opened from what the phone saved. "none": signed in, but nothing to show without the server.
  const [connection, setConnection] = useState<"ok" | "saved" | "none">("ok");
  const [retrying, setRetrying] = useState(false);
  const retry = useRef<() => void>(() => {});
  /** What is on screen right now, for a load that runs later than the render that started it. */
  const shown = useRef<Session | null>(null);
  // Set while the school-issued password still has to be replaced; null once it has.
  const [choosePassword, setChoosePassword] = useState<{ fullName: string; loginId: string | null } | null>(null);
  // Choosing a password fires USER_UPDATED, whose reload can read the profile
  // before must_change_password is cleared — don't let that bring the prompt back.
  const passwordChosen = useRef(false);
  // An open session found its school suspended (shared suspended.ts): readProfile only notes it, since
  // signing out can stop to ask about unsent data, which must not run out openSession's wait; the
  // signed-out branch then signs this phone out and sign-in says why.
  const suspendedFound = useRef(false);
  const [suspendedNotice, setSuspendedNotice] = useState(false);
  // Signed in with an account this app has no screens for (an org admin, a platform admin, staff with no admin area or only the visitor log):
  // it is signed out the same way, and sign-in says why instead of just coming back.
  const unsupportedFound = useRef(false);
  const [unsupportedNotice, setUnsupportedNotice] = useState(false);
  // A teacher who holds admin areas has two consoles; which one is on screen. Everyone else has the one they were given.
  const [consoleOn, setConsoleOn] = useState<Console>("own");

  useEffect(() => {
    let alive = true;

    async function load() {
      const opened = await openSession<Session, FreshExtra>({
        whoIsSignedIn: async () => {
          const { data: { user }, error } = await supabase().auth.getUser();
          if (user) return { id: user.id };
          return isNoSignalError(error) ? "no-signal" : "signed-out";
        },
        storedUserId,
        readProfile: async (userId) => {
          const { data: profile, error } = await supabase()
            .from("profiles").select("role, tenant_id, full_name, login_id, must_change_password, staff_title").eq("id", userId).maybeSingle();
          if (error) return "no-signal";
          const isStaffRole = !!profile && (profile.role === "teacher" || profile.role === "school_admin" || profile.role === "staff");
          const isSupportedRole = profile && (isStaffRole || profile.role === "parent" || profile.role === "student" || profile.role === "driver");
          if (!isSupportedRole || ((profile.role === "driver" || isStaffRole) && !profile.tenant_id)) {
            // Org admins and platform roles have no home here — the web console is theirs.
            // A driver or member of staff with no tenant is a data problem (each belongs to exactly one school),
            // not a session this app can serve.
            if (profile) unsupportedFound.current = true;
            return "unsupported";
          }

          let accent = "#7A1F2B";
          let country = "KE";
          let tenant: { accent: string | null; country: string | null; name: string | null; slug: string | null } | null = null;
          if (profile.tenant_id) {
            ({ data: tenant } = await supabase()
              .from("tenants").select("accent, country, name, slug").eq("id", profile.tenant_id).maybeSingle());
            if (tenant?.accent) accent = tenant.accent;
            if (tenant?.country) country = tenant.country;
          }
          // The school row can't be read: if that is because the school was just suspended (my_tenant()
          // hides it until the Auth ban ends the session), this phone is signed out and sign-in says so.
          if (await sessionSchoolSuspended(profile, !!tenant)) {
            suspendedFound.current = true;
            return "unsupported";
          }

          let fresh: Session;
          if (isStaffRole) {
            // Which admin screens a teacher or other staff member holds. A failed lookup leaves a teacher with their
            // own console only, never more; other staff have nothing else to open, so it is "cannot reach", not "no".
            let adminAreas: AdminArea[] = [];
            if (profile.role !== "school_admin") {
              try { adminAreas = await fetchMyAdminAreas(); } catch { if (profile.role === "staff") return "no-signal"; }
            }
            const consoles = phoneConsolesFor(profile.role, adminAreas);
            // Other staff with no admin area (or only the visitor log, which the phone has no screen for) have nothing
            // to open on the phone: the web console is theirs.
            if (!consoles.teacher && !consoles.admin) { unsupportedFound.current = true; return "unsupported"; }
            if (!tenant?.name || !tenant.slug) return "no-signal";
            fresh = {
              role: profile.role, accent, profileId: userId, tenantId: profile.tenant_id!, fullName: profile.full_name, country,
              adminAreas, school: { name: tenant.name, slug: tenant.slug }, title: profile.staff_title ?? null,
            };
          } else if (profile.role === "driver") {
            fresh = { role: "driver", accent, profileId: userId, tenantId: profile.tenant_id!, fullName: profile.full_name };
          } else {
            fresh = { role: profile.role, accent, profileId: userId, country, tenantId: profile.tenant_id! };
          }
          return { session: fresh, extra: { fullName: profile.full_name, loginId: profile.login_id, mustChoose: profile.must_change_password } };
        },
        readSaved: readSavedSession,
        // A driver's screen (assignment, trip, riders) and staff's (rosters, registers, marks, the school's records) are
        // all live data: with nothing to show offline they get the "No connection" page, so nothing is saved for them.
        save: async (userId, saved) => { if (saved.role === "parent" || saved.role === "student") await saveSession(userId, saved); },
      });
      if (!alive) return;

      if (opened.status === "signed-out") {
        passwordChosen.current = false;
        shown.current = null;
        setSession(null); setConnection("ok"); setChoosePassword(null); setConsoleOn("own");
        if (suspendedFound.current) {
          suspendedFound.current = false;
          setSuspendedNotice(true);
          void signOutOfThisPhone();
        } else if (unsupportedFound.current) {
          unsupportedFound.current = false;
          setUnsupportedNotice(true);
          void signOutOfThisPhone();
        }
      } else if (opened.status === "online") {
        setSuspendedNotice(false);
        setUnsupportedNotice(false);
        const mustChoose = opened.extra.mustChoose && !passwordChosen.current;
        shown.current = opened.session;
        setSession(opened.session); setConnection("ok");
        setChoosePassword(mustChoose ? { fullName: opened.extra.fullName, loginId: opened.extra.loginId } : null);
      } else if (opened.status === "saved-copy") {
        shown.current = opened.session;
        setSession(opened.session); setConnection("saved");
      } else if (!shown.current) {
        // Signed in, server out of reach, nothing saved. (If something is already on screen, leave it.)
        setConnection("none");
      }
      setLoading(false);
    }

    // Try again: back to the spinner for as long as the server takes to answer (or not).
    retry.current = () => {
      setRetrying(true);
      load().catch(() => {}).finally(() => { if (alive) setRetrying(false); });
    };
    load().catch(() => { if (alive) setLoading(false); });
    const { data: sub } = supabase().auth.onAuthStateChange(() => { load().catch(() => {}); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void registerPushToken();
  }, [session]);

  const a = accentFor(session?.accent ?? "#7A1F2B");
  const staff = session && isStaff(session) ? session : null;
  const consoles = staff ? phoneConsolesFor(staff.role, staff.adminAreas) : null;
  // A school admin or other staff member has only the admin console; a teacher who holds areas starts on their own.
  const onAdmin = !!consoles?.admin && (!consoles.teacher || consoleOn === "admin");
  const canSwitch = !!consoles?.teacher && !!consoles.admin;

  if (loading) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.appSurface.page }}>
          <ActivityIndicator size="large" color={accentInk(a.deep)} />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={a.deep} />
      {session ? (
        // The driver's GPS service has to be stopped before the lock screen can sign them out.
        <FingerprintLock
          key={session.profileId}
          profileId={session.profileId}
          accent={session.accent}
          beforeSignOut={session.role === "driver" ? stopLocationTracking : undefined}
          required={onAdmin}
          onLeave={onAdmin && canSwitch ? { label: "Back to teacher screens", run: () => setConsoleOn("own") } : undefined}
        >
          {connection === "saved" && <SavedCopyNotice onRetry={() => retry.current()} retrying={retrying} />}
          {choosePassword ? (
            <ChoosePassword
              profileId={session.profileId}
              fullName={choosePassword.fullName}
              loginId={choosePassword.loginId}
              onDone={() => { passwordChosen.current = true; setChoosePassword(null); }}
            />
          ) : session.role === "parent" ? (
            <ParentDataProvider profileId={session.profileId} accent={session.accent} country={session.country} tenantId={session.tenantId}>
              <Navigation role="parent" accent={session.accent} profileId={session.profileId} />
            </ParentDataProvider>
          ) : session.role === "student" ? (
            <StudentDataProvider profileId={session.profileId} accent={session.accent} country={session.country} tenantId={session.tenantId}>
              <Navigation role="student" accent={session.accent} profileId={session.profileId} />
            </StudentDataProvider>
          ) : staff ? (
            <ConsoleSwitchProvider value={{ current: onAdmin ? "admin" : "own", canSwitch, switchTo: setConsoleOn }}>
              {onAdmin ? <AdminNavigation session={staff} /> : <TeacherNavigation session={staff} />}
            </ConsoleSwitchProvider>
          ) : (
            <Navigation
              role="driver"
              accent={session.accent}
              profileId={session.profileId}
              driver={{ driverId: session.profileId, tenantId: session.tenantId, fullName: session.fullName }}
            />
          )}
        </FingerprintLock>
      ) : connection === "none" ? (
        <NoConnection onRetry={() => retry.current()} retrying={retrying} onSignOut={() => void signOutOfThisPhone()} />
      ) : <SignIn key={suspendedNotice ? "suspended" : unsupportedNotice ? "unsupported" : "sign-in"} suspendedAtStart={suspendedNotice} unsupportedAtStart={unsupportedNotice} />}
    </SafeAreaProvider>
  );
}

/** The theme is chosen once, here, so everything below it -- including the loading screen and sign-in -- is in the right scheme from the first frame. */
export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
