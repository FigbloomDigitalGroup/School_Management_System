import { useEffect, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { supabase } from "@figbloom/shared";
import "./src/lib/client";
import { FingerprintLock } from "./src/components/FingerprintLock";
import { ParentDataProvider } from "./src/data";
import { Navigation } from "./src/navigation";
import { registerPushToken } from "./src/pushNotifications";
import { ChoosePassword } from "./src/screens/ChoosePassword";
import { stopLocationTracking } from "./src/screens/driver/locationTask";
import { SignIn } from "./src/screens/SignIn";
import { StudentDataProvider } from "./src/studentData";
import { accentFor } from "./src/theme";

type Session =
  | { role: "parent"; accent: string; profileId: string; country: string; tenantId: string }
  | { role: "student"; accent: string; profileId: string; country: string; tenantId: string }
  | { role: "driver"; accent: string; profileId: string; tenantId: string; fullName: string };

/**
 * Role and school come from the signed-in profile, not a baked-in constant —
 * mobile has no path to read a tenant slug from, so it is resolved here once
 * at sign-in (and again on every auth state change) and handed down.
 */
export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  // Set while the school-issued password still has to be replaced; null once it has.
  const [choosePassword, setChoosePassword] = useState<{ fullName: string; loginId: string | null } | null>(null);
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
      const isSupportedRole = profile && (profile.role === "parent" || profile.role === "student" || profile.role === "driver");
      if (!isSupportedRole || (profile.role === "driver" && !profile.tenant_id)) {
        // Staff and platform roles have no home here — the web console is theirs.
        // A driver with no tenant is a data problem, not a session this app can serve.
        if (alive) { setSession(null); setLoading(false); }
        return;
      }

      let accent = "#7A1F2B";
      let country = "KE";
      if (profile.tenant_id) {
        const { data: tenant } = await supabase()
          .from("tenants").select("accent, country").eq("id", profile.tenant_id).maybeSingle();
        if (tenant?.accent) accent = tenant.accent;
        if (tenant?.country) country = tenant.country;
      }

      const session: Session = profile.role === "driver"
        ? { role: "driver", accent, profileId: user.id, tenantId: profile.tenant_id!, fullName: profile.full_name }
        : { role: profile.role, accent, profileId: user.id, country, tenantId: profile.tenant_id! };
      const mustChoose = profile.must_change_password && !passwordChosen.current;
      if (alive) { setSession(session); setChoosePassword(mustChoose ? { fullName: profile.full_name, loginId: profile.login_id } : null); setLoading(false); }
    }

    load().catch(() => { if (alive) { setSession(null); setLoading(false); } });
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
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" }}>
          <ActivityIndicator size="large" color={a.deep} />
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
      ) : <SignIn />}
    </SafeAreaProvider>
  );
}
