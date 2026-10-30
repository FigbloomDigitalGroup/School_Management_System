import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import {
  DOSE_STATUS_LABEL, fetchChildMedical, formatFileSize, localDay, markMedicalNoticesRead, REQUEST_STATUS_LABEL, removeUnsentPrescription,
  requestDraftProblem, requestMedication, uploadPrescriptionFile, uploadProblem, VISIT_OUTCOME_LABEL, withdrawMedicationRequest,
  type ChildMedical, type MedicationRequestDraft, type VisitOutcome,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useChildren, useTenantId } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { SubScreen } from "../../components/SubScreen";
import { AttachChoices } from "../../components/AttachChoices";
import { notifyMedicalRead } from "../../lib/medicalUnread";
import { pickFile, readPickedFile, type FileSource, type PickedFile } from "../../lib/pickFile";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Tap } from "../../ui/Tap";
import { CircleAlert } from "lucide-react-native";

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
 * here, with a photo (taken now or from the gallery) or a PDF of the
 * prescription if there is one. Opening the screen marks the child's notices
 * read.
 */
export function ParentHealth() {
  const { child, index, setIndex, accent } = useChild();
  const kids = useChildren();
  // Opened from a sick bay push: show the child it is about, not whichever one was last picked.
  const tappedStudent: string | null = useRoute<any>().params?.studentId ?? null;
  useEffect(() => {
    if (!tappedStudent) return;
    const i = kids.findIndex((k) => k.id === tappedStudent);
    if (i >= 0) setIndex(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new tap changes the child
  }, [tappedStudent]);
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
              onSend={async (draft, file) => {
                let path: string | null = null;
                try {
                  path = file ? await uploadPrescriptionFile(tenantId, child.id, await readPickedFile(file)) : null;
                  await requestMedication(tenantId, child.id, draft, path);
                } catch (err) {
                  // Nothing half-sent: a file that went up without its request comes back out.
                  if (path) await removeUnsentPrescription(path);
                  throw err;
                }
                setAsking(false);
                setNote("Sent to the school nurse.");
                setReloadKey((k) => k + 1);
              }}
            />
          ) : (
            <Tap accessibilityRole="button" onPress={() => { setNote(null); setAsking(true); }} style={[s.primary, { backgroundColor: tint }]}>
              <Text style={s.primaryLabel}>Ask the nurse to give a medicine</Text>
            </Tap>
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
                      <Tap accessibilityRole="button" onPress={() => confirmWithdraw(r.id)} style={{ minHeight: 40, justifyContent: "center", alignSelf: "flex-start" }}>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Withdraw</Text>
                      </Tap>
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

/** For medicine a doctor prescribed, or that the family wants the school to give: the nurse checks it and puts it on the round. Dates are typed as YYYY-MM-DD. */
function RequestForm({ first, tint, onCancel, onSend }: {
  first: string;
  tint: string;
  onCancel: () => void;
  onSend: (draft: MedicationRequestDraft, file: PickedFile | null) => Promise<void>;
}) {
  const [drug, setDrug] = useState("");
  const [dose, setDose] = useState("");
  const [times, setTimes] = useState("3");
  const [prescriber, setPrescriber] = useState("");
  const [startsOn, setStartsOn] = useState(localDay(new Date()));
  const [endsOn, setEndsOn] = useState("");
  const [instructions, setInstructions] = useState("");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function chooseFile(source: FileSource) {
    setProblem(null);
    try {
      const picked = await pickFile(source);
      if (picked) setFile(picked);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not add that file.");
    }
  }

  async function send() {
    const draft: MedicationRequestDraft = {
      drug, dose, times_per_day: Math.round(Number(times)), starts_on: startsOn.trim(), ends_on: endsOn.trim() || null, instructions, prescriber,
    };
    const p = requestDraftProblem(draft) ?? (file ? uploadProblem(file) : null);
    if (p) { setProblem(p); return; }
    setBusy(true);
    setProblem(null);
    try {
      await onSend(draft, file);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not send the request.");
      setBusy(false);
    }
  }

  const field = (label: string, value: string, onChange: (v: string) => void, extra?: { placeholder?: string; keyboard?: "number-pad" | "numbers-and-punctuation"; max?: number; multiline?: boolean }) => (
    <Field
      label={label}
      value={value}
      onChangeText={onChange}
      editable={!busy}
      maxLength={extra?.max}
      keyboardType={extra?.keyboard}
      placeholder={extra?.placeholder}
      multiline={extra?.multiline}
    />
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
      {field("Instructions", instructions, setInstructions, { placeholder: "e.g. After meals, finish the course", max: 1000, multiline: true })}
      {file ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={[s.small, { flex: 1, color: t.appSurface.ink }]}>📎 {file.name}{file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ""}</Text>
          <Tap accessibilityRole="button" disabled={busy} onPress={() => setFile(null)} style={{ minHeight: 40, justifyContent: "center" }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: t.status.warnInk }}>Remove</Text>
          </Tap>
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={labelStyle}>Add a photo or PDF of the prescription (optional)</Text>
          <AttachChoices disabled={busy} onChoose={(source) => void chooseFile(source)} />
        </View>
      )}
      {!!problem && (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
          <CircleAlert size={14} color={t.status.warnInk} style={{ marginTop: 2 }} />
          <Text style={{ flex: 1, fontSize: 12.5, color: t.status.warnInk }}>{problem}</Text>
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button variant="secondary" label="Cancel" disabled={busy} onPress={onCancel} style={{ flex: 1 }} />
        <Button label="Send to the nurse" tint={tint} loading={busy} onPress={() => void send()} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
