import { useEffect, useState } from "react";
import { ScrollView, Switch, Text, TouchableOpacity, View } from "react-native";
import { formatPhone, supabase } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useChildren } from "../../data";

interface Profile {
  fullName: string;
  phone: string | null;
  tenantName: string | null;
}

const CHANNELS = [
  { label: "Fee reminders", note: "SMS and in the app", on: true },
  { label: "Absence on the day", note: "SMS at 09:00", on: true },
  { label: "Results published", note: "In the app only", on: true },
  { label: "General school notices", note: "In the app only", on: false },
];

/**
 * Account details plus "how we reach you". The channel toggles are visual
 * only — there is no notification-preferences table behind them yet, exactly
 * as in the web console's version of this screen.
 */
export function ParentAccount() {
  const { accent } = useChild();
  const kids = useChildren();
  const a = accentFor(accent);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user || !alive) return;
      const { data: p } = await supabase()
        .from("profiles").select("full_name, phone, tenant_id").eq("id", user.id).maybeSingle();
      if (!p || !alive) return;
      let tenantName: string | null = null;
      if (p.tenant_id) {
        const { data: tenant } = await supabase().from("tenants").select("name").eq("id", p.tenant_id).maybeSingle();
        tenantName = tenant?.name ?? null;
      }
      if (alive) setProfile({ fullName: p.full_name, phone: p.phone, tenantName });
    })();
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
        <Text style={s.headerSub}>{profile?.tenantName ? `Signed in as a parent at ${profile.tenantName}` : "Your details and preferences"}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.card}>
          <Text style={s.h2}>{profile?.fullName ?? "…"}</Text>
          <Text style={[s.mono, { color: t.appSurface.inkMuted, marginTop: 4 }]}>{formatPhone(profile?.phone ?? null)}</Text>
          <Text style={[s.small, { marginTop: 10 }]}>
            {kids.length} {kids.length === 1 ? "child" : "children"}
            {profile?.tenantName ? ` at ${profile.tenantName}` : ""}. To add or remove a child, the school office has
            to do it — that is deliberate.
          </Text>
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>How we reach you</Text>
        <View style={s.card}>
          {CHANNELS.map((c, i) => (
            <View
              key={c.label}
              style={{
                flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11,
                borderBottomWidth: i === CHANNELS.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13.5, fontWeight: "500" }}>{c.label}</Text>
                <Text style={s.faint}>{c.note}</Text>
              </View>
              <Switch value={c.on} trackColor={{ true: a.deep, false: "#DAD5D4" }} thumbColor="#fff" />
            </View>
          ))}
        </View>

        <Text style={[s.faint, { marginTop: 12, lineHeight: 18 }]}>
          Fee reminders and same-day absences always go by SMS as well, because they are the two things a parent
          cannot afford to miss.
        </Text>

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
