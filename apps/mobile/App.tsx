import { useEffect, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { isNoSignalError, openSession, supabase } from "@figbloom/shared";
import "./src/lib/client";
import { FingerprintLock } from "./src/components/FingerprintLock";
import { NoConnection, SavedCopyNotice } from "./src/components/OfflineNotice";
import { readSavedSession, saveSession, type AppSession as Session } from "./src/lib/savedSession";
import { signOutOfThisPhone } from "./src/lib/signOut";
import { storedUserId } from "./src/lib/storedLogin";
import { ParentDataProvider } from "./src/data";
import { Navigation } from "./src/navigation";
import { registerPushToken } from "./src/pushNotifications";
import { ChoosePassword } from "./src/screens/ChoosePassword";
import { stopLocationTracking } from "./src/screens/driver/locationTask";
import { SignIn } from "./src/screens/SignIn";
import { StudentDataProvider } from "./src/studentData";
import { accentFor } from "./src/theme";
import { ThemeProvider, useTheme } from "./src/ui/ThemeContext";

/** What only a fresh read of the profile knows: whether the school-issued password still has to be replaced. */
type FreshExtra = { fullName: string; loginId: string | null; mustChoose: boolean };

/**
 * Role and school come from the signed-in profile, not a baked-in constant —
 * mobile has no path to read a tenant slug from, so it is resolved here once
 * at sign-in (and again on every auth state change) and handed down.
 *
 * "Cannot reach the server" is not "signed out" (FIG-1487): with no signal the app opens from the identity the
 * phone saved last time (parent and learner, whose figures are cached too), or on a "No connection" page.
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
            .from("profiles").select("role, tenant_id, full_name, login_id, must_change_password").eq("id", userId).maybeSingle();
          if (error) return "no-signal";
          const isSupportedRole = profile && (profile.role === "parent" || profile.role === "student" || profile.role === "driver");
          if (!isSupportedRole || (profile.role === "driver" && !profile.tenant_id)) {
            // Staff and platform roles have no home here — the web console is theirs.
            // A driver with no tenant is a data problem, not a session this app can serve.
            return "unsupported";
          }

          let accent = "#7A1F2B";
          let country = "KE";
          if (profile.tenant_id) {
            const { data: tenant } = await supabase()
              .from("tenants").select("accent, country").eq("id", profile.tenant_id).maybeSingle();
            if (tenant?.accent) accent = tenant.accent;
            if (tenant?.country) country = tenant.country;
          }

          const fresh: Session = profile.role === "driver"
            ? { role: "driver", accent, profileId: userId, tenantId: profile.tenant_id!, fullName: profile.full_name }
            : { role: profile.role, accent, profileId: userId, country, tenantId: profile.tenant_id! };
          return { session: fresh, extra: { fullName: profile.full_name, loginId: profile.login_id, mustChoose: profile.must_change_password } };
        },
        readSaved: readSavedSession,
        // A driver's screen is all live data (assignment, trip, riders): with nothing to show offline it gets the
        // "No connection" page, so nothing is saved for a driver.
        save: async (userId, saved) => { if (saved.role !== "driver") await saveSession(userId, saved); },
      });
      if (!alive) return;

      if (opened.status === "signed-out") {
        passwordChosen.current = false;
        shown.current = null;
        setSession(null); setConnection("ok"); setChoosePassword(null);
      } else if (opened.status === "online") {
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
        <FingerprintLock key={session.profileId} profileId={session.profileId} accent={session.accent} beforeSignOut={session.role === "driver" ? stopLocationTracking : undefined}>
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
      ) : <SignIn />}
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
