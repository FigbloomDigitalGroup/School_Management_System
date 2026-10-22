import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  fetchSentByMe, fetchTeacherClasses, sendClassMessage,
  type Announcement, type ClassGroup, type ClassMessageRecipients,
} from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { queue } from "../../storage";
import type { TeacherSession } from "../../navigation";

const RECIPIENT_OPTIONS: { id: ClassMessageRecipients; name: string }[] = [
  { id: "guardians", name: "Parents" },
  { id: "students", name: "Students" },
  { id: "both", name: "Both" },
];

function recipientsLabel(r?: ClassMessageRecipients): string {
  if (r === "students") return "students";
  if (r === "both") return "parents and students";
  return "parents";
}

/** A teacher's own reach: one class at a time, always in-app — the same
 *  lighter form over `announcements` as the web console's Messages screen. */
export function TeacherMessages({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  const [classes, setClasses] = useState<ClassGroup[] | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<ClassMessageRecipients>("guardians");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Announcement[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => { void queue.flush(); }, []);

  useEffect(() => {
    let alive = true;
    fetchTeacherClasses(session.profileId)
      .then((cls) => { if (alive) { setClasses(cls); if (cls.length) setClassId((id) => id ?? cls[0]!.id); } })
      .catch(() => { if (alive) setClasses([]); });
    return () => { alive = false; };
  }, [session.profileId]);

  useEffect(() => {
    let alive = true;
    fetchSentByMe(session.profileId)
      .then((rows) => { if (alive) setSent(rows); })
      .catch(() => { if (alive) setSent([]); });
    return () => { alive = false; };
  }, [session.profileId, reloadKey]);

  const classById = new Map((classes ?? []).map((c) => [c.id, c]));

  async function send() {
    if (!classId || !subject.trim() || !body.trim()) return;
    setSending(true);
    setStatus(null);
    try {
      await sendClassMessage(session.tenantId, session.profileId, classId, recipients, subject, body);
      setSubject("");
      setBody("");
      setReloadKey((k) => k + 1);
    } catch {
      // Offline or the request failed — hold it on this phone rather than
      // losing what was typed; it sends once queue.flush() next runs. Won't
      // show up in "Sent by you" until then, since that reads the server.
      await queue.enqueue("announcements", [{
        tenant_id: session.tenantId,
        author_id: session.profileId,
        subject: subject.trim(),
        body: body.trim(),
        audience: { kind: "class", class_id: classId, recipients },
        channels: ["in_app"],
        published_at: new Date().toISOString(),
      }]);
      setSubject("");
      setBody("");
      setStatus("Saved on this phone. Will send when you have signal.");
    } finally {
      setSending(false);
    }
  }

  if (!classes) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Messages</Text>
        <Text style={s.headerSub}>Send a note to one of your classes.</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        {classes.length === 0 ? (
          <View style={s.card}><Text style={s.small}>No classes assigned yet. Contact the school office.</Text></View>
        ) : (
          <View style={[s.card, { gap: 10 }]}>
            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Class</Text>
              <PillPicker items={classes} selectedId={classId} onPick={setClassId} accent={session.accent} />
            </View>

            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>To</Text>
              <PillPicker items={RECIPIENT_OPTIONS} selectedId={recipients} onPick={(id) => setRecipients(id as ClassMessageRecipients)} accent={session.accent} />
            </View>

            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Subject</Text>
              <TextInput
                value={subject}
                onChangeText={setSubject}
                placeholder="e.g. CAT results out Friday"
                style={{ ...HIT, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 }}
              />
            </View>

            <View>
              <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Message</Text>
              <TextInput
                value={body}
                onChangeText={setBody}
                placeholder="Plain language, one instruction per paragraph."
                multiline
                numberOfLines={4}
                style={{ borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, padding: 14, fontSize: 14.5, minHeight: 96, textAlignVertical: "top" }}
              />
              <Text style={[s.faint, { marginTop: 6 }]}>Goes to this class's {recipientsLabel(recipients)}, in-app only.</Text>
            </View>

            <TouchableOpacity
              accessibilityRole="button"
              disabled={!subject.trim() || !body.trim() || sending}
              onPress={() => void send()}
              style={[s.primary, { ...HIT, backgroundColor: t.brand.orange, opacity: !subject.trim() || !body.trim() || sending ? 0.6 : 1 }]}
            >
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Send</Text>}
            </TouchableOpacity>
            {!!status && <Text style={[s.small, { marginTop: 10 }]}>{status}</Text>}
          </View>
        )}

        <Text style={[s.eyebrow, { marginTop: 20, marginBottom: 8 }]}>SENT BY YOU</Text>
        {sent === null ? (
          <ActivityIndicator color={a.deep} />
        ) : sent.length === 0 ? (
          <Text style={s.faint}>Nothing sent yet.</Text>
        ) : (
          sent.map((msg) => {
            const className = msg.audience.kind === "class" ? classById.get(msg.audience.class_id)?.name ?? "a class" : "—";
            const who = msg.audience.kind === "class" ? recipientsLabel(msg.audience.recipients) : "parents";
            return (
              <View key={msg.id} style={[s.card, { marginBottom: 8, padding: 12 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ fontSize: 13.5, fontWeight: "600", flex: 1 }} numberOfLines={1}>{msg.subject}</Text>
                  <Text style={s.faint}>
                    {msg.published_at ? new Date(msg.published_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "Draft"}
                  </Text>
                </View>
                <Text style={[s.faint, { marginTop: 3 }]}>To {who} of {className}</Text>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
