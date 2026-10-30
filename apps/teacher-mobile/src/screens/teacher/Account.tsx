import { useEffect, useState } from "react";
import { ActivityIndicator, Image, ScrollView, Text, View } from "react-native";
import { launchImageLibrary } from "react-native-image-picker";
import { fetchMyProfile, supabase, updateMyAvatarUrl, updateMyProfile, type MyProfile } from "@figbloom/shared";
import { accentFor, HIT } from "../../theme";
import { uploadAvatar } from "../../lib/uploads";
import { FingerprintSetting } from "../../components/FingerprintSetting";
import { PrivacyLinks } from "../../components/PrivacyLinks";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import type { TeacherSession } from "../../navigation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Tap } from "../../ui/Tap";
import { AppearanceSetting } from "../../ui/AppearanceSetting";
import { useTheme } from "../../ui/ThemeContext";

/** Shown under the name field (not as a stray line at the bottom) when it is left empty. */
const NAME_REQUIRED = "A name is required.";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Editable name/phone/photo — same fields as web's MyAccountFields, same
 *  RLS (profile_update_self). login_id/email stay read-only. */
export function TeacherAccount({ session }: { session: TeacherSession }) {
  const { t, s, accentInk } = useTheme();
  const a = accentFor(session.accent);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** Until the profile lands the fields would read as blank (and anything typed would be overwritten). */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMyProfile(session.profileId).then((p) => {
      if (!alive) return;
      setProfile(p);
      setFullName(p.full_name);
      setPhone(p.phone ?? "");
    }).catch(() => {}).finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [session.profileId]);

  async function save() {
    if (!fullName.trim()) { setStatus(NAME_REQUIRED); return; }
    setSaving(true);
    setStatus(null);
    try {
      await updateMyProfile(session.profileId, { full_name: fullName.trim(), phone: phone.trim() || null });
      setDirty(false);
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function changePhoto() {
    const result = await launchImageLibrary({ mediaType: "photo", quality: 0.8 });
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    setUploading(true);
    setStatus(null);
    try {
      const url = await uploadAvatar(session.tenantId, session.profileId, asset.uri, asset.type);
      await updateMyAvatarUrl(session.profileId, url);
      setProfile((p) => (p ? { ...p, avatar_url: url } : p));
      setStatus("Photo updated.");
    } catch (err) {
      setStatus(err instanceof Error ? `Could not upload: ${err.message}` : "Could not upload.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Account" sub={session.fullName} color={a.deep} back />

      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { gap: 12 }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={{ width: 56, height: 56, borderRadius: 28 }} />
            ) : (
              <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: a.hex }}>
                <Text style={{ fontSize: 20, fontWeight: "700", color: "#fff" }}>{initialsOf(fullName || session.fullName)}</Text>
              </View>
            )}
            <Tap
              accessibilityRole="button"
              disabled={uploading}
              onPress={() => void changePhoto()}
              style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 14, justifyContent: "center" }}
            >
              {uploading ? <ActivityIndicator color={accentInk(a.deep)} /> : <Text style={{ fontSize: 13, fontWeight: "600", color: accentInk(a.deep) }}>Change photo</Text>}
            </Tap>
          </View>

          {loaded ? (
            <>
              <Field
                label="Full name"
                value={fullName}
                onChangeText={(v) => { setFullName(v); setDirty(true); setStatus(null); }}
                autoComplete="name"
                error={status === NAME_REQUIRED ? status : undefined}
              />
              <Field
                label="Phone"
                value={phone}
                onChangeText={(v) => { setPhone(v); setDirty(true); }}
                placeholder="e.g. 0712 345 678"
                keyboardType="phone-pad"
                autoComplete="tel"
              />
            </>
          ) : (
            <>
              <View><Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Full name</Text><Skeleton height={48} radius={12} /></View>
              <View><Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }]}>Phone</Text><Skeleton height={48} radius={12} /></View>
            </>
          )}

          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={s.faint}>Login:</Text>
            {loaded ? (
              <Text style={[s.faint, { fontFamily: "monospace" }]}>{profile?.login_id ?? profile?.email ?? "—"}</Text>
            ) : <Skeleton width={120} height={10} />}
          </View>

          <Button label="Save changes" loading={saving} disabled={!dirty} onPress={() => void save()} />
          {!!status && status !== NAME_REQUIRED && <Text accessibilityLiveRegion="polite" style={s.small}>{status}</Text>}
        </View>

        <AppearanceSetting tint={a.deep} />
        <FingerprintSetting tint={a.deep} />

        <PrivacyLinks tint={a.deep} />

        <Button variant="secondary" label="Sign out" onPress={() => void supabase().auth.signOut()} style={{ marginTop: 16 }} />
      </ScrollView>
    </View>
  );
}
