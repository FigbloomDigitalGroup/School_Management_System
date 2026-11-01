import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { clubsLine, formatMoney, signatureFor, type StoredReportCard, type StoredSignature } from "@figbloom/shared";
import { SignatureMark } from "./SignatureMark";
import { useTheme } from "../ui/ThemeContext";

const longDate = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

function Stat({ label, value }: { label: string; value: string }) {
  const { t, s } = useTheme();
  return (
    <View>
      <Text style={s.eyebrow}>{label}</Text>
      <Text style={[{ color: t.appSurface.ink }, s.mono, { fontSize: 20, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { s } = useTheme();
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[s.eyebrow, { marginBottom: 6 }]}>{title}</Text>
      {children}
    </View>
  );
}

/**
 * One report card as the school issued it: the stored snapshot the PDF on the
 * website is drawn from, so the two say the same thing. Position, attendance, fees
 * and clubs appear only if the school switched them on for this card. `signatures`
 * is who has signed it (null while that loads); a signature shows only while the
 * card is unchanged since it was made.
 */
export function ReportCardBody({ card, signatures }: { card: StoredReportCard; signatures: StoredSignature[] | null }) {
  const { t, s } = useTheme();
  const d = card.data;
  const teacherSig = signatures && signatureFor(signatures, card.id, "class_teacher", { currentOnly: true });
  const principalSig = signatures && signatureFor(signatures, card.id, "principal", { currentOnly: true });
  const clubs = d.activities?.clubs ?? [];
  const won = d.activities?.achievements ?? [];

  return (
    <View>
      <Text style={[s.small, { marginTop: 12 }]}>
        {[d.learner.name, d.learner.admissionNo, d.learner.className].filter(Boolean).join(" · ")}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, marginTop: 12 }}>
        <Stat label="MEAN" value={d.summary.mean !== null ? `${d.summary.mean}%` : "—"} />
        <Stat label="GRADE" value={d.summary.grade ?? "—"} />
        {d.summary.position !== null && <Stat label="POSITION" value={`${d.summary.position} of ${d.summary.ranked}`} />}
        {d.summary.points !== null && <Stat label="POINTS" value={String(d.summary.points)} />}
      </View>

      {d.subjects.length > 0 && (
        <Section title="SUBJECTS">
          {d.subjects.map((sub, i) => {
            const detail = [
              ...d.exams.map((e, n) => `${e.name} ${sub.scores[n] ?? "—"}`),
              sub.classMean !== null ? `Class mean ${sub.classMean}` : null,
            ].filter(Boolean).join(" · ");
            return (
              <View key={sub.code || sub.name} style={{ flexDirection: "row", gap: 10, paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.appSurface.lineSoft }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "500", color: t.appSurface.ink }}>{sub.name}</Text>
                  {!!detail && <Text style={s.faint}>{detail}</Text>}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[{ color: t.appSurface.ink }, s.mono, { fontSize: 16 }]}>{sub.average ?? "—"}</Text>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: t.appSurface.inkMuted }}>{sub.grade ?? ""}</Text>
                </View>
              </View>
            );
          })}
        </Section>
      )}

      {d.cbe.length > 0 && (
        <Section title="LEARNING AREAS">
          {d.cbe.map((c, i) => (
            <View key={`${c.area}-${c.assessment}`} style={{ paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.appSurface.lineSoft }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                <Text style={{ flex: 1, fontSize: 14, fontWeight: "500", color: t.appSurface.ink }}>{c.area}</Text>
                <Text style={{ fontSize: 13, fontWeight: "700", color: t.appSurface.ink }}>{c.label ?? c.level ?? "Not judged"}</Text>
              </View>
              <Text style={s.faint}>{c.assessment}</Text>
              {!!c.strands?.length && <Text style={[s.small, { marginTop: 2 }]}>{c.strands.map((x) => `${x.name}: ${x.label}`).join(" · ")}</Text>}
              {!!c.comment && <Text style={[s.small, { marginTop: 2 }]}>{c.comment}</Text>}
            </View>
          ))}
        </Section>
      )}

      {!!d.competencies?.length && (
        <Section title="CORE COMPETENCIES AND VALUES">
          {d.competencies.map((c) => (
            <View key={`${c.kind}-${c.label}`} style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 3 }}>
              <Text style={{ flex: 1, fontSize: 13.5, color: t.appSurface.ink }}>{c.label}</Text>
              <Text style={{ fontSize: 13, fontWeight: "600", color: t.appSurface.inkMuted }}>{c.levelLabel}</Text>
            </View>
          ))}
        </Section>
      )}

      {(d.attendance || d.fees || clubs.length > 0 || won.length > 0) && (
        <Section title="ALSO ON THIS CARD">
          {!!d.attendance && <Text style={s.small}>Attendance: present {d.attendance.present} of {d.attendance.days} days</Text>}
          {!!d.fees && (
            <Text style={s.small}>
              Fees: billed {formatMoney(d.fees.billedCents, d.school.country)}, paid {formatMoney(d.fees.paidCents, d.school.country)}
            </Text>
          )}
          {clubs.length > 0 && <Text style={s.small}>Clubs and teams: {clubsLine(clubs)}</Text>}
          {won.length > 0 && <Text style={s.small}>Achievements: {won.map((a) => `${a.result} (${a.activity})`).join(" · ")}</Text>}
        </Section>
      )}

      {(!!card.teacherComment || !!teacherSig) && (
        <Section title={`CLASS TEACHER${d.classTeacher ? ` · ${d.classTeacher.toUpperCase()}` : ""}`}>
          {!!card.teacherComment && <Text style={s.body}>{card.teacherComment}</Text>}
          {!!teacherSig && <View style={{ marginTop: 8 }}><SignatureMark signature={teacherSig} /></View>}
        </Section>
      )}
      {(!!card.principalComment || !!principalSig) && (
        <Section title="PRINCIPAL">
          {!!card.principalComment && <Text style={s.body}>{card.principalComment}</Text>}
          {!!principalSig && <View style={{ marginTop: 8 }}><SignatureMark signature={principalSig} /></View>}
        </Section>
      )}

      {!!d.nextTermBegins && <Text style={[s.small, { marginTop: 16, fontWeight: "600" }]}>Next term begins {longDate(d.nextTermBegins)}</Text>}
      <Text style={[s.faint, { marginTop: 8 }]}>
        Prepared {longDate(d.preparedOn.slice(0, 10))}. A PDF copy can be downloaded from the website.
      </Text>
    </View>
  );
}
