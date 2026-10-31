import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  BLOOD_GROUPS, COMMON_ALLERGIES, COMMON_CONDITIONS, fetchStudentHealth, healthFlags, healthToInput, normaliseList,
  saveStudentHealth, setLearnerHome, splitList, supabase, type StudentHealthInput,
} from "@figbloom/shared";
import { Skeleton } from "./Skeleton";
import { Button } from "../ui/Button";
import { Field as Input } from "../ui/Field";
import { Tap } from "../ui/Tap";
import { perScheme } from "../theme";
import { useTheme } from "../ui/ThemeContext";

/**
 * A child's health details and home address, which the parent can keep up to
 * date: teachers see allergies as a chip on the register, and the school
 * plans bus stops from the home. The map pin itself is set on the web (or by
 * the school); this keeps whatever pin there is.
 */
export function ChildHealthCard({ tenantId, childId, childFirst, tint }: { tenantId: string; childId: string; childFirst: string; tint: string }) {
  const { t, s, scheme, accentInk } = useTheme();
  const [value, setValue] = useState<StudentHealthInput | null>(null);
  const [home, setHome] = useState<{ address: string; landmark: string; lat: number | null; lng: number | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setValue(null);
    setHome(null);
    setEditing(false);
    void Promise.all([
      fetchStudentHealth(childId),
      supabase().from("students").select("home_address, home_landmark, home_lat, home_lng").eq("id", childId)
        .maybeSingle<{ home_address: string | null; home_landmark: string | null; home_lat: number | null; home_lng: number | null }>(),
    ]).then(([h, { data }]) => {
      if (!alive) return;
      setValue(healthToInput(h));
      setHome({ address: data?.home_address ?? "", landmark: data?.home_landmark ?? "", lat: data?.home_lat ?? null, lng: data?.home_lng ?? null });
    }).catch((err: unknown) => { if (alive) setNote(err instanceof Error ? err.message : "Could not load."); });
    return () => { alive = false; };
  }, [childId]);

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

  const flags = value ? healthFlags(value) : null;
  const set = (patch: Partial<StudentHealthInput>) => setValue((v) => (v ? { ...v, ...patch } : v));

  return (
    <View style={{ marginTop: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Text style={s.h2}>{childFirst}'s health and home</Text>
        {value && !editing && (
          <Tap accessibilityRole="button" onPress={() => { setEditing(true); setNote(null); }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: accentInk(tint) }}>Edit</Text>
          </Tap>
        )}
      </View>
      <View style={[s.card, { padding: 14, gap: 10 }]}>
        {!value || !home ? (
          note ? <Text style={[s.small, { color: t.status.badText }]}>{note}</Text> : (
            <View style={{ gap: 8 }}><Skeleton width="60%" /><Skeleton width="40%" height={10} /></View>
          )
        ) : !editing ? (
          <>
            <Text style={s.small}>{flags ? flags.summary : "No allergies or conditions on file."}</Text>
            {value.blood_group && <Text style={s.faint}>Blood group {value.blood_group}</Text>}
            {value.emergency_name && <Text style={s.faint}>Emergency: {value.emergency_name}{value.emergency_phone ? `, ${value.emergency_phone}` : ""}</Text>}
            <Text style={s.faint}>Home: {[home.address, home.landmark].filter(Boolean).join(" · ") || "not set"}{home.lat == null ? "" : " (pinned)"}</Text>
            {note && <Text style={s.faint}>{note}</Text>}
          </>
        ) : (
          <>
            <Chips title="Allergies" items={value.allergies} suggestions={COMMON_ALLERGIES} onChange={(allergies) => set({ allergies })} danger />
            <Chips title="Medical conditions" items={value.medical_conditions} suggestions={COMMON_CONDITIONS} onChange={(medical_conditions) => set({ medical_conditions })} />
            <Field label="Medication" value={value.medications} onChange={(medications) => set({ medications })} />
            <Text style={LABEL[scheme]}>Blood group</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {BLOOD_GROUPS.map((g) => (
                <Pill key={g} text={g} on={value.blood_group === g} tint={tint} onPress={() => set({ blood_group: value.blood_group === g ? null : g })} />
              ))}
            </View>
            <Field label="Diet" value={value.dietary_needs} onChange={(dietary_needs) => set({ dietary_needs })} />
            <Field label="Support needs" value={value.special_needs} onChange={(special_needs) => set({ special_needs })} />
            <Field label="Emergency contact" value={value.emergency_name} onChange={(emergency_name) => set({ emergency_name })} />
            <Field label="Their phone" value={value.emergency_phone} onChange={(emergency_phone) => set({ emergency_phone })} keyboard="phone-pad" />
            <Field label="Home address" value={home.address} onChange={(address) => setHome({ ...home, address: address ?? "" })} />
            <Field label="Landmark" value={home.landmark} onChange={(landmark) => setHome({ ...home, landmark: landmark ?? "" })} />
            {note && <Text style={[s.small, { color: t.status.badText }]}>{note}</Text>}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
              <Button label="Save" tint={tint} loading={saving} onPress={() => void save()} style={{ flex: 1 }} />
              <Button variant="secondary" label="Cancel" disabled={saving} onPress={() => setEditing(false)} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const LABEL = perScheme((t) => ({ fontSize: 12, fontWeight: "600" as const, color: t.appSurface.ink, marginBottom: 4 }));

function Field({ label: text, value, onChange, keyboard }: { label: string; value: string | null; onChange: (v: string | null) => void; keyboard?: "phone-pad" }) {
  return <Input label={text} value={value ?? ""} onChangeText={(v) => onChange(v)} keyboardType={keyboard} />;
}

function Pill({ text, on, tint, onPress, danger }: { text: string; on: boolean; tint: string; onPress: () => void; danger?: boolean }) {
  const { t, accentInk } = useTheme();
  const bg = on ? (danger ? t.status.badBg : tint) : "transparent";
  const fg = on ? (danger ? t.status.badInk : "#fff") : t.appSurface.inkMuted;
  return (
    <Tap accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ borderRadius: 999, borderWidth: 1, borderColor: on ? (danger ? t.status.badLine : accentInk(tint)) : t.appSurface.line, backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: fg }}>{on ? `${text} ×` : `+ ${text}`}</Text>
    </Tap>
  );
}

function Chips({ title, items, suggestions, onChange, danger }: { title: string; items: string[]; suggestions: string[]; onChange: (v: string[]) => void; danger?: boolean }) {
  const { t, scheme } = useTheme();
  const [draft, setDraft] = useState("");
  const has = (v: string) => items.some((i) => i.toLowerCase() === v.toLowerCase());
  const add = () => { if (draft.trim()) { onChange(normaliseList([...items, ...splitList(draft)])); setDraft(""); } };
  return (
    <View>
      <Text style={LABEL[scheme]}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {items.map((it) => <Pill key={it} text={it} on tint={t.brand.forest} danger={danger} onPress={() => onChange(items.filter((x) => x !== it))} />)}
        {suggestions.filter((sg) => !has(sg)).slice(0, 8).map((sg) => <Pill key={sg} text={sg} on={false} tint={t.brand.forest} onPress={() => onChange([...items, sg])} />)}
      </View>
      <Input label="Add another" value={draft} onChangeText={setDraft} onSubmitEditing={add} onBlur={add} placeholder="Type another and press return" returnKeyType="done" />
    </View>
  );
}
