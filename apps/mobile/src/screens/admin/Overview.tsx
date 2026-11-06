import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import {
  feeCollectedPct, formatMoney, needsYou, overviewAttendanceRate, registerDayLabel, remindClassTeacher,
  type LatestRegisters, type OverviewClass, type SchoolOverview,
} from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

/** A class's register, opened from a row: who was late, absent or excused. */
export interface OpenRegister { classId: string; className: string; date: string }
export type OpenRegisterHandler = (register: OpenRegister) => void;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { t, s } = useTheme();
  return (
    <View style={[s.card, { padding: 0, overflow: "hidden", marginTop: 14 }]}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
        <Text style={s.h2}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  const { t, s } = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}. ${sub}`} style={[s.card, { flexBasis: "47%", flexGrow: 1, padding: 14 }]}>
      <Text style={s.faint}>{label}</Text>
      <Text style={{ fontSize: fontSize.header + 3, fontWeight: "700", color: t.appSurface.ink, marginTop: 4 }}>{value}</Text>
      <Text style={[s.faint, { marginTop: 2 }]}>{sub}</Text>
    </View>
  );
}

/** A thin bar for a share of a whole; the fill is a status colour, never the school's accent. */
function Bar({ share, fill }: { share: number; fill: string }) {
  const { t } = useTheme();
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 6, borderRadius: 3, backgroundColor: t.appSurface.lineSoft, overflow: "hidden" }}>
      <View style={{ height: 6, borderRadius: 3, width: `${pct}%`, backgroundColor: fill }} />
    </View>
  );
}

/** "27 / 30" and the way into who was missing; the bar is the share who were here (late counts as here). */
function RegisterRow({ name, present, onRoll, note, onOpen }: { name: string; present: number; onRoll: number; note?: string; onOpen: () => void }) {
  const { t, s } = useTheme();
  return (
    <Tap
      accessibilityLabel={`${name}, ${present} of ${onRoll} here. See who wasn't`}
      onPress={onOpen}
      style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.body, color: t.appSurface.ink }}>{name}</Text>
        <Text style={[s.mono, { color: t.appSurface.inkMuted }]}>{present} / {onRoll}</Text>
        <ChevronRight size={16} color={t.appSurface.inkFaint} />
      </View>
      {!!note && <Text style={[s.faint, { marginTop: 2 }]}>{note}</Text>}
      <View style={{ marginTop: 6 }}><Bar share={onRoll > 0 ? present / onRoll : 0} fill={t.status.okDot} /></View>
    </Tap>
  );
}

function NotTakenPill() {
  const { t, s } = useTheme();
  return (
    <View style={[s.pill, { backgroundColor: t.status.warnBg }]}>
      <Text style={[s.pillLabel, { color: t.status.warnInk }]}>Not taken</Text>
    </View>
  );
}

type Reminder = "sending" | "sent" | { error: string };

/** The day the registers are from, when it is not today: the last day any class took one. */
function DayNote({ date }: { date: string }) {
  const { s } = useTheme();
  const day = registerDayLabel(date);
  if (day === "today") return null;
  return <Text style={[s.faint, { paddingHorizontal: 14, paddingTop: 10 }]}>No class has taken today's register yet. These are from {day}, the last one taken.</Text>;
}

/** Every class's register for the day: the numbers, and for a class that has not taken it, a reminder to its teacher. */
function AttendanceByClass({ session, data, onOpen }: { session: StaffSession; data: SchoolOverview; onOpen: OpenRegisterHandler }) {
  const { t, s } = useTheme();
  const [reminders, setReminders] = useState<Record<string, Reminder>>({});

  async function remind(cls: OverviewClass) {
    setReminders((r) => ({ ...r, [cls.id]: "sending" }));
    try {
      await remindClassTeacher(session.tenantId, session.profileId, cls);
      setReminders((r) => ({ ...r, [cls.id]: "sent" }));
    } catch (err) {
      setReminders((r) => ({ ...r, [cls.id]: { error: err instanceof Error ? err.message : "Could not send the reminder." } }));
    }
  }

  const day = data.attendanceDate ? registerDayLabel(data.attendanceDate) : null;
  return (
    <Section title={day ? `Attendance by class · ${day}` : "Attendance by class"}>
      {data.attendanceDate && <DayNote date={data.attendanceDate} />}
      {data.classes.length === 0 ? (
        <Text style={[s.small, { padding: 14 }]}>No classes have been set up yet.</Text>
      ) : !data.attendanceDate ? (
        <Text style={[s.small, { padding: 14 }]}>No class has taken a register this term yet.</Text>
      ) : (
        data.classes.map((c) => {
          if (data.submittedClasses.has(c.id)) {
            const late = data.lateByClass.get(c.id) ?? 0;
            const absent = data.absentByClass.get(c.id) ?? 0;
            const note = [late > 0 ? `${late} late` : "", absent > 0 ? `${absent} absent` : ""].filter(Boolean).join(" · ");
            return (
              <RegisterRow
                key={c.id}
                name={c.name}
                present={data.presentByClass.get(c.id) ?? 0}
                onRoll={data.studentsByClass.get(c.id) ?? 0}
                note={note}
                onOpen={() => onOpen({ classId: c.id, className: c.name, date: data.attendanceDate! })}
              />
            );
          }
          const state = reminders[c.id];
          return (
            <View key={c.id} style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.body, color: t.appSurface.ink }}>{c.name}</Text>
                <NotTakenPill />
              </View>
              {!c.class_teacher_id ? (
                <Text style={[s.faint, { marginTop: 4 }]}>No class teacher is set for this class.</Text>
              ) : state === "sent" ? (
                <Text accessibilityLiveRegion="polite" style={[s.faint, { marginTop: 4, color: t.status.okInk }]}>Reminder sent to the class teacher.</Text>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    label="Remind teacher"
                    loading={state === "sending"}
                    onPress={() => void remind(c)}
                    style={{ marginTop: 8, alignSelf: "flex-start" }}
                  />
                  {typeof state === "object" && (
                    <Text accessibilityRole="alert" style={[s.small, { marginTop: 6, color: t.status.badText }]}>Could not send the reminder: {state.error}</Text>
                  )}
                </>
              )}
            </View>
          );
        })
      )}
    </Section>
  );
}

/** The overview a principal reads first: is the school running today, is anything on fire, and where do the fees stand. */
export function OverviewSections({ session, data, onOpen, afterNeeds }: { session: StaffSession; data: SchoolOverview; onOpen: OpenRegisterHandler; afterNeeds?: ReactNode }) {
  const { t, s } = useTheme();
  const rate = overviewAttendanceRate(data);
  const feePct = feeCollectedPct(data.fees);
  const needs = needsYou(data);
  const classes = data.classes.length;

  const buckets: [string, number, string][] = [
    ["Paid in full", data.fees.full_paid, t.status.okDot],
    ["Part paid", data.fees.part_paid, t.status.cautionDot],
    ["Nothing paid", data.fees.nothing_paid, t.status.warnDot],
  ];
  const invoices = Math.max(data.fees.invoices, 1);

  return (
    <>
      <Text style={s.eyebrow}>{(data.term?.name ?? "No current term").toUpperCase()}</Text>
      <Text style={[s.small, { marginTop: 4 }]}>
        {data.submittedClasses.size} of {classes} classes have submitted attendance and fee collection stands at {feePct}%. {needs.length === 0 ? "Nothing needs you." : `${needs.length} thing${needs.length === 1 ? "" : "s"} need${needs.length === 1 ? "s" : ""} you.`}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
        <Stat label="Attendance" value={rate === null ? "—" : `${rate}%`} sub={`${data.submittedClasses.size} of ${classes} classes submitted`} />
        <Stat label="Fees collected" value={`${feePct}%`} sub={`${formatMoney(data.fees.paid, session.country)} of ${formatMoney(data.fees.billed, session.country)}`} />
        <Stat label="Learners" value={data.activeStudents.toLocaleString()} sub={`across ${classes} classes`} />
        <Stat label="Staff" value={String(data.staffCount)} sub="school admins and teachers" />
      </View>

      <View style={[s.banner, { flexDirection: "column", gap: 8, marginTop: 14 }]}>
        <Text style={{ fontSize: fontSize.lead, fontWeight: "600", color: t.brand.orangeInk }}>Needs you</Text>
        {needs.length === 0 ? (
          <Text style={s.bannerText}>Nothing needs you right now.</Text>
        ) : (
          needs.map((n) => (
            <View key={n.title}>
              <Text style={{ fontSize: fontSize.small, fontWeight: "700", color: t.brand.orangeInk }}>{n.title}</Text>
              <Text style={[s.bannerText, { marginTop: 2 }]}>{n.body}</Text>
            </View>
          ))
        )}
      </View>

      {afterNeeds}

      <AttendanceByClass session={session} data={data} onOpen={onOpen} />

      <Section title="Fee collection · this term">
        {buckets.map(([label, n, fill]) => (
          <View key={label} style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
              <Text style={{ fontSize: fontSize.body, color: t.appSurface.ink }}>{label}</Text>
              <Text style={[s.mono, { color: t.appSurface.inkMuted }]}>{n}</Text>
            </View>
            <Bar share={n / invoices} fill={fill} />
          </View>
        ))}
      </Section>
    </>
  );
}

/** For someone who holds the attendance area but is not a full admin: every class's latest register, each one open to read. */
export function LatestRegistersSection({ data, onOpen }: { data: LatestRegisters; onOpen: OpenRegisterHandler }) {
  const { t, s } = useTheme();
  const day = data.date ? registerDayLabel(data.date) : null;
  return (
    <Section title={day ? `Attendance by class · ${day}` : "Attendance by class"}>
      {data.date && <DayNote date={data.date} />}
      {!data.date ? (
        <Text style={[s.small, { padding: 14 }]}>No class has taken a register yet.</Text>
      ) : (
        data.classes.map((c) => data.taken.has(c.id) ? (
          <RegisterRow
            key={c.id}
            name={c.name}
            present={data.present.get(c.id) ?? 0}
            onRoll={data.learners.get(c.id) ?? 0}
            onOpen={() => onOpen({ classId: c.id, className: c.name, date: data.date! })}
          />
        ) : (
          <View key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: fontSize.body, color: t.appSurface.ink }}>{c.name}</Text>
            <NotTakenPill />
          </View>
        ))
      )}
    </Section>
  );
}
