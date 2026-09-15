import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { supabase } from "@figbloom/shared";
import "./src/lib/client";
import { ParentDataProvider } from "./src/data";
import { Navigation } from "./src/navigation";
import { registerPushToken } from "./src/pushNotifications";
import { SignIn } from "./src/screens/SignIn";
import { StudentDataProvider } from "./src/studentData";
import { accentFor } from "./src/theme";

type Session =
  | { role: "parent"; accent: string; profileId: string }
  | { role: "student"; accent: string; profileId: string }
  | { role: "driver"; accent: string; profileId: string; tenantId: string; fullName: string };

/**
 * Role and school come from the signed-in profile, not a baked-in constant —
 * mobile has no path to read a tenant slug from, so it is resolved here once
 * at sign-in (and again on every auth state change) and handed down.
 */
export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) { if (alive) { setSession(null); setLoading(false); } return; }

      const { data: profile } = await supabase()
        .from("profiles").select("role, tenant_id, full_name").eq("id", user.id).maybeSingle();
      const isSupportedRole = profile && (profile.role === "parent" || profile.role === "student" || profile.role === "driver");
      if (!isSupportedRole || (profile.role === "driver" && !profile.tenant_id)) {
        // Staff and platform roles have no home here — the web console is theirs.
        // A driver with no tenant is a data problem, not a session this app can serve.
        if (alive) { setSession(null); setLoading(false); }
        return;
      }

      let accent = "#7A1F2B";
      if (profile.tenant_id) {
        const { data: tenant } = await supabase()
          .from("tenants").select("accent").eq("id", profile.tenant_id).maybeSingle();
        if (tenant?.accent) accent = tenant.accent;
      }

      const session: Session = profile.role === "driver"
        ? { role: "driver", accent, profileId: user.id, tenantId: profile.tenant_id!, fullName: profile.full_name }
        : { role: profile.role, accent, profileId: user.id };
      if (alive) { setSession(session); setLoading(false); }
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
        session.role === "parent" ? (
          <ParentDataProvider profileId={session.profileId} accent={session.accent}>
            <Navigation role="parent" accent={session.accent} />
          </ParentDataProvider>
        ) : session.role === "student" ? (
          <StudentDataProvider profileId={session.profileId} accent={session.accent}>
            <Navigation role="student" accent={session.accent} />
          </StudentDataProvider>
        ) : (
          <Navigation
            role="driver"
            accent={session.accent}
            driver={{ driverId: session.profileId, tenantId: session.tenantId, fullName: session.fullName }}
          />
        )
      ) : <SignIn />}
    </SafeAreaProvider>
  );
}
