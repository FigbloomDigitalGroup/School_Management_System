import { useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { callUrl, learnerLine, searchLearners, searchStaff, staffLine, type FoundLearner, type FoundStaff } from "@figbloom/shared";
import { PillPicker } from "../../components/PillPicker";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { StaffSession } from "../../lib/staffSession";
import { useSearch } from "../../lib/useSearch";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

type Kind = "learners" | "staff";
const KINDS: { id: Kind; name: string }[] = [{ id: "learners", name: "Learners" }, { id: "staff", name: "Staff" }];

/** What the learner's card opens with. */
export interface OpenLearner { id: string; name: string; line: string }

/**
 * Look a person up from the office, on the move. A learner (by name or admission number) opens a card with their
 * allergies and conditions and the people to call about them; a member of staff is called from the list. The database
 * decides who may read what (the people area), so this only shows what came back.
 */
export function People({ session, onOpenLearner }: { session: StaffSession; onOpenLearner: (learner: OpenLearner) => void }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const [kind, setKind] = useState<Kind>("learners");
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const learners = useSearch<FoundLearner>(query, (q) => searchLearners(session.tenantId, q), { paused: kind !== "learners", key: kind });
  const staff = useSearch<FoundStaff>(query, (q) => searchStaff(session.tenantId, q), { paused: kind !== "staff", key: kind });
  const active = kind === "learners" ? learners : staff;

  async function call(person: FoundStaff) {
    const url = callUrl(person.phone, session.country);
    if (!url) return;
    setProblem(null);
    try {
      await Linking.openURL(url);
    } catch {
      setProblem(`Could not start the call to ${person.name}.`);
    }
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="People" sub="Look up a learner or a member of staff" color={a.deep} back />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}>
        <PillPicker items={KINDS} selectedId={kind} onPick={(id) => setKind(id as Kind)} accent={session.accent} />
        <Field
          label={kind === "learners" ? "Name or admission number" : "Name"}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="words"
          autoCorrect={false}
          hint={active.searching ? "Searching…" : !active.enough ? "Type at least two letters." : undefined}
        />
        {!!problem && <Text accessibilityRole="alert" style={{ fontSize: fontSize.small, color: t.status.badInk }}>{problem}</Text>}
        {!!active.error && <Text accessibilityRole="alert" style={{ fontSize: fontSize.small, color: t.status.badInk }}>Couldn't search: {active.error}</Text>}
        {active.enough && !active.searching && !active.error && active.results.length === 0 && (
          <View style={s.card}><Text style={s.small}>{kind === "learners" ? "No learner matches that." : "Nobody on the staff matches that."}</Text></View>
        )}

        {kind === "learners" && learners.results.length > 0 && (
          <View style={[s.card, { padding: 0, overflow: "hidden" }]}>
            {learners.results.map((l) => (
              <Tap
                key={l.id}
                accessibilityLabel={`${l.name}, ${learnerLine(l)}`}
                onPress={() => onOpenLearner({ id: l.id, name: l.name, line: learnerLine(l) })}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{l.name}</Text>
                  <Text style={s.faint}>{learnerLine(l)}</Text>
                </View>
                <ChevronRight size={18} color={t.appSurface.inkFaint} />
              </Tap>
            ))}
          </View>
        )}

        {kind === "staff" && staff.results.length > 0 && (
          <View style={[s.card, { padding: 0, overflow: "hidden" }]}>
            {staff.results.map((p) => {
              const url = callUrl(p.phone, session.country);
              return (
                <View key={p.id} style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
                  <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{p.name}</Text>
                  <Text style={s.faint}>{staffLine(p)}</Text>
                  {url ? (
                    <Button variant="secondary" label={`Call ${p.phone!.trim()}`} accessibilityHint={`Calls ${p.name} on the phone's dialer`} onPress={() => void call(p)} style={{ marginTop: 8, alignSelf: "flex-start" }} />
                  ) : (
                    <Text style={[s.faint, { marginTop: 4 }]}>No phone number on file.</Text>
                  )}
                </View>
              );
            })}
          </View>
        )}

        <Text style={s.faint}>Adding, editing and archiving people is on the web console, with the same login.</Text>
      </ScrollView>
    </View>
  );
}
