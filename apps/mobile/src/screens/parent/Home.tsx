import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { PencilLine, School, TriangleAlert } from "lucide-react-native";
import { dueWords, formatMoney, formatShortDate, gradeFor, gradingSchemeFor, newestExamNote, splitHomework } from "@figbloom/shared";
import { accentFor } from "../../theme";
import { useChild, useChildren, useMessages, useParentProfileId, useTenantId, useTermLabel } from "../../data";
import { ChatsCard } from "../../components/ChatsCard";
import { ChildBioCard } from "../../components/ChildBioCard";
import { ChildHealthCard } from "../../components/ChildHealthCard";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { LiveClassBanner } from "../../calls/LiveClassBanner";
import { LinkCard } from "../../components/LinkCard";
import { PendingSignatures } from "../../components/PendingSignatures";
import { Skeleton } from "../../components/Skeleton";
import { useMedicalUnread } from "../../lib/medicalUnread";
import { useCbeResults } from "../../lib/useCbeResults";
import { useParentHomework } from "../../lib/useParentHomework";
import { Tap } from "../../ui/Tap";
import { OpenLabel } from "../../ui/OpenLabel";
import { useTheme } from "../../ui/ThemeContext";

/**
 * The screen a parent opens. Balance first, because that is what they came for;
 * an unexplained absence second, because that is what they would want to know.
 */
export function ParentHome() {
  const { t, s, accentInk } = useTheme();
  const nav = useNavigation<any>();
  const { child, index, setIndex, accent, country } = useChild();
  const kids = useChildren();
  const messages = useMessages();
  const termLabel = useTermLabel();
  const tenantId = useTenantId();
  const unreadHealth = useMedicalUnread(useParentProfileId());
  // Only needed when there is no exam mean: a CBE learner's results are strand levels, not marks.
  const cbe = useCbeResults(child.mean === null ? child.id : null, country);
  const a = accentFor(accent);
  /** First child takes the deep shade, second the accent itself. */
  const tint = index === 0 ? a.deep : a.hex;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>{child.first}</Text>
            <Text style={s.headerSub}>{child.cls} · ADM {child.adm}</Text>
          </View>
          <ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
        <View style={[s.card, { marginTop: 12 }]}>
          <Text style={s.eyebrow}>FEE BALANCE{termLabel ? ` · ${termLabel.toUpperCase()}` : ""}</Text>
          <Text style={{ fontSize: 30, fontWeight: "700", marginTop: 6, color: child.balance > 0 ? accentInk(tint) : t.status.okInk }}>
            {child.balance > 0 ? formatMoney(child.balance, country) : "Cleared"}
          </Text>
          <Text style={[s.small, { marginTop: 6 }]}>
            {child.balance > 0
              ? `Of ${formatMoney(child.billed, country)} billed. Part payment is fine — many families pay across the term.`
              : `All ${formatMoney(child.billed, country)} paid. Nothing due until the next term.`}
          </Text>
          {child.balance > 0 && (
            <Tap
              accessibilityRole="button"
              onPress={() => nav.navigate("Pay", { childId: child.id })}
              style={[s.primary, { backgroundColor: tint, marginTop: 12 }]}
            >
              <Text style={s.primaryLabel}>Pay with M-Pesa</Text>
            </Tap>
          )}
        </View>

        {/* A live class running in any child's class: Join. Nothing when there is none. */}
        <LiveClassBanner tenantId={tenantId} classIds={kids.map((k) => k.classId).filter((id): id is string => !!id)} tint={tint} />

        <PendingSignatures tint={tint} />

        <View style={[s.row, { marginTop: 16, gap: 10, alignItems: "stretch" }]}>
          {[
            child.attendance === null
              ? { label: "ATTENDANCE", value: "—", note: "No attendance recorded yet" }
              : { label: "ATTENDANCE", value: `${child.attendance}%`, note: "this term" },
            child.mean !== null
              ? { label: "MEAN GRADE", value: gradeFor(child.mean, gradingSchemeFor(country, child.classLevel)), note: `${child.mean} marks${child.examName ? `, ${child.examName}${newestExamNote(child.exams)}` : ""}` }
              : cbe.results === null && !cbe.failed
                ? { label: "MEAN GRADE", value: null, note: null } // CBE check still loading
                : cbe.results?.length
                  // CBE has no mean grade — say how many learning areas have published levels, and where to read them.
                  ? { label: "LEARNING AREAS", value: String(cbe.results.length), note: "CBE results published — see Results" }
                  : cbe.failed
                    ? { label: "MEAN GRADE", value: "—", note: "See Results" }
                    : { label: "MEAN GRADE", value: "—", note: "Not published yet" },
          ].map((k) => (
            <View key={k.label} style={[s.card, { flex: 1, padding: 14 }]}>
              <Text style={s.eyebrow}>{k.label}</Text>
              {k.value === null ? (
                <View style={{ gap: 6, marginTop: 8 }}>
                  <Skeleton width={44} height={20} />
                  <Skeleton width="70%" height={10} />
                </View>
              ) : (
                <>
                  <Text style={{ color: t.appSurface.ink, fontSize: 24, fontWeight: "600", marginTop: 4 }}>{k.value}</Text>
                  <Text style={s.faint}>{k.note}</Text>
                </>
              )}
            </View>
          ))}
        </View>

        {child.attendance !== null && child.attendance < 90 && (
          <View style={[s.banner, { marginTop: 16 }]}>
            <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center" }}>
              <TriangleAlert size={14} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.bannerText, { fontWeight: "600", fontSize: 13.5 }]}>
                {child.absentDates.length > 0
                  ? `${child.first} missed ${child.absentDates.length} day${child.absentDates.length === 1 ? "" : "s"} this term`
                  : `${child.first}'s attendance is below 90% this term`}
              </Text>
              <Text style={[s.bannerText, { marginTop: 4 }]}>
                {child.absentDates.length > 0
                  ? `${child.absentDates.slice(-2).map(formatShortDate).join(" and ")}, unexplained. If there was a reason, telling the class teacher clears it from the record.`
                  : "Mostly lateness rather than full absence. Worth a word with the class teacher if there is a reason."}
              </Text>
            </View>
          </View>
        )}

        <HomeworkCard childId={child.id} childFirst={child.first} tint={tint} onOpen={() => nav.navigate("Homework")} />

        <ChatsCard tint={tint} blurb={`Message ${child.first}'s teachers or the school office, and hear back.`} />

        <LinkCard label="Learning materials" blurb={`Notes, worksheets and videos ${child.first}'s teachers have shared with the class.`} tint={tint} to="Materials" />

        <LinkCard label="Sports & activities" blurb={`Clubs, teams, fixtures and awards for ${child.first}.`} tint={tint} to="Activities" />
        <LinkCard label="Issued items" blurb={`Textbooks and equipment ${child.first} has borrowed, and when they're due back.`} tint={tint} to="Items" />
        <LinkCard label="Health" blurb={`Sick bay visits, the medicine the school gives ${child.first}, and notes from the nurse.`} tint={tint} to="Health" badge={unreadHealth} />
        <LinkCard label="Bloom study helper" blurb={`An AI tutor ${child.first} can use for schoolwork. You turn it on or off.`} tint={tint} to="StudyHelper" />

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>From the school</Text>
        {messages.slice(0, 2).map((m) => (
          <Tap
            key={m.id}
            onPress={() => nav.navigate("Inbox", { id: m.id })}
            style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", gap: 12 }]}
          >
            <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: m.who === "school" ? tint : t.appSurface.lineSoft, alignItems: "center", justifyContent: "center" }}>
              {m.who === "school" ? <School size={18} color="#fff" /> : <PencilLine size={18} color={t.appSurface.inkMuted} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: m.unread ? "700" : "500" }}>{m.subject}</Text>
              <Text numberOfLines={2} style={[s.small, { marginTop: 4 }]}>{m.body.split("\n")[0]}</Text>
            </View>
          </Tap>
        ))}

        <ChildBioCard childId={child.id} childFirst={child.first} tint={tint} />

        <ChildHealthCard tenantId={tenantId} childId={child.id} childFirst={child.first} tint={tint} />
      </ScrollView>
    </View>
  );
}

/**
 * What's still to do for this child, and the one thing due soonest. The
 * whole list, with each teacher's note for parents, is one tap away.
 */
function HomeworkCard({ childId, childFirst, tint, onOpen }: { childId: string; childFirst: string; tint: string; onOpen: () => void }) {
  const { t, s } = useTheme();
  const { byChild, failed } = useParentHomework();
  const mine = byChild?.[childId];
  if (failed && !byChild) return null; // offline: the rest of Home still reads from cache
  const groups = splitHomework(mine?.items ?? []);
  const toDo = groups.overdue.length + groups.upcoming.length;
  const next = groups.overdue[0] ?? groups.upcoming[0];

  return (
    <Tap accessibilityRole="button" onPress={onOpen} style={[s.card, { marginTop: 16, padding: 14 }]}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={s.eyebrow}>HOMEWORK</Text>
        <OpenLabel label="See all" tint={tint} />
      </View>
      {byChild === null ? (
        <View style={{ gap: 6, marginTop: 8 }}>
          <Skeleton width="60%" height={16} />
          <Skeleton width="80%" height={10} />
        </View>
      ) : (
        <>
          <Text style={{ color: t.appSurface.ink, fontSize: 16, fontWeight: "600", marginTop: 6 }}>
            {toDo === 0 ? "Nothing to do right now" : `${toDo} piece${toDo === 1 ? "" : "s"} to do`}
          </Text>
          <Text style={[s.small, { marginTop: 4 }]} numberOfLines={2}>
            {next
              ? `${next.subject}: ${next.title}. ${dueWords(next.dueOn)}.${groups.overdue.length ? ` ${groups.overdue.length} overdue.` : ""}`
              : `New homework for ${childFirst} shows here, with a note on how you can help.`}
          </Text>
        </>
      )}
    </Tap>
  );
}
