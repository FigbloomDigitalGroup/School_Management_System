import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  AI_HELPER_REFUSAL_TEXT, askTutor, EdgeError, fetchAiHelperStatus, helperRefusal, type AiHelperStatus, type TutorTurn,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";

const STARTERS = [
  "Explain fractions with an example",
  "How do I find the area of a triangle?",
  "Help me plan a composition about my village",
  "Quiz me on the parts of a flower",
];

/**
 * The study helper: an AI tutor for learners, at schools that have turned it
 * on. It explains and asks questions back rather than handing over answers,
 * and it is switched off while an exam is open (the server decides; see
 * supabase/functions/ai-assist). The conversation lives only on this screen:
 * nothing is stored, and leaving it starts afresh, as on the website.
 *
 * At a school that asks for a parent's opt-in, a learner without one is told
 * to ask at home instead (helperRefusal(); the server checks again, so a
 * refusal that comes back with a question is shown as it is).
 */
export function StudentStudyHelper() {
  const nav = useNavigation<any>();
  const { accent } = useStudentData();
  const tint = accentFor(accent).deep;
  // undefined: still asking. null: the school didn't say (offline, or nothing to show).
  const [status, setStatus] = useState<AiHelperStatus | null | undefined>(undefined);
  const [turns, setTurns] = useState<TutorTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState("");
  const [refused, setRefused] = useState("");
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    let alive = true;
    fetchAiHelperStatus(null)
      .then((r) => { if (alive) setStatus(r); })
      .catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, []);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const next: TutorTurn[] = [...turns, { role: "user", content: question.slice(0, 2000) }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError("");
    try {
      const reply = await askTutor(next);
      setTurns([...next, { role: "assistant", content: reply }]);
      setBlocked("");
    } catch (err) {
      // Leave the question out of the history, so asking again doesn't send it twice.
      setTurns(turns);
      setDraft(question);
      if (err instanceof EdgeError && err.status === 423) setBlocked(err.message);
      // switched off, or the opt-in withdrawn, since the screen opened
      else if (err instanceof EdgeError && err.status === 403) setRefused(err.message);
      else setError(err instanceof Error ? err.message : "Bloom didn't answer. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const refusal = status
    ? helperRefusal({ aiEnabled: status.schoolOn, tutorEnabled: status.schoolOn, access: status.access, optInActive: status.optInActive })
    : null;

  const header = (
    <View style={[s.header, { backgroundColor: tint }]}>
      <TouchableOpacity accessibilityRole="button" onPress={() => nav.goBack()} style={{ paddingVertical: 6, marginBottom: 4 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>‹ Back</Text>
      </TouchableOpacity>
      <Text style={s.headerTitle}>Ask Bloom</Text>
      <Text style={s.headerSub}>Your study helper</Text>
    </View>
  );

  if (status === undefined) {
    return (
      <View style={s.screen}>
        {header}
        <ActivityIndicator color={tint} style={{ marginTop: 40 }} />
      </View>
    );
  }

  if (!status || refusal || refused) {
    return (
      <View style={s.screen}>
        {header}
        <View style={{ padding: 16 }}>
          <View style={s.card}>
            <Text style={s.small}>
              {refused || (refusal ? AI_HELPER_REFUSAL_TEXT[refusal] : "Could not check the study helper. Check your connection, then open it again.")}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {header}
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={s.small}>
          Ask Bloom about anything you're learning. Bloom explains and asks you questions back, so you work it out yourself.
        </Text>
        <View style={{ padding: 12, borderRadius: 12, backgroundColor: t.appSurface.shell }}>
          <Text style={[s.small, { lineHeight: 19 }]}>
            Bloom is an AI, not a person, and can get things wrong. Check with your teacher if you're unsure. Don't share your full name,
            phone number or address. If something is worrying you, talk to a trusted adult or call Childline Kenya on{" "}
            <Text
              accessibilityRole="link"
              style={{ fontWeight: "700", color: tint }}
              onPress={() => { void Linking.openURL("tel:116").catch(() => {}); }}
            >
              116
            </Text>{" "}
            (free, any time).
          </Text>
        </View>

        {!!blocked && (
          <View style={{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: t.status.warnInk }}>
            <Text style={{ fontSize: 12.5, color: t.status.warnInk }}>{blocked}</Text>
          </View>
        )}

        {turns.length === 0 && !blocked && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {STARTERS.map((q) => (
              <TouchableOpacity
                key={q}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void send(q)}
                style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: t.appSurface.line, backgroundColor: "#fff" }}
              >
                <Text style={{ fontSize: 13, color: t.appSurface.ink }}>{q}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {turns.map((m, i) => {
          const mine = m.role === "user";
          return (
            <View key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "86%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: mine ? tint : "#fff", borderWidth: mine ? 0 : 1, borderColor: t.appSurface.line }}>
              <Text selectable style={{ fontSize: 14.5, lineHeight: 21, color: mine ? "#fff" : t.appSurface.ink }}>{m.content}</Text>
            </View>
          );
        })}
        {busy && (
          <View style={{ alignSelf: "flex-start", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: "#fff", borderWidth: 1, borderColor: t.appSurface.line }}>
            <Text style={s.faint}>Thinking…</Text>
          </View>
        )}
        {!!error && <Text style={{ fontSize: 12.5, color: t.status.warnInk }}>{error}</Text>}
      </ScrollView>

      <View style={{ borderTopWidth: 1, borderTopColor: t.appSurface.line, backgroundColor: "#fff", padding: 10 }}>
        {turns.length > 0 && (
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy}
            onPress={() => { setTurns([]); setError(""); }}
            style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center", opacity: busy ? 0.5 : 1 }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>New chat</Text>
          </TouchableOpacity>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={2000}
            editable={!blocked}
            placeholder={blocked ? "Bloom is off during the exam." : "Ask Bloom a question…"}
            placeholderTextColor={t.appSurface.inkFaint}
            accessibilityLabel="Your question"
            style={{ flex: 1, maxHeight: 120, minHeight: 44, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: t.appSurface.ink }}
          />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Ask"
            disabled={busy || !draft.trim() || !!blocked}
            onPress={() => void send(draft)}
            style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 14, backgroundColor: tint, alignItems: "center", justifyContent: "center", opacity: busy || !draft.trim() || !!blocked ? 0.5 : 1 }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>Ask</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
