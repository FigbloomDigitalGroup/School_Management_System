import { useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import {
  applicationReadiness, applyForLeave, cancelHrLeave, documentProblem, EdgeError, fetchHrLeaveApplications, fetchLeaveForm, HR_LEAVE_CANCELLED, HR_LEAVE_SENT,
  hrStatusLabel, isDateOnly, leaveProblems, leaveRange, leaveTypeRules, MAX_LEAVE_DOCUMENT_BYTES, readLeave, readLeaveForm, type LeaveApplication,
} from "@figbloom/shared";
import { formatDateInput } from "../lib/dateInput";
import { hrStatusTone } from "../lib/hrTone";
import { LEAVE_DOCUMENT_FILES, pickFile, readPickedBase64, type FileSource, type PickedFile } from "../lib/pickFile";
import { useLoad } from "../lib/useLoad";
import { accentFor, fontSize } from "../theme";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { EmptyState, ErrorState } from "../ui/StateView";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";
import { AttachChoices } from "./AttachChoices";
import { PillPicker } from "./PillPicker";
import { Skeleton } from "./Skeleton";

/** What the last apply or cancel did, said at the top until the next one. */
type Outcome = { kind: "done" | "failed"; text: string };

interface Values { typeId: string; startDate: string; endDate: string; halfDay: boolean; reason: string }
const EMPTY: Values = { typeId: "", startDate: "", endDate: "", halfDay: false, reason: "" };

/** A photo of a document is shrunk to this many pixels a side, so it stays under what HR takes (3 MB). */
const PHOTO_PIXELS = 2000;

/**
 * Leave through Figbloom HR, for someone at a school whose leave runs there: apply with HR's own types and rules,
 * a reason and a document, then follow each application until it is approved, or cancel it while HR allows. It all
 * goes through HR (the my-hr function) as the signed-in person; once HR approves, the leave appears in Schools on
 * its own. The teacher's Leave screen and other staff's "My leave" both show this, under their own header.
 * Dates are typed as digits and laid out as YYYY-MM-DD (there is no date picker in the app yet).
 */
export function HrLeave({ accent }: { accent: string }) {
  const { t, s } = useTheme();
  const a = accentFor(accent);
  const form = useLoad(() => fetchLeaveForm().then(readLeaveForm), "form");
  const mine = useLoad(() => fetchHrLeaveApplications().then(readLeave), "mine");
  const [values, setValues] = useState<Values>(EMPTY);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [documentNote, setDocumentNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** HR's refusal of the last try (422 leave_rules), shown on the form with each rule */
  const [refusal, setRefusal] = useState<{ message: string; problems: string[] } | null>(null);

  const change = (v: Partial<Values>) => setValues((old) => ({ ...old, ...v }));
  const readiness = form.data ? applicationReadiness(form.data, { ...values, documentName: file?.name ?? null }) : null;
  const startError = values.startDate.length === 10 && !isDateOnly(values.startDate) ? "That isn't a date." : undefined;
  const endError = values.endDate.length === 10 && !isDateOnly(values.endDate)
    ? "That isn't a date."
    : isDateOnly(values.startDate) && isDateOnly(values.endDate) && values.endDate < values.startDate ? "The last day is before the first." : undefined;

  const tone = {
    ok: { bg: t.status.okBg, ink: t.status.okInk },
    warn: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
    muted: { bg: t.status.mutedBg, ink: t.status.mutedInk },
  };

  async function chooseFile(source: FileSource) {
    setDocumentNote(null);
    try {
      const picked = await pickFile(source, LEAVE_DOCUMENT_FILES, { maxPixels: PHOTO_PIXELS });
      if (!picked) return;
      // The phone may not say how big it is: that is checked again from the bytes when it is sent.
      const problem = documentProblem({ size: picked.sizeBytes ?? 1, type: picked.mimeType });
      if (problem) { setDocumentNote(problem); return; }
      setFile(picked);
    } catch (err) {
      setDocumentNote(err instanceof Error ? err.message : "Could not add that file.");
    }
  }

  async function submit() {
    if (!readiness?.ready || saving) return;
    setSaving(true);
    setRefusal(null);
    setOutcome(null);
    try {
      let document: { name: string; contentType: string; base64: string } | null = null;
      if (file) {
        const read = await readPickedBase64(file);
        const problem = documentProblem({ size: read.size, type: file.mimeType });
        if (problem) throw new Error(problem);
        document = { name: file.name, contentType: file.mimeType, base64: read.base64 };
      }
      await applyForLeave({ typeId: values.typeId, startDate: values.startDate, endDate: values.endDate, halfDay: values.halfDay, reason: values.reason.trim(), document });
      setOutcome({ kind: "done", text: HR_LEAVE_SENT });
      setValues(EMPTY);
      setFile(null);
      // The days left change with an application waiting, and it joins the list.
      void Promise.all([mine.refresh(), form.refresh()]);
    } catch (err) {
      if (err instanceof EdgeError && err.code === "leave_rules") setRefusal(leaveProblems(err));
      else setOutcome({ kind: "failed", text: err instanceof Error ? err.message : "Could not apply for leave." });
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: string) {
    setCancellingId(id);
    setOutcome(null);
    try {
      await cancelHrLeave(id);
      setOutcome({ kind: "done", text: HR_LEAVE_CANCELLED });
    } catch (err) {
      // not_cancellable: HR's answer changed since the list was read
      setOutcome({ kind: "failed", text: err instanceof Error ? err.message : "Could not cancel." });
    } finally {
      setCancellingId(null);
    }
    void mine.refresh();
  }

  function confirmCancel(app: LeaveApplication) {
    Alert.alert("Cancel this leave application?", `${app.type}, ${leaveRange(app.from, app.to)}. It is cancelled in Figbloom HR.`, [
      { text: "Keep it", style: "cancel" },
      { text: "Cancel it", style: "destructive", onPress: () => void cancel(app.id) },
    ]);
  }

  const type = readiness?.type ?? null;
  const days = (n: number | null) => (n === null ? "" : ` · ${n} ${n === 1 ? "day" : "days"}`);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={form.refreshing || mine.refreshing} onRefresh={() => void Promise.all([form.refresh(), mine.refresh()])} />}
    >
      {outcome && (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{
            borderWidth: 1, borderRadius: t.radius.lg, padding: 12, marginBottom: 14,
            borderColor: outcome.kind === "done" ? t.status.okDot : t.status.badLine,
            backgroundColor: outcome.kind === "done" ? t.status.okBg : t.status.badBg,
          }}
        >
          <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: outcome.kind === "done" ? t.status.okInk : t.status.badInk }}>{outcome.text}</Text>
        </View>
      )}

      {/* ---------------------------------------------------------------- the form */}
      {form.error && !form.data ? (
        <ErrorState title="Couldn't load the leave form" body={form.error} onRetry={form.retry} />
      ) : !form.data ? (
        <View style={[s.card, { padding: 14, gap: 10 }]}>
          <Skeleton width="40%" height={14} />
          <Skeleton width="90%" height={44} />
          <Skeleton width="90%" height={44} />
        </View>
      ) : form.data.types.length === 0 ? (
        <EmptyState title="No leave types yet" body="Figbloom HR has no leave types you can apply for. Ask the school's HR administrator." />
      ) : (
        <View style={[s.card, { gap: 10 }]}>
          <Text style={s.h2}>New leave application</Text>
          <Text style={s.small}>Your school's leave runs in Figbloom HR. Your application goes there for approval.</Text>
          <View>
            <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 }}>Type of leave</Text>
            <PillPicker
              items={form.data.types.map((ty) => ({ id: ty.id, name: ty.name }))}
              selectedId={values.typeId || null}
              onPick={(id) => change({ typeId: id, halfDay: false })}
              accent={accent}
            />
            {!!type && !!leaveTypeRules(type) && <Text style={s.faint}>{leaveTypeRules(type)}</Text>}
          </View>

          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <Field
              label="First day"
              placeholder="YYYY-MM-DD"
              keyboardType="number-pad"
              maxLength={10}
              value={values.startDate}
              error={startError}
              editable={!saving}
              onChangeText={(text) => {
                const startDate = formatDateInput(text);
                change(values.halfDay ? { startDate, endDate: startDate } : { startDate });
              }}
              style={{ flex: 1 }}
            />
            <Field
              label="Last day"
              placeholder="YYYY-MM-DD"
              keyboardType="number-pad"
              maxLength={10}
              value={values.endDate}
              error={endError}
              editable={!saving && !values.halfDay}
              onChangeText={(text) => change({ endDate: formatDateInput(text) })}
              style={{ flex: 1 }}
            />
          </View>

          {type?.halfDays && (
            <Tap
              accessibilityRole="checkbox"
              accessibilityLabel="Half a day"
              accessibilityState={{ checked: values.halfDay }}
              onPress={() => change({ halfDay: !values.halfDay, endDate: !values.halfDay ? values.startDate : values.endDate })}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}
            >
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: values.halfDay ? a.deep : t.appSurface.line, backgroundColor: values.halfDay ? a.deep : "transparent", alignItems: "center", justifyContent: "center" }}>
                {values.halfDay && <Check size={14} color="#fff" />}
              </View>
              <Text style={{ fontSize: fontSize.body, color: t.appSurface.ink }}>Half a day</Text>
            </Tap>
          )}

          <Field
            label={`Reason (at least ${form.data.reasonMin} characters)`}
            value={values.reason}
            onChangeText={(reason) => change({ reason })}
            editable={!saving}
            maxLength={2000}
            multiline
          />

          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink }}>
              {type?.document?.name ?? "Document"} {readiness?.needsDocument ? "(needed)" : "(optional)"}: PDF, photo or Word, up to {MAX_LEAVE_DOCUMENT_BYTES / 1024 / 1024} MB
            </Text>
            <AttachChoices onChoose={(source) => void chooseFile(source)} disabled={saving} />
            {file && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>Attached: {file.name}</Text>
                <Button variant="quiet" label="Remove" onPress={() => { setFile(null); setDocumentNote(null); }} />
              </View>
            )}
            {!!documentNote && <Text accessibilityRole="alert" style={{ fontSize: fontSize.small, color: t.status.badInk }}>{documentNote}</Text>}
          </View>

          {form.data.chain.length > 0 && <Text style={s.faint}>Approved by: {form.data.chain.join(", then ")}.</Text>}

          {refusal && (
            <View accessibilityRole="alert" style={{ borderWidth: 1, borderRadius: t.radius.lg, padding: 12, borderColor: t.status.badLine, backgroundColor: t.status.badBg }}>
              <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: t.status.badInk }}>{refusal.message}</Text>
              {refusal.problems.length > 1 && refusal.problems.map((p) => (
                <Text key={p} style={{ fontSize: fontSize.small, color: t.status.badInk, marginTop: 4 }}>{"•"} {p}</Text>
              ))}
            </View>
          )}

          <Button label="Apply for leave" loading={saving} disabled={!readiness?.ready} onPress={() => void submit()} />
        </View>
      )}

      {/* ---------------------------------------------------------------- the applications */}
      <Text style={[s.eyebrow, { marginTop: 22, marginBottom: 8 }]}>YOUR APPLICATIONS</Text>
      {mine.error && !mine.data ? (
        <ErrorState title="Couldn't load your applications" body={mine.error} onRetry={mine.retry} />
      ) : !mine.data ? (
        <View style={{ gap: 8 }}>
          {[0, 1].map((i) => (
            <View key={i} style={[s.card, { padding: 14, gap: 8 }]}>
              <Skeleton width="50%" height={14} />
              <Skeleton width="35%" height={11} />
            </View>
          ))}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {mine.data.balances.length > 0 && (
            <View accessibilityLabel="Balances" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {mine.data.balances.map((b) => (
                <View key={b.type} style={[s.pill, { backgroundColor: tone.muted.bg }]}>
                  <Text style={[s.pillLabel, { color: tone.muted.ink }]}>{b.type}: {b.available ?? "—"} {b.available === 1 ? "day" : "days"} left</Text>
                </View>
              ))}
            </View>
          )}
          {mine.data.applications.length === 0 ? (
            <EmptyState title="Nothing applied for yet" body="Your applications show up here, with who has approved them so far." />
          ) : mine.data.applications.map((app) => (
            <View key={app.id} style={[s.card, { padding: 14 }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{app.type}</Text>
                  <Text style={[s.small, { marginTop: 2 }]}>{leaveRange(app.from, app.to)}{days(app.days)}</Text>
                  {!!app.reason && <Text style={[s.faint, { marginTop: 2 }]}>{app.reason}</Text>}
                  {app.steps.length > 0 && (
                    <Text style={[s.faint, { marginTop: 4 }]}>
                      {app.steps.map((step) => `${step.label}: ${hrStatusLabel(step.status)}${step.who ? ` (${step.who})` : ""}`).join(" → ")}
                    </Text>
                  )}
                </View>
                <View style={[s.pill, { backgroundColor: tone[hrStatusTone(app.status)].bg }]}>
                  <Text style={[s.pillLabel, { color: tone[hrStatusTone(app.status)].ink }]}>{hrStatusLabel(app.status)}</Text>
                </View>
              </View>
              {/* HR's own answer to "can it be cancelled now" (pending, or approved before it starts) */}
              {app.cancellable === true && (
                <Button
                  variant="quiet" label="Cancel" tint={t.status.warnInk} loading={cancellingId === app.id} disabled={cancellingId !== null}
                  accessibilityHint={`Cancels ${app.type}, ${leaveRange(app.from, app.to)}, in Figbloom HR`}
                  onPress={() => confirmCancel(app)} style={{ alignSelf: "flex-start", marginTop: 4 }}
                />
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
