import { useEffect, useState } from "react";
import { Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  BLOOD_GROUPS, COMMON_ALLERGIES, COMMON_CONDITIONS, describeHealthConsent, fetchHealthConsent, fetchStudentHealth,
  HEALTH_CONSENT_NO_PRESSURE, HEALTH_CONSENT_PURPOSE, HEALTH_CONSENT_WITHDRAW_WARNING, healthFlags, healthToInput, normaliseList,
  saveStudentHealth, setHealthConsent, setLearnerHome, splitList, supabase, type HealthConsent, type StudentHealthInput,
} from "@figbloom/shared";
import { s, t } from "../theme";
import { Skeleton } from "./Skeleton";

/**
 * A child's health details and home address, which the parent can keep up to
 * date: teachers see allergies as a chip on the register, and the school
 * plans bus stops from the home. The map pin itself is set on the web (or by
 * the school); this keeps whatever pin there is. Health details need the
 * parent's consent first (healthConsent.ts): until they agree, only the
 * emergency contact and home can be edited.
 */
export function ChildHealthCard({ tenantId, childId, childFirst, tint }: { tenantId: string; childId: string; childFirst: string; tint: string }) {
  const [value, setValue] = useState<StudentHealthInput | null>(null);
  const [home, setHome] = useState<{ address: string; landmark: string; lat: number | null; lng: number | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [consent, setConsent] = useState<HealthConsent | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setValue(null);
    setHome(null);
    setEditing(false);
    void Promise.all([
      fetchStudentHealth(childId),
      fetchHealthConsent(childId),
      supabase().from("students").select("home_address, home_landmark, home_lat, home_lng").eq("id", childId)
        .maybeSingle<{ home_address: string | null; home_landmark: string | null; home_lat: number | null; home_lng: number | null }>(),
    ]).then(([h, c, { data }]) => {
      if (!alive) return;
      setValue(healthToInput(h));
      setConsent(c);
      setHome({ address: data?.home_address ?? "", landmark: data?.home_landmark ?? "", lat: data?.home_lat ?? null, lng: data?.home_lng ?? null });
    }).catch((err: unknown) => { if (alive) setNote(err instanceof Error ? err.message : "Could not load."); });
    return () => { alive = false; };
  }, [childId, reload]);

  async function save() {
    if (!value || !home) return;
    setSaving(true);
    setNote(null);
    try {
      const saved = await saveStudentHealth(tenantId, childId, value);
      await setLearnerHome(childId, { lat: home.lat, lng: home.lng, landmark: home.landmark.trim() || null, address: home.address.trim() });
      setValue(healthToInput(saved));
      setEditing(false);
      setNote("Saved.");
    } catch (err) {
      setNote(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function decide(give: boolean) {
    setSaving(true);
    setNote(null);
    try {
      await setHealthConsent(childId, give);
      setNote(give ? "Thank you. You can add health details now." : "Consent withdrawn. The health details were deleted.");
      setEditing(give);
      setReload((n) => n + 1);
    } catch (err) {
      setNote(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function confirmWithdraw() {
    Alert.alert("Withdraw consent?", HEALTH_CONSENT_WITHDRAW_WARNING,
      [{ text: "Cancel", style: "cancel" }, { text: "Withdraw", style: "destructive", onPress: () => void decide(false) }]);
  }

  const given = consent?.status === "given";
  const flags = value ? healthFlags(value) : null;
  const set = (patch: Partial<StudentHealthInput>) => setValue((v) => (v ? { ...v, ...patch } : v));

  return (
    <View style={{ marginTop: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Text style={s.h2}>{childFirst}'s health and home</Text>
        {value && !editing && (
          <TouchableOpacity accessibilityRole="button" onPress={() => { setEditing(true); setNote(null); }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={[s.card, { padding: 14, gap: 10 }]}>
        {!value || !home ? (
          note ? <Text style={[s.small, { color: "#B4472B" }]}>{note}</Text> : (
            <View style={{ gap: 8 }}><Skeleton width="60%" /><Skeleton width="40%" height={10} /></View>
          )
        ) : !editing ? (
          <>
            {consent && !given && (
              <View style={{ gap: 6, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: t.appSurface.line }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>
                  {consent.hasDetails
                    ? `The school has health details on file for ${childFirst}. Do you agree to the school keeping them?`
                    : `Would you like to share ${childFirst}'s health details with the school?`}
                </Text>
                <Text style={s.small}>{HEALTH_CONSENT_PURPOSE}</Text>
                <Text style={s.small}>{HEALTH_CONSENT_NO_PRESSURE}</Text>
                <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                  <TouchableOpacity accessibilityRole="button" disabled={saving} onPress={() => void decide(true)}
                    style={{ flex: 1, backgroundColor: tint, borderRadius: 12, paddingVertical: 11, alignItems: "center", opacity: saving ? 0.6 : 1 }}>
                    <Text style={{ color: "#fff", fontWeight: "600" }}>I agree</Text>
                  </TouchableOpacity>
                  {consent.hasDetails && (
                    <TouchableOpacity accessibilityRole="button" disabled={saving} onPress={() => void decide(false)}
                      style={{ flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: "center", borderWidth: 1, borderColor: t.appSurface.line }}>
                      <Text style={{ fontWeight: "600" }}>No, delete them</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
            <Text style={s.small}>{flags ? flags.summary : "No allergies or conditions on file."}</Text>
            {value.blood_group && <Text style={s.faint}>Blood group {value.blood_group}</Text>}
            {value.emergency_name && <Text style={s.faint}>Emergency: {value.emergency_name}{value.emergency_phone ? `, ${value.emergency_phone}` : ""}</Text>}
            <Text style={s.faint}>Home: {[home.address, home.landmark].filter(Boolean).join(" · ") || "not set"}{home.lat == null ? "" : " (pinned)"}</Text>
            {given && consent && (
              <Text style={s.faint}>
                Consent: {describeHealthConsent(consent)}.{" "}
                <Text accessibilityRole="button" onPress={saving ? undefined : confirmWithdraw} style={{ fontWeight: "600", textDecorationLine: "underline" }}>Withdraw</Text>
              </Text>
            )}
            {note && <Text style={s.faint}>{note}</Text>}
          </>
        ) : (
          <>
            {given && (
              <>
                <Chips title="Allergies" items={value.allergies} suggestions={COMMON_ALLERGIES} onChange={(allergies) => set({ allergies })} danger />
                <Chips title="Medical conditions" items={value.medical_conditions} suggestions={COMMON_CONDITIONS} onChange={(medical_conditions) => set({ medical_conditions })} />
                <Field label="Medication" value={value.medications} onChange={(medications) => set({ medications })} />
                <Text style={label}>Blood group</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {BLOOD_GROUPS.map((g) => (
                    <Pill key={g} text={g} on={value.blood_group === g} tint={tint} onPress={() => set({ blood_group: value.blood_group === g ? null : g })} />
                  ))}
                </View>
                <Field label="Diet" value={value.dietary_needs} onChange={(dietary_needs) => set({ dietary_needs })} />
                <Field label="Support needs" value={value.special_needs} onChange={(special_needs) => set({ special_needs })} />
              </>
            )}
            <Field label="Emergency contact" value={value.emergency_name} onChange={(emergency_name) => set({ emergency_name })} />
            <Field label="Their phone" value={value.emergency_phone} onChange={(emergency_phone) => set({ emergency_phone })} keyboard="phone-pad" />
            <Field label="Home address" value={home.address} onChange={(address) => setHome({ ...home, address: address ?? "" })} />
            <Field label="Landmark" value={home.landmark} onChange={(landmark) => setHome({ ...home, landmark: landmark ?? "" })} />
            {note && <Text style={[s.small, { color: "#B4472B" }]}>{note}</Text>}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
              <TouchableOpacity accessibilityRole="button" disabled={saving} onPress={() => void save()}
                style={{ flex: 1, backgroundColor: tint, borderRadius: 12, paddingVertical: 12, alignItems: "center", opacity: saving ? 0.6 : 1 }}>
                <Text style={{ color: "#fff", fontWeight: "600" }}>{saving ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={saving} onPress={() => setEditing(false)}
                style={{ paddingHorizontal: 16, borderRadius: 12, paddingVertical: 12, borderWidth: 1, borderColor: t.appSurface.line }}>
                <Text style={{ fontWeight: "600" }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const label = { fontSize: 12, fontWeight: "600" as const, color: t.appSurface.ink, marginBottom: 4 };
const input = { borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: t.appSurface.ink };

function Field({ label: text, value, onChange, keyboard }: { label: string; value: string | null; onChange: (v: string | null) => void; keyboard?: "phone-pad" }) {
  return (
    <View>
      <Text style={label}>{text}</Text>
      <TextInput value={value ?? ""} onChangeText={(v) => onChange(v)} keyboardType={keyboard} style={input} />
    </View>
  );
}

function Pill({ text, on, tint, onPress, danger }: { text: string; on: boolean; tint: string; onPress: () => void; danger?: boolean }) {
  const bg = on ? (danger ? "#FBE9E6" : tint) : "transparent";
  const fg = on ? (danger ? "#9B2C1C" : "#fff") : t.appSurface.inkMuted;
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ borderRadius: 999, borderWidth: 1, borderColor: on ? (danger ? "#F1C7BF" : tint) : t.appSurface.line, backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: fg }}>{on ? `${text} ×` : `+ ${text}`}</Text>
    </TouchableOpacity>
  );
}

function Chips({ title, items, suggestions, onChange, danger }: { title: string; items: string[]; suggestions: string[]; onChange: (v: string[]) => void; danger?: boolean }) {
  const [draft, setDraft] = useState("");
  const has = (v: string) => items.some((i) => i.toLowerCase() === v.toLowerCase());
  const add = () => { if (draft.trim()) { onChange(normaliseList([...items, ...splitList(draft)])); setDraft(""); } };
  return (
    <View>
      <Text style={label}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {items.map((it) => <Pill key={it} text={it} on tint="#17402A" danger={danger} onPress={() => onChange(items.filter((x) => x !== it))} />)}
        {suggestions.filter((sg) => !has(sg)).slice(0, 8).map((sg) => <Pill key={sg} text={sg} on={false} tint="#17402A" onPress={() => onChange([...items, sg])} />)}
      </View>
      <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={add} onBlur={add} placeholder="Type another and press return" returnKeyType="done" style={input} />
    </View>
  );
}
