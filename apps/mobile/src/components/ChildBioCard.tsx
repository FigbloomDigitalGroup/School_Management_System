import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  BIO_FIELD_LABELS, bioChanges, bioFieldList, bioProblem, bioToInput, bioValueLabel, decideBioRequest, fetchLearnerBio,
  fetchPendingBioRequest, saveLearnerBio, splitBioChanges, type BioField, type BioRequest, type LearnerBioInput,
} from "@figbloom/shared";
import { s, t } from "../theme";
import { Skeleton } from "./Skeleton";
import { Button } from "../ui/Button";
import { Field as Input } from "../ui/Field";
import { Tap } from "../ui/Tap";

const READ_ORDER: BioField[] = ["full_name", "date_of_birth", "gender", "birth_cert_no", "upi_no", "nationality", "religion", "previous_school"];

/**
 * A child's bio data: the identity details the school registers them by,
 * and everyday details a family keeps up to date. A change to name, date of
 * birth, gender, birth certificate or UPI waits for the school office to
 * check it (it goes on report cards and exam registration); the rest saves
 * at once. The date of birth is typed as YYYY-MM-DD.
 */
export function ChildBioCard({ childId, childFirst, tint }: { childId: string; childFirst: string; tint: string }) {
  const [saved, setSaved] = useState<LearnerBioInput | null>(null);
  const [value, setValue] = useState<LearnerBioInput | null>(null);
  const [request, setRequest] = useState<BioRequest | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchLearnerBio(childId), fetchPendingBioRequest(childId)])
      .then(([bio, req]) => {
        if (!alive) return;
        // The form starts from what the parent asked for while it waits, so
        // saving something else doesn't look like it undid the request.
        const input = req ? { ...bioToInput(bio), ...req.changes } as LearnerBioInput : bioToInput(bio);
        setSaved(input);
        setValue(input);
        setRequest(req);
      })
      .catch((err: unknown) => { if (alive) setNote({ text: err instanceof Error ? err.message : "Could not load.", bad: true }); });
    return () => { alive = false; };
  }, [childId, reloadKey]);

  // A different child's card starts fresh.
  useEffect(() => { setSaved(null); setValue(null); setRequest(null); setEditing(false); setNote(null); }, [childId]);

  const changes = saved && value ? bioChanges(saved, value) : {};
  const { now, approval } = splitBioChanges(changes);
  const dirty = now.length + approval.length > 0;
  const pending = new Set<string>(request ? Object.keys(request.changes) : []);
  const set = (patch: Partial<LearnerBioInput>) => setValue((v) => (v ? { ...v, ...patch } : v));

  async function save() {
    if (!value || !dirty) return;
    const problem = bioProblem(value);
    if (problem) { setNote({ text: problem, bad: true }); return; }
    setSaving(true);
    setNote(null);
    try {
      const r = await saveLearnerBio(childId, changes);
      setNote({
        bad: false,
        text: r.pending.length === 0 ? "Details saved."
          : r.saved.length === 0 ? `Sent to the school office to approve: ${bioFieldList(r.pending)}.`
          : `Saved. ${bioFieldList(r.pending)} sent to the school office to approve.`,
      });
      setEditing(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNote({ text: err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", bad: true });
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    if (!request) return;
    try {
      await decideBioRequest(request.id, false);
      setNote({ text: "Request withdrawn.", bad: false });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNote({ text: err instanceof Error ? `Could not withdraw: ${err.message}` : "Could not withdraw.", bad: true });
    }
  }

  return (
    <View style={{ marginTop: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Text style={s.h2}>{childFirst}'s bio data</Text>
        {value && !editing && (
          <Tap accessibilityRole="button" onPress={() => { setEditing(true); setNote(null); }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Edit</Text>
          </Tap>
        )}
      </View>
      <View style={[s.card, { padding: 14, gap: 10 }]}>
        {!value ? (
          note ? <Text style={[s.small, { color: t.status.warnInk }]}>{note.text}</Text> : (
            <View style={{ gap: 8 }}><Skeleton width="60%" /><Skeleton width="40%" height={10} /></View>
          )
        ) : !editing ? (
          <>
            {READ_ORDER.map((f) => (
              <View key={f} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <Text style={s.faint}>{BIO_FIELD_LABELS[f]}</Text>
                <View style={{ flexShrink: 1, alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 13, color: value[f] ? t.appSurface.ink : t.appSurface.inkFaint, textAlign: "right" }}>{bioValueLabel(f, value[f])}</Text>
                  {pending.has(f) && <Text style={{ fontSize: 10.5, fontWeight: "700", color: "#8A5A0B" }}>Awaiting office</Text>}
                </View>
              </View>
            ))}
            {request && (
              <Tap accessibilityRole="button" onPress={() => void withdraw()} style={{ minHeight: 36, justifyContent: "center" }}>
                <Text style={{ fontSize: 12.5, color: t.appSurface.inkMuted, textDecorationLine: "underline" }}>Withdraw the change waiting for approval</Text>
              </Tap>
            )}
            {note && <Text style={[s.small, { color: note.bad ? t.status.warnInk : t.status.okInk }]}>{note.text}</Text>}
          </>
        ) : (
          <>
            <Text style={s.faint}>
              Changes to name, date of birth, gender, birth certificate or UPI number go to the school office to check first. The rest saves straight away.
            </Text>
            <Field label={BIO_FIELD_LABELS.full_name} value={value.full_name} onChange={(full_name) => set({ full_name: full_name ?? "" })} pending={pending.has("full_name")} />
            <Text style={label}>{BIO_FIELD_LABELS.gender}{pending.has("gender") ? "  · Awaiting office" : ""}</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {(["female", "male"] as const).map((g) => (
                <Tap
                  key={g}
                  accessibilityRole="button"
                  accessibilityState={{ selected: value.gender === g }}
                  onPress={() => set({ gender: value.gender === g ? null : g })}
                  style={{ borderRadius: 999, borderWidth: 1, borderColor: value.gender === g ? tint : t.appSurface.line, backgroundColor: value.gender === g ? tint : "transparent", paddingHorizontal: 14, paddingVertical: 6 }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: "600", color: value.gender === g ? "#fff" : t.appSurface.inkMuted }}>{g === "female" ? "Female" : "Male"}</Text>
                </Tap>
              ))}
            </View>
            <Field label={`${BIO_FIELD_LABELS.date_of_birth} (YYYY-MM-DD)`} value={value.date_of_birth} onChange={(date_of_birth) => set({ date_of_birth })} pending={pending.has("date_of_birth")} placeholder="2014-03-12" keyboard="numbers-and-punctuation" />
            <Field label={BIO_FIELD_LABELS.birth_cert_no} value={value.birth_cert_no} onChange={(birth_cert_no) => set({ birth_cert_no })} pending={pending.has("birth_cert_no")} mono />
            <Field label={BIO_FIELD_LABELS.upi_no} value={value.upi_no} onChange={(upi_no) => set({ upi_no })} pending={pending.has("upi_no")} placeholder="From NEMIS, if they have one" mono />
            <Field label={BIO_FIELD_LABELS.nationality} value={value.nationality} onChange={(nationality) => set({ nationality })} placeholder="e.g. Kenyan" />
            <Field label={BIO_FIELD_LABELS.religion} value={value.religion} onChange={(religion) => set({ religion })} />
            <Field label={BIO_FIELD_LABELS.previous_school} value={value.previous_school} onChange={(previous_school) => set({ previous_school })} />
            {note && <Text style={[s.small, { color: note.bad ? t.status.warnInk : t.status.okInk }]}>{note.text}</Text>}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
              <Button label={approval.length > 0 ? "Save and send for approval" : "Save"} tint={tint} loading={saving} disabled={!dirty} onPress={() => void save()} style={{ flex: 1 }} />
              <Button variant="secondary" label="Cancel" disabled={saving} onPress={() => { setValue(saved); setEditing(false); setNote(null); }} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const label = { fontSize: 12, fontWeight: "600" as const, color: t.appSurface.ink, marginBottom: 4 };

function Field({ label: text, value, onChange, pending, placeholder, keyboard, mono }: {
  label: string; value: string | null; onChange: (v: string | null) => void; pending?: boolean;
  placeholder?: string; keyboard?: "numbers-and-punctuation"; mono?: boolean;
}) {
  return (
    <Input
      label={`${text}${pending ? "  · Awaiting office" : ""}`}
      value={value ?? ""}
      onChangeText={(v) => onChange(v)}
      placeholder={placeholder}
      keyboardType={keyboard}
      autoCapitalize={mono ? "characters" : "sentences"}
    />
  );
}
