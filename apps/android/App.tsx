import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { supabase } from "@figbloom/shared";
import "./src/lib/client";
import { ParentDataProvider } from "./src/data";
import { Navigation } from "./src/navigation";
import { SignIn } from "./src/screens/SignIn";
import { accentFor } from "./src/theme";

type Session = { role: "parent" | "student"; accent: string; profileId: string };

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
        .from("profiles").select("role, tenant_id").eq("id", user.id).maybeSingle();
      if (!profile || (profile.role !== "parent" && profile.role !== "student")) {
        // Staff and platform roles have no home here — the web console is theirs.
        if (alive) { setSession(null); setLoading(false); }
        return;
      }

      let accent = "#7A1F2B";
      if (profile.tenant_id) {
        const { data: tenant } = await supabase()
          .from("tenants").select("accent").eq("id", profile.tenant_id).maybeSingle();
        if (tenant?.accent) accent = tenant.accent;
      }

      if (alive) { setSession({ role: profile.role, accent, profileId: user.id }); setLoading(false); }
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
      {session ? (
        session.role === "parent" ? (
          <ParentDataProvider profileId={session.profileId} accent={session.accent}>
            <Navigation role="parent" accent={session.accent} />
          </ParentDataProvider>
        ) : (
          <Navigation role="student" accent={session.accent} />
        )
      ) : <SignIn />}
    </SafeAreaProvider>
  );
}
