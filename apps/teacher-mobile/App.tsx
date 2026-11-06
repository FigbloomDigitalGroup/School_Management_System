import { useEffect, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { isNoSignalError, openSession, sessionSchoolSuspended, supabase } from "@figbloom/shared";
import "./src/lib/client";
import { FingerprintLock } from "./src/components/FingerprintLock";
import { NoConnection } from "./src/components/OfflineNotice";
import { signOutOfThisPhone } from "./src/lib/signOut";
import { storedUserId } from "./src/lib/storedLogin";
import { Navigation, type TeacherSession } from "./src/navigation";
import { registerPushToken } from "./src/pushNotifications";
import { ChoosePassword } from "./src/screens/ChoosePassword";
import { SignIn } from "./src/screens/SignIn";
import { accentFor } from "./src/theme";
import { ThemeProvider, useTheme } from "./src/ui/ThemeContext";

/**
 * Teacher-only app — no role branching like the parent/student/driver app
 * has, since this binary only ever serves one role. A teacher with no
 * tenant_id is a data problem (every teacher belongs to exactly one
 * school), not a session this app can serve.
 *
 * "Cannot reach the server" is not "signed out" (FIG-1487): with no signal a teacher who is signed in gets a
 * "No connection" page, not the sign-in screen. Only an answer from the server, or no login stored on the
 * phone, shows the sign-in screen.
 */
function AppContent() {
  const { t, accentInk } = useTheme();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<TeacherSession | null>(null);
  // "none": signed in, but the server cannot be reached.
  const [connection, setConnection] = useState<"ok" | "none">("ok");
  const [retrying, setRetrying] = useState(false);
  const retry = useRef<() => void>(() => {});
  /** What is on screen right now, for a load that runs later than the render that started it. */
  const shown = useRef<TeacherSession | null>(null);
  // Login ID while the school-issued password still has to be replaced; null once it has.
  const [choosePassword, setChoosePassword] = useState<{ loginId: string | null } | null>(null);
  // Choosing a password fires USER_UPDATED, whose reload can read the profile
  // before must_change_password is cleared — don't let that bring the prompt back.
  const passwordChosen = useRef(false);
  // An open session found its school suspended (shared suspended.ts): readProfile only notes it, since
  // signing out can stop to ask about unsent data, which must not run out openSession's wait; the
  // signed-out branch then signs this phone out and sign-in says why.
  const suspendedFound = useRef(false);
  const [suspendedNotice, setSuspendedNotice] = useState(false);

  useEffect(() => {
    let alive = true;

    async function load() {
      const opened = await openSession<TeacherSession, { loginId: string | null; mustChoose: boolean }>({
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
          if (!profile || profile.role !== "teacher" || !profile.tenant_id) return "unsupported";

          let accent = "#7A1F2B";
          let country = "KE";
          const { data: tenant } = await supabase()
            .from("tenants").select("accent, country").eq("id", profile.tenant_id).maybeSingle();
          if (tenant?.accent) accent = tenant.accent;
          if (tenant?.country) country = tenant.country;
          // The school row can't be read: if that is because the school was just suspended (my_tenant()
          // hides it until the Auth ban ends the session), this phone is signed out and sign-in says so.
          if (await sessionSchoolSuspended(profile, !!tenant)) {
            suspendedFound.current = true;
            return "unsupported";
          }

          const next: TeacherSession = { profileId: userId, tenantId: profile.tenant_id, fullName: profile.full_name, accent, country };
          return { session: next, extra: { loginId: profile.login_id, mustChoose: profile.must_change_password } };
        },
        // Every screen of this app is live data (rosters, registers, marks): nothing is saved to open with no signal.
        readSaved: async () => null,
        save: async () => {},
      });
      if (!alive) return;

      if (opened.status === "signed-out") {
        passwordChosen.current = false;
        shown.current = null;
        setSession(null); setConnection("ok"); setChoosePassword(null);
        if (suspendedFound.current) {
          suspendedFound.current = false;
          setSuspendedNotice(true);
          void signOutOfThisPhone();
        }
      } else if (opened.status === "online") {
        setSuspendedNotice(false);
        const mustChoose = opened.extra.mustChoose && !passwordChosen.current;
        shown.current = opened.session;
        setSession(opened.session); setConnection("ok");
        setChoosePassword(mustChoose ? { loginId: opened.extra.loginId } : null);
      } else if (!shown.current) {
        // Signed in, server out of reach. (If a screen is already showing, leave it.)
        setConnection("none");
      }
      setLoading(false);
    }

    // Try again: the button shows it is working for as long as the server takes to answer (or not).
    retry.current = () => {
      setRetrying(true);
      load().catch(() => {}).finally(() => { if (alive) setRetrying(false); });
    };
    load().catch(() => { if (alive) setLoading(false); });
    const { data: sub } = supabase().auth.onAuthStateChange(() => { load().catch(() => {}); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  // Pushes (a new chat, a visitor) reach this phone once it has told the server it exists.
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
        <FingerprintLock key={session.profileId} profileId={session.profileId} accent={session.accent}>
          {choosePassword ? (
            <ChoosePassword
              profileId={session.profileId}
              fullName={session.fullName}
              loginId={choosePassword.loginId}
              onDone={() => { passwordChosen.current = true; setChoosePassword(null); }}
            />
          ) : <Navigation session={session} />}
        </FingerprintLock>
      ) : connection === "none" ? (
        <NoConnection onRetry={() => retry.current()} retrying={retrying} onSignOut={() => void signOutOfThisPhone()} />
      ) : <SignIn key={suspendedNotice ? "suspended" : "sign-in"} suspendedAtStart={suspendedNotice} />}
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
