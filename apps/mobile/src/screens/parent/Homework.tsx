import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  daysFromToday, doneByWords, dueWords, HAND_IN_PARENT_LABEL, minutesWords, setHomeworkDone, splitHomework,
  type HomeworkItem, type MediaItem,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useChildren } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { MediaLinks, useAttachments } from "../../components/MediaLinks";
import { useParentHomework } from "../../lib/useParentHomework";
import { Tap } from "../../ui/Tap";
import { BackLink } from "../../ui/BackLink";

/**
 * The selected child's homework from the last three weeks, opened from the
 * Home card (the tab bar already has six tabs). Overdue first, then what's
 * coming, then what's done; each piece carries the teacher's note for
 * parents. A parent of a PP1–Grade 3 learner can mark it done for them.
 */
export function ParentHomework() {
  const nav = useNavigation<any>();
  const { child, index, setIndex, accent } = useChild();
  const kids = useChildren();
  const { byChild, failed, reload } = useParentHomework();
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;

  const mine = byChild?.[child.id];
  const groups = splitHomework(mine?.items ?? []);
  const files = useAttachments("homework", (mine?.items ?? []).map((i) => i.id));

  async function mark(item: HomeworkItem, done: boolean) {
    setBusy(item.id);
    setSaveError(null);
    try {
      await setHomeworkDone(item.id, child.id, done);
      reload();
    } catch {
      setSaveError(item.id);
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <BackLink onPress={() => nav.goBack()} />
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>{child.first}'s homework</Text>
            <Text style={s.headerSub}>
              {mine ? (mine.parentMarksDone ? `You can mark work done for ${child.first}` : `${child.first} marks their own work done`) : child.cls}
            </Text>
          </View>
          <ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {byChild === null ? (
          failed ? (
            <View style={s.card}><Text style={s.small}>Could not load homework. Check your connection and try again.</Text></View>
          ) : (
            <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
          )
        ) : !mine || mine.items.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={[s.small, { textAlign: "center" }]}>
              No homework yet. Anything {child.first}'s teachers set will show here, with a note on how you can help.
            </Text>
          </View>
        ) : (
          ([
            ["OVERDUE", groups.overdue],
            ["COMING UP", groups.upcoming],
            ["DONE", groups.done],
          ] as const).map(([label, items]) => items.length > 0 && (
            <View key={label} style={{ marginBottom: 12 }}>
              <Text style={[s.eyebrow, { marginBottom: 8 }]}>{label} · {items.length}</Text>
              {items.map((item) => (
                <HomeworkCard
                  key={item.id}
                  item={item}
                  files={files.get(item.id) ?? []}
                  childFirst={child.first}
                  canMark={mine.parentMarksDone}
                  busy={busy === item.id}
                  failed={saveError === item.id}
                  tint={tint}
                  onMark={(done) => void mark(item, done)}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function HomeworkCard({ item, files, childFirst, canMark, busy, failed, tint, onMark }: {
  item: HomeworkItem;
  files: MediaItem[];
  childFirst: string;
  canMark: boolean;
  busy: boolean;
  failed: boolean;
  tint: string;
  onMark: (done: boolean) => void;
}) {
  const g = item.guide;
  const overdue = !item.done && daysFromToday(item.dueOn) < 0;
  const time = minutesWords(g?.minutes);
  const tag = item.done
    ? { bg: t.status.okBg, ink: t.status.okInk, label: "Done" }
    : overdue
      ? { bg: t.status.warnBg, ink: t.status.warnInk, label: dueWords(item.dueOn) }
      : { bg: "#F1EDEC", ink: "#6B605F", label: dueWords(item.dueOn) };

  return (
    <View style={[s.card, { marginBottom: 10, borderColor: overdue ? t.brand.orangeLine : t.appSurface.line }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14.5, fontWeight: "600", lineHeight: 20 }}>{item.title}</Text>
          <Text style={[s.faint, { marginTop: 4 }]}>{item.subject} · {item.teacher}</Text>
        </View>
        <View style={[s.pill, { backgroundColor: tag.bg, alignSelf: "flex-start" }]}>
          <Text style={[s.pillLabel, { color: tag.ink }]}>{tag.label}</Text>
        </View>
      </View>

      {!!item.body && <Text style={[s.small, { marginTop: 8 }]}>{item.body}</Text>}

      <MediaLinks items={files} tint={tint} heading="FROM THE TEACHER" />

      {g && (
        <View style={{ marginTop: 10, gap: 8, padding: 12, borderRadius: 12, backgroundColor: t.appSurface.page }}>
          {!!g.about && <GuideLine label="WHAT IT'S ABOUT" text={g.about} />}
          {g.needs.length > 0 && <GuideLine label="YOUR CHILD WILL NEED" text={g.needs.join(", ")} />}
          {!!g.help && <GuideLine label="HOW YOU CAN HELP" text={g.help} />}
          {!!g.avoid && <GuideLine label="PLEASE AVOID" text={g.avoid} />}
          {!!time && <GuideLine label="TIME" text={time} />}
        </View>
      )}

      <Text style={[s.faint, { marginTop: 10 }]}>{HAND_IN_PARENT_LABEL[item.handIn]}</Text>

      {item.done ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
          <Text style={[s.small, { color: t.status.okInk, flex: 1 }]}>{doneByWords(item.doneBy, childFirst)}</Text>
          {/* Only what this parent ticked can be unticked here, and never one with a file attached. */}
          {canMark && item.doneBy === "you" && !item.hasFile && (
            <Tap accessibilityRole="button" disabled={busy} onPress={() => onMark(false)} style={{ paddingVertical: 8, paddingLeft: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: t.appSurface.inkMuted }}>{busy ? "Saving…" : "Undo"}</Text>
            </Tap>
          )}
        </View>
      ) : canMark ? (
        <Tap
          accessibilityRole="button"
          disabled={busy}
          onPress={() => onMark(true)}
          style={[s.primary, { backgroundColor: tint, marginTop: 10, paddingVertical: 12, opacity: busy ? 0.6 : 1 }]}
        >
          <Text style={s.primaryLabel}>{busy ? "Saving…" : "Mark done"}</Text>
        </Tap>
      ) : (
        <Text style={[s.faint, { marginTop: 8 }]}>{childFirst} marks it done when it's finished.</Text>
      )}
      {failed && <Text style={[s.small, { color: "#B4472B", marginTop: 6 }]}>Could not save that. Try again.</Text>}
    </View>
  );
}

function GuideLine({ label, text }: { label: string; text: string }) {
  return (
    <View>
      <Text style={s.eyebrow}>{label}</Text>
      <Text style={[s.small, { color: t.appSurface.ink, marginTop: 2 }]}>{text}</Text>
    </View>
  );
}
