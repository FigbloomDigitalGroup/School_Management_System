import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  DOSE_STATUS_LABEL, fetchChildMedical, formatFileSize, localDay, markMedicalNoticesRead, REQUEST_STATUS_LABEL, removeUnsentPrescription,
  requestDraftProblem, requestMedication, uploadPrescriptionFile, uploadProblem, VISIT_OUTCOME_LABEL, withdrawMedicationRequest,
  type ChildMedical, type MedicationRequestDraft, type VisitOutcome,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useChildren, useTenantId } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { SubScreen } from "../../components/SubScreen";
import { notifyMedicalRead } from "../../lib/medicalUnread";
import { pickPhoto, readPhoto, type PickedPhoto } from "../../lib/pickPhoto";

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** "Tue 27 Oct, 14:05" (the time only, for today). */
function when(iso: string): string {
  const d = new Date(iso);
  if (localDay(d) === localDay(new Date())) return hm(iso);
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${hm(iso)}`;
}

const OUTCOME_TONE: Record<VisitOutcome, { bg: string; ink: string }> = {
  class: { bg: t.status.okBg, ink: t.status.okInk },
  rest: { bg: t.status.infoBg, ink: t.status.infoInk },
  home: { bg: t.status.warnBg, ink: t.status.warnInk },
  hospital: { bg: t.status.warnBg, ink: t.status.warnInk },
  admitted: { bg: t.status.warnBg, ink: t.status.warnInk },
};

/**
 * The selected child's sick bay visits (what the nurse saw and did, and where
 * they went), their medication with each dose, and what the school told you,
 * as on the web's Health page. Ask the nurse to give a prescribed medicine
 * here, with a photo of the prescription from the gallery if there is one
 * (a PDF is sent from the website). Opening the screen marks the child's
 * notices read.
 */
export function ParentHealth() {
  const { child, index, setIndex, accent } = useChild();
  const kids = useChildren();
  const tenantId = useTenantId();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const [data, setData] = useState<ChildMedical | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setAsking(false);
    fetchChildMedical(child.id)
      .then((d) => { if (alive) setData(d); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load the health records."); });
    return () => { alive = false; };
  }, [child.id, reloadKey]);

  const unread = data?.notices.filter((n) => !n.read_at).length ?? 0;
  useEffect(() => {
    if (!unread) return;
    markMedicalNoticesRead(child.id).then(notifyMedicalRead).catch(() => {});
  }, [child.id, unread]);

  function confirmWithdraw(id: string) {
    Alert.alert("Withdraw this request?", undefined, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Withdraw",
        onPress: () => {
          withdrawMedicationRequest(id)
            .then(() => { setNote("Request withdrawn."); setReloadKey((k) => k + 1); })
            .catch((err: unknown) => setNote(err instanceof Error ? err.message : "Could not withdraw it."));
        },
      },
    ]);
  }

  const today = localDay(new Date());

  return (
    <SubScreen
      tint={tint}
      title={`${child.first}'s health at school`}
      sub="Sick bay visits, the medicine the school gives, and what the nurse has told you."
      headerRight={<ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />}
    >
      {error ? (
        <Text style={[s.small, { color: t.status.warnInk }]}>Could not load the health records: {error}</Text>
      ) : !data ? (
        <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
      ) : (
        <View style={{ gap: 16 }}>
          {!!note && <Text style={[s.small, { color: t.status.okInk }]}>{note}</Text>}

          {asking ? (
            <RequestForm
              first={child.first}
              tint={tint}
              onCancel={() => setAsking(false)}
              onSend={async (draft, photo) => {
                let path: string | null = null;
                try {
                  path = photo ? await uploadPrescriptionFile(tenantId, child.id, await readPhoto(photo)) : null;
                  await requestMedication(tenantId, child.id, draft, path);
                } catch (err) {
                  // Nothing half-sent: a photo that went up without its request comes back out.
                  if (path) await removeUnsentPrescription(path);
                  throw err;
                }
                setAsking(false);
                setNote("Sent to the school nurse.");
                setReloadKey((k) => k + 1);
              }}
            />
          ) : (
            <TouchableOpacity accessibilityRole="button" onPress={() => { setNote(null); setAsking(true); }} style={[s.primary, { backgroundColor: tint }]}>
              <Text style={s.primaryLabel}>Ask the nurse to give a medicine</Text>
            </TouchableOpacity>
          )}

          {data.notices.length > 0 && (
            <Block title="From the sick bay">
              {data.notices.slice(0, 5).map((n, i) => (
                <Row key={n.id} first={i === 0}>
                  <View style={[s.row, { alignItems: "flex-start", justifyContent: "space-between", gap: 8 }]}>
                    <Text style={{ flex: 1, fontSize: 13.5, fontWeight: "600" }}>{n.title}</Text>
                    {!n.read_at && <Pill bg={t.status.infoBg} ink={t.status.infoInk} label="New" />}
                  </View>
                  <Text style={s.faint}>{when(n.created_at)}</Text>
                  <Text style={[s.small, { marginTop: 2 }]}>{n.body}</Text>
                </Row>
              ))}
            </Block>
          )}

          <Block title={`Sick bay visits · ${data.visits.length}`}>
            {data.visits.length === 0 ? (
              <Row first><Text style={s.small}>When {child.first} sees the school nurse, the visit shows here.</Text></Row>
            ) : data.visits.map((v, i) => {
              const tone = v.outcome ? OUTCOME_TONE[v.outcome] : { bg: t.status.infoBg, ink: t.status.infoInk };
              const details = [
                v.temperature_c != null ? `Temperature ${v.temperature_c}°C` : null, v.assessment, v.treatment && `Treatment: ${v.treatment}`,
                v.referred_to && `At: ${v.referred_to}`, v.follow_up && `Follow-up: ${v.follow_up}`,
              ].filter(Boolean).join(" · ");
              return (
                <Row key={v.id} first={i === 0}>
                  <View style={[s.row, { alignItems: "flex-start", justifyContent: "space-between", gap: 8 }]}>
                    <Text style={{ flex: 1, fontSize: 13.5, fontWeight: "600" }}>{v.complaint}</Text>
                    <Pill bg={tone.bg} ink={tone.ink} label={v.outcome ? VISIT_OUTCOME_LABEL[v.outcome] : "Being seen"} />
                  </View>
                  <Text style={s.faint}>{when(v.time_in)}</Text>
                  {!!details && <Text style={[s.small, { marginTop: 2 }]}>{details}</Text>}
                  {(v.visit_medications ?? []).length > 0 && (
                    <Text style={[s.small, { marginTop: 2, color: t.appSurface.ink }]}>
                      Medicine given: {v.visit_medications!.map((m) => `${m.drug} ${m.dose}`).join(", ")}
                    </Text>
                  )}
                </Row>
              );
            })}
          </Block>

          <Block title="Medication at school">
            {data.schedules.length === 0 ? (
              <Row first><Text style={s.small}>Medicine the school gives on a schedule, prescribed by a doctor or asked for by you, shows here with each dose.</Text></Row>
            ) : data.schedules.map((sc, i) => {
              const doses = data.doses.filter((d) => d.schedule_id === sc.id);
              const running = !sc.stopped_at && (!sc.ends_on || sc.ends_on >= today);
              return (
                <Row key={sc.id} first={i === 0}>
                  <View style={[s.row, { alignItems: "flex-start", justifyContent: "space-between", gap: 8 }]}>
                    <Text style={{ flex: 1, fontSize: 13.5, fontWeight: "600" }}>{sc.drug} {sc.dose}</Text>
                    <Pill bg={running ? t.status.okBg : t.status.mutedBg} ink={running ? t.status.okInk : t.status.mutedInk} label={running ? "Running" : "Finished"} />
                  </View>
                  <Text style={s.small}>at {sc.times.join(", ")}, {sc.starts_on} to {sc.ends_on ?? "until stopped"}</Text>
                  {doses.slice(0, 9).map((d) => (
                    <Text key={d.id} style={[s.faint, { marginTop: 2 }]}>
                      <Text style={s.mono}>{d.due_on} {d.due_time}</Text> · {DOSE_STATUS_LABEL[d.status]}{d.note ? ` (${d.note})` : ""}
                    </Text>
                  ))}
                </Row>
              );
            })}
          </Block>

          {data.requests.length > 0 && (
            <Block title="Your requests">
              {data.requests.map((r, i) => {
                const tone = r.status === "approved" ? { bg: t.status.okBg, ink: t.status.okInk } : r.status === "declined" ? { bg: t.status.warnBg, ink: t.status.warnInk } : { bg: t.status.mutedBg, ink: t.status.mutedInk };
                return (
                  <Row key={r.id} first={i === 0}>
                    <View style={[s.row, { alignItems: "flex-start", justifyContent: "space-between", gap: 8 }]}>
                      <Text style={{ flex: 1, fontSize: 13, color: t.appSurface.ink }}>{r.drug} {r.dose}, {r.times_per_day}× a day from {r.starts_on}</Text>
                      <Pill bg={tone.bg} ink={tone.ink} label={REQUEST_STATUS_LABEL[r.status]} />
                    </View>
                    {!!r.decision_note && <Text style={[s.small, { marginTop: 2 }]}>{r.decision_note}</Text>}
                    {r.status === "pending" && (
                      <TouchableOpacity accessibilityRole="button" onPress={() => confirmWithdraw(r.id)} style={{ minHeight: 40, justifyContent: "center", alignSelf: "flex-start" }}>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Withdraw</Text>
                      </TouchableOpacity>
                    )}
                  </Row>
                );
              })}
            </Block>
          )}
        </View>
      )}
    </SubScreen>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.eyebrow}>{title.toUpperCase()}</Text>
      <View style={[s.card, { padding: 0 }]}>{children}</View>
    </View>
  );
}

function Row({ first, children }: { first?: boolean; children: ReactNode }) {
  return <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: t.appSurface.lineSoft }}>{children}</View>;
}

function Pill({ bg, ink, label }: { bg: string; ink: string; label: string }) {
  return (
    <View style={[s.pill, { backgroundColor: bg, flexShrink: 1 }]}>
      <Text style={[s.pillLabel, { color: ink }]}>{label}</Text>
    </View>
  );
}

const labelStyle = { fontSize: 12, fontWeight: "600" as const, color: t.appSurface.ink, marginBottom: 4 };
const inputStyle = { borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: t.appSurface.ink, backgroundColor: "#fff" };

/** For medicine a doctor prescribed, or that the family wants the school to give: the nurse checks it and puts it on the round. Dates are typed as YYYY-MM-DD. */
function RequestForm({ first, tint, onCancel, onSend }: {
  first: string;
  tint: string;
  onCancel: () => void;
  onSend: (draft: MedicationRequestDraft, photo: PickedPhoto | null) => Promise<void>;
}) {
  const [drug, setDrug] = useState("");
  const [dose, setDose] = useState("");
  const [times, setTimes] = useState("3");
  const [prescriber, setPrescriber] = useState("");
  const [startsOn, setStartsOn] = useState(localDay(new Date()));
  const [endsOn, setEndsOn] = useState("");
  const [instructions, setInstructions] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const draft: MedicationRequestDraft = {
      drug, dose, times_per_day: Math.round(Number(times)), starts_on: startsOn.trim(), ends_on: endsOn.trim() || null, instructions, prescriber,
    };
    const p = requestDraftProblem(draft) ?? (photo ? uploadProblem(photo) : null);
    if (p) { setProblem(p); return; }
    setBusy(true);
    setProblem(null);
    try {
      await onSend(draft, photo);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not send the request.");
      setBusy(false);
    }
  }

  const field = (label: string, value: string, onChange: (v: string) => void, extra?: { placeholder?: string; keyboard?: "number-pad" | "numbers-and-punctuation"; max?: number }) => (
    <View>
      <Text style={labelStyle}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!busy}
        maxLength={extra?.max}
        keyboardType={extra?.keyboard}
        placeholder={extra?.placeholder}
        placeholderTextColor={t.appSurface.inkFaint}
        style={inputStyle}
      />
    </View>
  );

  return (
    <View style={[s.card, { gap: 10 }]}>
      <Text style={s.h2}>Ask the nurse to give {first} a medicine</Text>
      <Text style={s.small}>For medicine a doctor prescribed, or that you want the school to give. The nurse checks it and puts it on the medication round.</Text>
      {field("Medicine", drug, setDrug, { placeholder: "e.g. Amoxicillin", max: 120 })}
      {field("Dose", dose, setDose, { placeholder: "e.g. 250mg", max: 120 })}
      {field("Times a day", times, setTimes, { keyboard: "number-pad", max: 1 })}
      {field("Doctor or clinic (if prescribed)", prescriber, setPrescriber, { max: 120 })}
      {field("First day (YYYY-MM-DD)", startsOn, setStartsOn, { keyboard: "numbers-and-punctuation", max: 10 })}
      {field("Last day (YYYY-MM-DD, optional)", endsOn, setEndsOn, { keyboard: "numbers-and-punctuation", max: 10 })}
      {field("Instructions", instructions, setInstructions, { placeholder: "e.g. After meals, finish the course", max: 1000 })}
      {photo ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={[s.small, { flex: 1, color: t.appSurface.ink }]}>📎 {photo.name}{photo.sizeBytes ? ` · ${formatFileSize(photo.sizeBytes)}` : ""}</Text>
          <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => setPhoto(null)} style={{ minHeight: 40, justifyContent: "center" }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: t.status.warnInk }}>Remove</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            setProblem(null);
            pickPhoto().then((picked) => { if (picked) setPhoto(picked); }).catch((err: unknown) => setProblem(err instanceof Error ? err.message : "Could not open your photos."));
          }}
          style={{ minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>Add a photo of the prescription (optional)</Text>
        </TouchableOpacity>
      )}
      {!!problem && <Text style={{ fontSize: 12.5, color: t.status.warnInk }}>✕ {problem}</Text>}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onCancel} style={{ flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontWeight: "600", color: t.appSurface.inkMuted }}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => void send()} style={{ flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: tint, alignItems: "center", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ fontWeight: "600", color: "#fff" }}>Send to the nurse</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}
