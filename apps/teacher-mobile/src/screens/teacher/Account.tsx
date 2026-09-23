import { useEffect, useState } from "react";
import { ActivityIndicator, Image, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { launchImageLibrary } from "react-native-image-picker";
import { fetchMyProfile, supabase, updateMyAvatarUrl, updateMyProfile, type MyProfile } from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { uploadAvatar } from "../../lib/uploads";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Editable name/phone/photo — same fields as web's MyAccountFields, same
 *  RLS (profile_update_self). login_id/email stay read-only. */
export function TeacherAccount({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyProfile(session.profileId).then((p) => {
      if (!alive) return;
      setProfile(p);
      setFullName(p.full_name);
      setPhone(p.phone ?? "");
    }).catch(() => {});
    return () => { alive = false; };
  }, [session.profileId]);

  async function save() {
    if (!fullName.trim()) { setStatus("A name is required."); return; }
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
            <TouchableOpacity
              accessibilityRole="button"
              disabled={uploading}
              onPress={() => void changePhoto()}
              style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 14, justifyContent: "center" }}
            >
              {uploading ? <ActivityIndicator color={a.deep} /> : <Text style={{ fontSize: 13, fontWeight: "600", color: a.deep }}>Change photo</Text>}
            </TouchableOpacity>
          </View>

          <View>
            <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Full name</Text>
            <TextInput
              value={fullName}
              onChangeText={(v) => { setFullName(v); setDirty(true); }}
              style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 }}
            />
          </View>

          <View>
            <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Phone</Text>
            <TextInput
              value={phone}
              onChangeText={(v) => { setPhone(v); setDirty(true); }}
              placeholder="e.g. 0712 345 678"
              keyboardType="phone-pad"
              style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 }}
            />
          </View>

          <View style={{ flexDirection: "row", gap: 6 }}>
            <Text style={s.faint}>Login:</Text>
            <Text style={[s.faint, { fontFamily: "monospace" }]}>{profile?.login_id ?? profile?.email ?? "—"}</Text>
          </View>

          <TouchableOpacity
            accessibilityRole="button"
            disabled={!dirty || saving}
            onPress={() => void save()}
            style={[s.primary, { ...HIT, backgroundColor: t.brand.orange, opacity: !dirty || saving ? 0.6 : 1 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Save changes</Text>}
          </TouchableOpacity>
          {!!status && <Text style={s.small}>{status}</Text>}
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void supabase().auth.signOut()}
          style={[s.primary, { ...HIT, marginTop: 16, backgroundColor: t.appSurface.lineSoft }]}
        >
          <Text style={[s.primaryLabel, { color: t.appSurface.ink }]}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
