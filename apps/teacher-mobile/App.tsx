import { useEffect, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { supabase } from "@figbloom/shared";
import "./src/lib/client";
import { FingerprintLock } from "./src/components/FingerprintLock";
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
 */
function AppContent() {
  const { t, accentInk } = useTheme();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<TeacherSession | null>(null);
  // Login ID while the school-issued password still has to be replaced; null once it has.
  const [choosePassword, setChoosePassword] = useState<{ loginId: string | null } | null>(null);
  // Choosing a password fires USER_UPDATED, whose reload can read the profile
  // before must_change_password is cleared — don't let that bring the prompt back.
  const passwordChosen = useRef(false);

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) { passwordChosen.current = false; if (alive) { setSession(null); setLoading(false); } return; }

      const { data: profile } = await supabase()
        .from("profiles").select("role, tenant_id, full_name, login_id, must_change_password").eq("id", user.id).maybeSingle();
      if (!profile || profile.role !== "teacher" || !profile.tenant_id) {
        if (alive) { setSession(null); setLoading(false); }
        return;
      }

      let accent = "#7A1F2B";
      let country = "KE";
      const { data: tenant } = await supabase()
        .from("tenants").select("accent, country").eq("id", profile.tenant_id).maybeSingle();
      if (tenant?.accent) accent = tenant.accent;
      if (tenant?.country) country = tenant.country;

      const next: TeacherSession = { profileId: user.id, tenantId: profile.tenant_id, fullName: profile.full_name, accent, country };
      const mustChoose = profile.must_change_password && !passwordChosen.current;
      if (alive) { setSession(next); setChoosePassword(mustChoose ? { loginId: profile.login_id } : null); setLoading(false); }
    }

    load().catch(() => { if (alive) { setSession(null); setLoading(false); } });
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
