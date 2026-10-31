import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Switch, Text, View } from "react-native";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fetchChildLogins,
  fetchMyNotificationPreferences,
  formatPhone,
  resetUserPassword,
  setMyNotificationPreference,
  supabase,
  type NotificationPreferences,
  type PasswordResetResult,
} from "@figbloom/shared";
import { accentFor } from "../../theme";
import { useChild, useChildren } from "../../data";
import { FingerprintSetting } from "../../components/FingerprintSetting";
import { PrivacyLinks } from "../../components/PrivacyLinks";
import { Skeleton } from "../../components/Skeleton";
import { Tap } from "../../ui/Tap";
import { AppearanceSetting } from "../../ui/AppearanceSetting";
import { useTheme } from "../../ui/ThemeContext";

interface Profile {
  id: string;
  fullName: string;
  phone: string | null;
  tenantName: string | null;
}

const CHANNELS: { key: keyof NotificationPreferences; label: string; note: string }[] = [
  { key: "feeReminders", label: "Fee reminders", note: "SMS and in the app" },
  { key: "absenceToday", label: "Absence on the day", note: "SMS at 09:00" },
  { key: "resultsPublished", label: "Results published", note: "In the app only" },
  { key: "generalNotices", label: "General school notices", note: "In the app only" },
];

/** Account details plus "how we reach you" (FIG-872) — the channel toggles persist to notification_preferences. */
export function ParentAccount() {
  const { t, s, accentInk } = useTheme();
  const { accent } = useChild();
  const kids = useChildren();
  const a = accentFor(accent);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  /** Without this a failed fetch leaves the skeleton pulsing forever. */
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [savingKey, setSavingKey] = useState<keyof NotificationPreferences | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user }, error: authErr } = await supabase().auth.getUser();
      if (authErr) throw new Error(authErr.message);
      if (!user) throw new Error("You are not signed in.");
      if (!alive) return;
      const [{ data: p, error: pErr }, loadedPrefs] = await Promise.all([
        supabase().from("profiles").select("full_name, phone, tenant_id").eq("id", user.id).maybeSingle(),
        fetchMyNotificationPreferences(user.id),
      ]);
      if (pErr) throw new Error(pErr.message);
      if (!p) throw new Error("No profile found for this account.");
      if (!alive) return;
      setPrefs(loadedPrefs);
      let tenantName: string | null = null;
      if (p.tenant_id) {
        const { data: tenant } = await supabase().from("tenants").select("name").eq("id", p.tenant_id).maybeSingle();
        tenantName = tenant?.name ?? null;
      }
      if (alive) setProfile({ id: user.id, fullName: p.full_name, phone: p.phone, tenantName });
    })().catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? `Could not load your details: ${err.message}` : "Could not load your details.");
    });
    return () => { alive = false; };
  }, []);

  async function toggleChannel(key: keyof NotificationPreferences, value: boolean) {
    if (!profile) return;
    const prev = prefs;
    setPrefs((p) => ({ ...p, [key]: value }));
    setSavingKey(key);
    try {
      await setMyNotificationPreference(profile.id, { [key]: value });
    } catch {
      setPrefs(prev); // couldn't save — put the switch back rather than show a preference that didn't take
    } finally {
      setSavingKey(null);
    }
  }

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
          {profile ? (
            <>
              <Text style={s.h2}>{profile.fullName}</Text>
              <Text style={[s.mono, { color: t.appSurface.inkMuted, marginTop: 4 }]}>{formatPhone(profile.phone)}</Text>
            </>
          ) : error ? (
            <Text style={[s.small, { color: t.status.badText }]}>{error}</Text>
          ) : (
            <View style={{ gap: 8, paddingVertical: 2 }}>
              <Skeleton width="55%" height={15} />
              <Skeleton width="40%" height={11} />
            </View>
          )}
          <Text style={[s.small, { marginTop: 10 }]}>
            {kids.length} {kids.length === 1 ? "child" : "children"}
            {profile?.tenantName ? ` at ${profile.tenantName}` : ""}. To add or remove a child, the school office has
            to do it — that is deliberate.
          </Text>
        </View>

        <ChildLogins kids={kids} schoolName={profile?.tenantName ?? null} tint={a.deep} />

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>How we reach you</Text>
        <View style={s.card}>
          {CHANNELS.map((c, i) => (
            <View
              key={c.key}
              style={{
                flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11,
                borderBottomWidth: i === CHANNELS.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "500" }}>{c.label}</Text>
                <Text style={s.faint}>{c.note}</Text>
              </View>
              <Switch
                value={prefs[c.key]}
                disabled={!profile || savingKey === c.key}
                onValueChange={(v) => void toggleChannel(c.key, v)}
                trackColor={{ true: accentInk(a.deep), false: t.appSurface.track }}
                thumbColor="#fff"
              />
            </View>
          ))}
        </View>

        <Text style={[s.faint, { marginTop: 12, lineHeight: 18 }]}>
          Fee reminders and same-day absences always go by SMS as well, because they are the two things a parent
          cannot afford to miss.
        </Text>

        <AppearanceSetting tint={a.deep} />
        <FingerprintSetting tint={a.deep} />

        <PrivacyLinks tint={a.deep} />

        <Tap
          accessibilityRole="button"
          disabled={signingOut}
          onPress={signOut}
          style={[s.primary, { backgroundColor: t.appSurface.card, borderWidth: 1, borderColor: t.appSurface.line, marginTop: 24, opacity: signingOut ? 0.6 : 1 }]}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: t.status.warnInk }}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Text>
        </Tap>
      </ScrollView>
    </View>
  );
}

/**
 * "Reset <child>'s app password" for each child with a login of their own:
 * learners sign in with a school ID and have no email for a reset link, so
 * a parent can set a new temporary password (reset-user-password allows a
 * guardian this for their own children only). Shown once; the child picks
 * their own at their next sign-in.
 */
function ChildLogins({ kids, schoolName, tint }: { kids: { id: string; name: string; first: string }[]; schoolName: string | null; tint: string }) {
  const { t, s, accentInk } = useTheme();
  const [logins, setLogins] = useState<Map<string, string>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, PasswordResetResult>>({});
  const [error, setError] = useState<string | null>(null);
  const ids = kids.map((k) => k.id).join(",");

  useEffect(() => {
    let alive = true;
    fetchChildLogins(ids ? ids.split(",") : [])
      .then((m) => { if (alive) setLogins(m); })
      .catch(() => { /* no section is better than a broken one: the school office can still reset */ });
    return () => { alive = false; };
  }, [ids]);

  const withLogin = kids.filter((k) => logins.has(k.id));
  if (withLogin.length === 0) return null;

  function confirmReset(kid: { id: string; first: string }) {
    Alert.alert(
      `Reset ${kid.first}'s password?`,
      "Their current password stops working straight away. You'll get a new temporary one to give them.",
      [{ text: "Cancel", style: "cancel" }, { text: "Reset", onPress: () => void reset(kid) }],
    );
  }

  async function reset(kid: { id: string; first: string }) {
    setBusyId(kid.id);
    setError(null);
    try {
      const r = await resetUserPassword(logins.get(kid.id)!);
      setResults((m) => ({ ...m, [kid.id]: r }));
    } catch (err) {
      setError(err instanceof Error ? `Could not reset ${kid.first}'s password: ${err.message}` : `Could not reset ${kid.first}'s password.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>{withLogin.length === 1 ? "Your child's app login" : "Your children's app logins"}</Text>
      <View style={s.card}>
        {withLogin.map((k, i) => {
          const r = results[k.id];
          return (
            <View key={k.id} style={{ paddingVertical: 11, borderBottomWidth: i === withLogin.length - 1 ? 0 : 1, borderBottomColor: t.appSurface.lineSoft }}>
              <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "500" }}>{k.name}</Text>
              {r ? (
                <View style={{ marginTop: 8 }}>
                  <Text style={s.faint}>
                    Give these to {k.first}{schoolName ? `: pick ${schoolName}, then the ID` : ""}. The password works once; they choose their own when they sign in.
                  </Text>
                  {r.login_id && <Text selectable style={[{ color: t.appSurface.ink }, s.mono, { marginTop: 6 }]}>ID  {r.login_id}</Text>}
                  <Text selectable style={[{ color: t.appSurface.ink }, s.mono, { marginTop: 2, fontWeight: "700" }]}>Password  {r.password}</Text>
                </View>
              ) : (
                <Tap accessibilityRole="button" disabled={busyId === k.id} onPress={() => confirmReset(k)} style={{ marginTop: 6, minHeight: 36, justifyContent: "center" }}>
                  {busyId === k.id
                    ? <ActivityIndicator color={accentInk(tint)} />
                    : <Text style={{ fontSize: 13, fontWeight: "600", color: accentInk(tint) }}>Reset {k.first}'s app password</Text>}
                </Tap>
              )}
            </View>
          );
        })}
        {!!error && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 6 }}>{error}</Text>}
      </View>
    </>
  );
}
