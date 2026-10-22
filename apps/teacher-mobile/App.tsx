import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { supabase } from "@figbloom/shared";
import "./src/lib/client";
import { Navigation, type TeacherSession } from "./src/navigation";
import { SignIn } from "./src/screens/SignIn";
import { accentFor } from "./src/theme";

/**
 * Teacher-only app — no role branching like the parent/student/driver app
 * has, since this binary only ever serves one role. A teacher with no
 * tenant_id is a data problem (every teacher belongs to exactly one
 * school), not a session this app can serve.
 */
export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<TeacherSession | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) { if (alive) { setSession(null); setLoading(false); } return; }

      const { data: profile } = await supabase()
        .from("profiles").select("role, tenant_id, full_name").eq("id", user.id).maybeSingle();
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
      if (alive) { setSession(next); setLoading(false); }
    }

    load().catch(() => { if (alive) { setSession(null); setLoading(false); } });
    const { data: sub } = supabase().auth.onAuthStateChange(() => { load().catch(() => {}); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

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
      {session ? <Navigation session={session} /> : <SignIn />}
    </SafeAreaProvider>
  );
}
