import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { formatDueLabel, markAssignmentHandedIn, minutesWords, type WorkItem } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";
import { LinkCard } from "../../components/LinkCard";
import { MediaLinks, useAttachments } from "../../components/MediaLinks";
import { Tap } from "../../ui/Tap";
import { OpenLabel } from "../../ui/OpenLabel";

const TAG: Record<WorkItem["state"], { bg: string; ink: string }> = {
  late: { bg: t.status.warnBg, ink: t.status.warnInk },
  open: { bg: "#F1EDEC", ink: "#6B605F" },
  done: { bg: t.status.okBg, ink: t.status.okInk },
};

/**
 * Overdue stays at the top in orange rather than hiding behind a filter.
 * "Mark as handed in" (FIG-873) persists to assignment_submissions — shown
 * optimistically, rolled back if the write fails since there's no attachment
 * fallback to fall back on here.
 */
export function StudentWork() {
  const nav = useNavigation<any>();
  const { data, accent } = useStudentData();
  const a = accentFor(accent);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [marking, setMarking] = useState<Record<string, boolean>>({});
  const [failedId, setFailedId] = useState<string | null>(null);

  const work = data.work;
  const files = useAttachments("homework", work.map((w) => w.id));
  const toHandIn = work.filter((w) => w.state !== "done" && !done[w.id]).length;

  async function handIn(assignmentId: string) {
    setFailedId(null);
    setDone((d) => ({ ...d, [assignmentId]: true }));
    setMarking((m) => ({ ...m, [assignmentId]: true }));
    try {
      await markAssignmentHandedIn(assignmentId, data.studentId);
    } catch {
      setDone((d) => ({ ...d, [assignmentId]: false }));
      setFailedId(assignmentId);
    } finally {
      setMarking((m) => ({ ...m, [assignmentId]: false }));
    }
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Work</Text>
        <Text style={s.headerSub}>{toHandIn} to hand in</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* Learning materials is a stack screen, not a seventh tab: six is already a full bar. */}
        <Tap
          accessibilityRole="button"
          onPress={() => nav.navigate("Materials")}
          style={[s.card, { marginBottom: 12, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>LEARNING MATERIALS</Text>
            <Text style={[s.small, { marginTop: 4 }]}>Notes, worksheets and videos your teachers have shared</Text>
          </View>
          <OpenLabel tint={a.deep} />
        </Tap>

        <LinkCard label="Sports & activities" blurb="Your clubs and teams, what's coming up, and what you've won." tint={a.deep} to="Activities" />
        <LinkCard label="My items" blurb="Books and equipment the school has lent you, and when to bring them back." tint={a.deep} to="Items" />
        <LinkCard label="Fees" blurb="What you owe this term, what it covers, your receipts, and how to pay." tint={a.deep} to="Fees" />
        <View style={{ height: 12 }} />

        {work.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>Nothing set yet. Anything your teachers set appears here the moment they set it.</Text>
          </View>
        ) : (
          work.map((w) => {
            const state: WorkItem["state"] = done[w.id] ? "done" : w.state;
            const tag = TAG[state];
            return (
              <View key={w.id} style={[s.card, { marginBottom: 10, borderColor: state === "late" ? t.brand.orangeLine : t.appSurface.line }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: "600", lineHeight: 20 }}>{w.title}</Text>
                    <Text style={[s.faint, { marginTop: 4 }]}>{w.subject} · {w.teacher}</Text>
                    {(!!w.needs?.length || !!minutesWords(w.minutes)) && (
                      <Text style={[s.small, { marginTop: 6 }]}>
                        {[w.needs?.length ? `You'll need: ${w.needs.join(", ")}` : "", minutesWords(w.minutes)].filter(Boolean).join(" · ")}
                      </Text>
                    )}
                  </View>
                  <View style={[s.pill, { backgroundColor: tag.bg }]}>
                    <Text style={[s.pillLabel, { color: tag.ink }]}>
                      {state === "done" ? "Done" : formatDueLabel(w.dueOn, state === "late")}
                    </Text>
                  </View>
                </View>

                <MediaLinks items={files.get(w.id) ?? []} tint={a.deep} heading="FROM YOUR TEACHER" />

                {state !== "done" && (
                  <>
                    <Tap
                      disabled={marking[w.id]}
                      onPress={() => void handIn(w.id)}
                      style={[s.primary, { backgroundColor: a.deep, marginTop: 12, paddingVertical: 12, opacity: marking[w.id] ? 0.6 : 1 }]}
                    >
                      <Text style={s.primaryLabel}>{marking[w.id] ? "Marking…" : "Mark as handed in"}</Text>
                    </Tap>
                    {failedId === w.id && (
                      <Text style={[s.small, { color: "#B4472B", marginTop: 6 }]}>Could not save that. Try again.</Text>
                    )}
                  </>
                )}
              </View>
            );
          })
        )}
        <Text style={[s.faint, { marginTop: 8, lineHeight: 18 }]}>
          Marking work as handed in tells your teacher you have finished it. It does not upload anything.
        </Text>
      </ScrollView>
    </View>
  );
}
