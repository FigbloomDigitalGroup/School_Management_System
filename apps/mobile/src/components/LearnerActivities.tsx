import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  ACTIVITY_CATEGORY_LABEL, EVENT_KIND_LABEL, EVENT_LEVEL_LABEL, achievementLabel, formatEventWhen, loadLearnerActivities,
  type LearnerActivities,
} from "@figbloom/shared";
import { s, t } from "../theme";

/**
 * One learner's clubs and teams, what's coming up for them, and what they've
 * won, read-only (the patron adds members and results on the web). The same
 * view the parent sees for their child and the learner sees for themself.
 */
export function LearnerActivitiesView({ tenantId, studentId, first, tint }: {
  tenantId: string;
  studentId: string;
  /** "Amani", or null for the learner themselves ("You aren't in ...") */
  first: string | null;
  tint: string;
}) {
  const [data, setData] = useState<LearnerActivities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    loadLearnerActivities(tenantId, studentId)
      .then((d) => { if (alive) setData(d); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load activities."); });
    return () => { alive = false; };
  }, [tenantId, studentId]);

  if (error) return <Text style={[s.small, { color: t.status.warnInk }]}>Could not load activities: {error}</Text>;
  if (!data) return <ActivityIndicator color={tint} style={{ marginTop: 24 }} />;

  if (!data.clubs.length && !data.upcoming.length && !data.achievements.length) {
    return (
      <View style={[s.card, { alignItems: "center", padding: 24 }]}>
        <Text style={{ fontSize: 15, fontWeight: "600" }}>No activities yet</Text>
        <Text style={[s.small, { marginTop: 6, textAlign: "center" }]}>
          {first
            ? `${first} isn't in any club, team or society yet. The patron adds members; ask at school if ${first} has joined one.`
            : "You aren't in any club, team or society yet. Ask the teacher who runs it to add you."}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 20 }}>
      <Section title={`CLUBS AND TEAMS · ${data.clubs.length}`}>
        {data.clubs.length === 0 ? <Text style={s.small}>Not a member of any yet.</Text> : data.clubs.map(({ activity, role }) => (
          <View key={activity.id} style={[s.card, { padding: 14 }]}>
            <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start" }]}>
              <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600" }}>{activity.name}</Text>
              {!!role && <Pill bg={t.status.infoBg} ink={t.status.infoInk} label={role} />}
            </View>
            <Text style={[s.faint, { marginTop: 2 }]}>{ACTIVITY_CATEGORY_LABEL[activity.category]}{activity.active ? "" : " · closed"}</Text>
            {!!activity.meetingSchedule && <Text style={[s.small, { marginTop: 6, color: t.appSurface.ink }]}>Meets {activity.meetingSchedule}</Text>}
            {activity.patrons.length > 0 && <Text style={s.small}>Patron: {activity.patrons.map((p) => p.name).join(", ")}</Text>}
          </View>
        ))}
      </Section>

      <Section title={`COMING UP · ${data.upcoming.length}`}>
        {data.upcoming.length === 0 ? <Text style={s.small}>No fixtures, competitions or trips coming up.</Text> : data.upcoming.map((e) => (
          <View key={e.id} style={[s.card, { padding: 14 }]}>
            <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start" }]}>
              <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600" }}>{e.title}</Text>
              {e.takingPart && <Pill bg={t.status.okBg} ink={t.status.okInk} label={first ? `${first} is taking part` : "You're taking part"} />}
            </View>
            <Text style={[s.faint, { marginTop: 2 }]}>
              {[e.activityName, EVENT_KIND_LABEL[e.kind], e.level ? EVENT_LEVEL_LABEL[e.level] : ""].filter(Boolean).join(" · ")}
            </Text>
            <Text style={{ fontSize: 13.5, marginTop: 6, color: t.appSurface.ink }}>{formatEventWhen(e)}{e.venue ? ` · ${e.venue}` : ""}</Text>
            {!!e.opponent && <Text style={s.small}>Against / hosted by {e.opponent}</Text>}
            {!!e.notes && <Text style={[s.small, { marginTop: 6, color: t.appSurface.ink }]}>{e.notes}</Text>}
          </View>
        ))}
      </Section>

      <Section title={`ACHIEVEMENTS · ${data.achievements.length}`}>
        {data.achievements.length === 0 ? <Text style={s.small}>No medals or awards recorded yet.</Text> : (
          <View style={[s.card, { padding: 0 }]}>
            {data.achievements.map((a, i) => (
              <View key={a.event.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.appSurface.lineSoft }}>
                <Text style={{ fontSize: 18, color: t.brand.orange }}>★</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600" }}>{achievementLabel(a)}</Text>
                  <Text style={s.faint}>
                    {[a.event.title, a.activityName, a.event.level ? EVENT_LEVEL_LABEL[a.event.level] : "",
                      new Date(a.event.startsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </Section>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.eyebrow}>{title}</Text>
      {children}
    </View>
  );
}

function Pill({ bg, ink, label }: { bg: string; ink: string; label: string }) {
  return (
    <View style={[s.pill, { backgroundColor: bg, marginLeft: 8, flexShrink: 1 }]}>
      <Text style={[s.pillLabel, { color: ink }]}>{label}</Text>
    </View>
  );
}
