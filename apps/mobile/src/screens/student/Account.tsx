import { useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { supabase } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";
import { Skeleton } from "../../components/Skeleton";

interface Profile {
  fullName: string;
  tenantName: string | null;
}

/** A student's only way to sign out — mirrors the parent app's Account tab. */
export function StudentAccount() {
  const { data, accent } = useStudentData();
  const a = accentFor(accent);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  /** Without this a failed fetch leaves the skeleton pulsing forever. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user }, error: authErr } = await supabase().auth.getUser();
      if (authErr) throw new Error(authErr.message);
      if (!user) throw new Error("You are not signed in.");
      if (!alive) return;
      const { data: p, error: pErr } = await supabase()
        .from("profiles").select("full_name, tenant_id").eq("id", user.id).maybeSingle();
      if (pErr) throw new Error(pErr.message);
      if (!p) throw new Error("No profile found for this account.");
      if (!alive) return;
      let tenantName: string | null = null;
      if (p.tenant_id) {
        const { data: tenant } = await supabase().from("tenants").select("name").eq("id", p.tenant_id).maybeSingle();
        tenantName = tenant?.name ?? null;
      }
      if (alive) setProfile({ fullName: p.full_name, tenantName });
    })().catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? `Could not load your details: ${err.message}` : "Could not load your details.");
    });
    return () => { alive = false; };
  }, []);

  async function signOut() {
    setSigningOut(true);
    try { await supabase().auth.signOut(); } finally { setSigningOut(false); }
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Account</Text>
        <Text style={s.headerSub}>{profile?.tenantName ? `Signed in as a student at ${profile.tenantName}` : "Your details"}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.card}>
          {profile ? <Text style={s.h2}>{profile.fullName}</Text>
            : error ? <Text style={[s.small, { color: "#B4472B" }]}>{error}</Text>
            : <Skeleton width="55%" height={15} style={{ marginVertical: 2 }} />}
          <Text style={[s.small, { marginTop: 4 }]}>{data.className}</Text>
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          disabled={signingOut}
          onPress={signOut}
          style={[s.primary, { backgroundColor: t.appSurface.card, borderWidth: 1, borderColor: t.appSurface.line, marginTop: 24, opacity: signingOut ? 0.6 : 1 }]}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: t.status.warnInk }}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
