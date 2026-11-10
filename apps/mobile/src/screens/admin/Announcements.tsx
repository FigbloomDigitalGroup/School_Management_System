import { useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Check, Square, SquareCheck } from "lucide-react-native";
import {
  announcementAudience, announcementReach, AUDIENCE_CHOICES, CHANNEL_OPTIONS, DEFAULT_CHANNELS, fetchAnnouncementsData, formatMoney, insertAnnouncement,
  RECIPIENT_OPTIONS, sendAnnouncementPush, smsCostCents, yearLabel,
  type AudienceChoice, type AudienceRecipients, type ChannelFlags,
} from "@figbloom/shared";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { ErrorState } from "../../ui/StateView";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

/** What the last send did, said at the top until the next one. */
type Outcome = { kind: "sent"; text: string } | { kind: "failed"; text: string };

/**
 * The school's announcement composer, on the phone: who should get it (with how many people that is), what it says,
 * how it goes out, and the bill for the SMS part before the send button. Sending asks first, because it cannot be
 * unsent. Files, signatures, the writing helper and drafts stay on the web: nothing there lists or sends a saved draft
 * either, so on a phone it would be a dead end.
 */
export function AdminAnnouncements({ session }: { session: StaffSession }) {
  const { t, s, accentInk } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, refreshing, refresh, retry } = useLoad(() => fetchAnnouncementsData(session.tenantId), session.tenantId);

  const [audienceId, setAudienceId] = useState<AudienceChoice>("whole_school");
  const [recipients, setRecipients] = useState<AudienceRecipients>("both");
  const [pickedYear, setPickedYear] = useState<string | null>(null);
  const [pickedClass, setPickedClass] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelFlags>(DEFAULT_CHANNELS);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const yearGroup = data ? (data.years.find((y) => y.key === pickedYear) ?? data.years[0] ?? null) : null;
  const classId = pickedClass ?? data?.classes[0]?.id ?? "";
  const reachFor = (id: AudienceChoice) => (data ? announcementReach(data, id, recipients, yearGroup?.key ?? "", classId) : null);
  const reach = reachFor(audienceId);
  const smsCost = channels.sms && reach !== null ? smsCostCents(reach) : 0;
  const ready = !!data && !!subject.trim() && !!body.trim() && (reach ?? 0) > 0 && !sending;

  async function send() {
    if (!data || reach === null) return;
    setSending(true);
    setOutcome(null);
    try {
      const id = await insertAnnouncement(
        session.tenantId,
        session.profileId,
        { subject, body, audience: announcementAudience(audienceId, recipients, yearGroup, classId), channels },
        true,
      );
      const sent = `Sent to ${reach.toLocaleString()} ${reach === 1 ? "person" : "people"}.`;
      let pushNote = "";
      if (channels.push) {
        await sendAnnouncementPush(id).catch((err: Error) => { pushNote = ` Push notifications failed: ${err.message}`; });
      }
      setOutcome({ kind: pushNote ? "failed" : "sent", text: sent + pushNote });
      setSubject("");
      setBody("");
      void refresh();
    } catch (err) {
      setOutcome({ kind: "failed", text: `Could not send: ${err instanceof Error ? err.message : "try again."}` });
    } finally {
      setSending(false);
    }
  }

  function confirmSend() {
    if (!ready || reach === null) return;
    const people = `${reach.toLocaleString()} ${reach === 1 ? "person" : "people"}`;
    const cost = channels.sms ? ` Texting them will cost about ${formatMoney(smsCost, session.country)}.` : "";
    Alert.alert(`Send to ${people}?`, `This cannot be unsent.${cost}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Send now", onPress: () => void send() },
    ]);
  }

  const ink = t.appSurface.ink;
  return (
    <View style={s.screen}>
      <ScreenHeader title="Announcements" sub="Send a notice to families and staff" color={a.deep} back />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {error ? (
          <ErrorState title="Couldn't load the school" body={error} onRetry={retry} />
        ) : (
          <>
            {outcome && (
              <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={{
                  borderWidth: 1, borderRadius: t.radius.lg, padding: 12, marginBottom: 14,
                  borderColor: outcome.kind === "sent" ? t.status.okDot : t.status.badLine,
                  backgroundColor: outcome.kind === "sent" ? t.status.okBg : t.status.badBg,
                }}
              >
                <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: outcome.kind === "sent" ? t.status.okInk : t.status.badInk }}>{outcome.text}</Text>
              </View>
            )}

            <Text style={s.h2}>Who should get this?</Text>
            <View accessibilityRole="radiogroup" style={{ marginTop: 8, gap: 8 }}>
              {AUDIENCE_CHOICES.map((choice) => {
                const on = audienceId === choice.id;
                const count = reachFor(choice.id);
                return (
                  <View key={choice.id}>
                    <Tap
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={count === null ? choice.label : `${choice.label}, ${count.toLocaleString()} people`}
                      onPress={() => setAudienceId(choice.id)}
                      style={[s.card, { padding: 12, flexDirection: "row", alignItems: "center", gap: 10, borderColor: on ? accentInk(a.deep) : t.appSurface.line, borderWidth: on ? 2 : 1 }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: fontSize.body, fontWeight: "500", color: ink }}>{choice.label}</Text>
                        {!!choice.hint && <Text style={s.faint}>{choice.hint}</Text>}
                      </View>
                      {count === null ? <Skeleton width={56} height={12} /> : <Text style={[s.mono, { color: t.appSurface.inkMuted }]}>{count.toLocaleString()} people</Text>}
                      {on && <Check size={18} color={accentInk(a.deep)} />}
                    </Tap>
                    {on && (choice.id === "year" || choice.id === "class") && (
                      <View style={{ marginTop: 8 }}>
                        <PillPicker
                          items={RECIPIENT_OPTIONS.map((r) => ({ id: r.value, name: r.label }))}
                          selectedId={recipients}
                          onPick={(id) => setRecipients(id as AudienceRecipients)}
                          accent={session.accent}
                        />
                        {choice.id === "year" && data && (
                          <PillPicker
                            items={data.years.map((y) => ({ id: y.key, name: yearLabel(y.level, y.year) }))}
                            selectedId={yearGroup?.key ?? null}
                            onPick={setPickedYear}
                            accent={session.accent}
                          />
                        )}
                        {choice.id === "class" && data && (
                          <PillPicker
                            items={data.classes.map((c) => ({ id: c.id, name: c.name }))}
                            selectedId={classId || null}
                            onPick={setPickedClass}
                            accent={session.accent}
                          />
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>

            <Field
              label="Subject"
              hint="This is all a parent sees in the notification, so put the date in it."
              placeholder="e.g. Half-term closing Friday 12 September"
              value={subject}
              onChangeText={setSubject}
              returnKeyType="next"
              style={{ marginTop: 20 }}
            />
            <Field
              label="Message"
              hint="Plain language, one instruction per paragraph. Most parents read this on a phone."
              placeholder="School closes for half-term on Friday at 12:30pm."
              value={body}
              onChangeText={setBody}
              multiline
              style={{ marginTop: 14 }}
            />

            <Text style={[s.h2, { marginTop: 20 }]}>How it goes out</Text>
            <View style={[s.card, { marginTop: 8, padding: 0, overflow: "hidden" }]}>
              {CHANNEL_OPTIONS.map(({ key, label, note }) => {
                const locked = key === "in_app";
                const Box = channels[key] ? SquareCheck : Square;
                return (
                  <Tap
                    key={key}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: channels[key], disabled: locked }}
                    accessibilityLabel={label}
                    disabled={locked}
                    onPress={() => setChannels((c) => ({ ...c, [key]: !c[key] }))}
                    style={{ padding: 12, flexDirection: "row", gap: 12, alignItems: "flex-start", borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
                  >
                    <Box size={22} color={channels[key] ? accentInk(a.deep) : t.appSurface.inkMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: fontSize.body, fontWeight: "500", color: ink }}>{label}</Text>
                      <Text style={s.faint}>{note}</Text>
                    </View>
                  </Tap>
                );
              })}
            </View>

            <View style={[s.card, { marginTop: 16 }]}>
              <Text style={s.eyebrow}>BEFORE YOU SEND</Text>
              <View style={{ marginTop: 8, gap: 6 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={s.small}>Reaches</Text>
                  {reach === null ? <Skeleton width={64} height={12} /> : <Text style={[s.mono, { color: ink }]}>{reach.toLocaleString()} people</Text>}
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={s.small}>SMS cost</Text>
                  <Text style={[s.mono, { color: ink }]}>{formatMoney(smsCost, session.country)}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={s.small}>Cannot be unsent</Text>
                  <Text style={[s.mono, { color: ink }]}>correct</Text>
                </View>
              </View>
              {reach === 0 && (
                <Text accessibilityLiveRegion="polite" style={[s.small, { marginTop: 10, color: t.status.warnInk }]}>
                  This would reach no one. Pick someone else, or another class or year group.
                </Text>
              )}
              <Button label="Send now" loading={sending} disabled={!ready} onPress={confirmSend} style={{ marginTop: 14 }} />
            </View>

            <Text style={[s.faint, { marginTop: 10 }]}>To attach files or ask families to sign something, use the web console.</Text>

            <Text style={[s.h2, { marginTop: 22 }]}>Recently sent</Text>
            <View style={{ marginTop: 8, gap: 8 }}>
              {!data ? (
                [0, 1, 2].map((i) => (
                  <View key={i} style={[s.card, { padding: 12, gap: 6 }]}>
                    <Skeleton width="70%" height={13} />
                    <Skeleton width="30%" height={11} />
                  </View>
                ))
              ) : data.recent.length === 0 ? (
                <View style={s.card}><Text style={s.small}>Nothing has been sent from the school yet.</Text></View>
              ) : (
                data.recent.map((r) => (
                  <View key={r.id} style={[s.card, { padding: 12 }]}>
                    <Text numberOfLines={1} style={{ fontSize: fontSize.body, fontWeight: "500", color: ink }}>{r.subject}</Text>
                    <Text style={s.faint}>
                      {r.published_at ? new Date(r.published_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Draft"}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
