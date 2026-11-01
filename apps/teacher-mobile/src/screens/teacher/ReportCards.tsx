import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import {
  CAPACITY_LABEL, fetchClassReportCards, fetchDocumentSignatures, fetchReportCardSetup, signatureFor, signDocuments,
  type ReportCardSetup, type SignatureMark, type StoredReportCard, type StoredSignature,
} from "@figbloom/shared";
import { accentFor } from "../../theme";
import { PillPicker } from "../../components/PillPicker";
import { ReportCardBody } from "../../components/ReportCardBody";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SignSheet } from "../../components/SignSheet";
import { useMyName } from "../../lib/useMyName";
import type { TeacherSession } from "../../navigation";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

/**
 * A class teacher's report cards for a term: read each learner's card, and sign
 * the ones not yet signed as class teacher, all at once. Only the classes this
 * teacher is class teacher of are listed, as on the web's Report cards page;
 * preparing the cards, the comments and sending them to families stay there.
 * A signature counts while the card is unchanged since signing, so a card the
 * office changes afterwards comes back as unsigned.
 */
export function TeacherReportCards({ session }: { session: TeacherSession }) {
  const { t, s, accentInk } = useTheme();
  const a = accentFor(session.accent);
  const name = useMyName();
  const [setup, setSetup] = useState<ReportCardSetup | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [cards, setCards] = useState<StoredReportCard[] | null>(null);
  const [signatures, setSignatures] = useState<StoredSignature[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchReportCardSetup(session.tenantId, session.profileId)
      .then((r) => {
        if (!alive) return;
        setSetup(r);
        setTermId((cur) => cur ?? (r.terms.find((x) => x.isCurrent) ?? r.terms[0])?.id ?? null);
        setClassId((cur) => cur ?? r.classes[0]?.id ?? null);
      })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load your classes."); });
    return () => { alive = false; };
  }, [session.tenantId, session.profileId]);

  useEffect(() => {
    if (!termId || !classId) return;
    let alive = true;
    setCards(null);
    setError(null);
    setOpenId(null);
    (async () => {
      const list = await fetchClassReportCards(termId, classId);
      const sigs = await fetchDocumentSignatures("report_card", list.map((c) => c.id));
      if (alive) { setCards(list); setSignatures(sigs); }
    })().catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load the report cards."); });
    return () => { alive = false; };
  }, [termId, classId, reloadKey]);

  const mine = (c: StoredReportCard) => signatureFor(signatures, c.id, "class_teacher", { currentOnly: true });
  const unsigned = (cards ?? []).filter((c) => !mine(c));

  async function sign(mark: SignatureMark) {
    const n = await signDocuments("report_card", unsigned.map((c) => c.id), "class_teacher", mark);
    setSigning(false);
    setNote(`Signed ${n} report card${n === 1 ? "" : "s"}.`);
    setReloadKey((k) => k + 1);
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Report cards" sub="Read and sign your class's cards" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {setup && setup.classes.length > 0 && setup.terms.length > 0 && (
          <>
            <View>
              <Text style={[s.eyebrow, { marginBottom: 6 }]}>TERM</Text>
              <PillPicker items={setup.terms.map((x) => ({ id: x.id, name: x.name }))} selectedId={termId} onPick={setTermId} accent={session.accent} />
            </View>
            <View>
              <Text style={[s.eyebrow, { marginBottom: 6 }]}>CLASS</Text>
              <PillPicker items={setup.classes.map((x) => ({ id: x.id, name: x.name }))} selectedId={classId} onPick={setClassId} accent={session.accent} />
            </View>
          </>
        )}

        {!!note && <Text style={[s.small, { color: t.status.okInk }]}>{note}</Text>}

        {error ? (
          <View style={s.card}><Text style={[s.small, { color: t.status.warnInk }]}>Could not load report cards: {error}</Text></View>
        ) : !setup ? (
          <ActivityIndicator color={accentInk(a.deep)} style={{ marginTop: 32 }} />
        ) : setup.classes.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={[s.h2, { marginBottom: 4 }]}>No class of yours</Text>
            <Text style={[s.small, { textAlign: "center" }]}>
              You sign report cards as class teacher, and you are not class teacher of any class. The school office assigns that.
            </Text>
          </View>
        ) : setup.terms.length === 0 ? (
          <View style={s.card}><Text style={s.small}>The school has not set up a term yet.</Text></View>
        ) : !cards ? (
          <ActivityIndicator color={accentInk(a.deep)} style={{ marginTop: 32 }} />
        ) : cards.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={[s.h2, { marginBottom: 4 }]}>No report cards yet</Text>
            <Text style={[s.small, { textAlign: "center" }]}>None have been prepared for this class this term. They are prepared on the website.</Text>
          </View>
        ) : (
          <>
            <View style={[s.card, { gap: 10 }]}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>
                {cards.length - unsigned.length} of {cards.length} signed by you
              </Text>
              {unsigned.length > 0 && (
                <Tap accessibilityRole="button" onPress={() => { setNote(null); setSigning(true); }} style={[s.primary, { backgroundColor: a.deep }]}>
                  <Text style={s.primaryLabel}>Sign {unsigned.length} report card{unsigned.length === 1 ? "" : "s"}</Text>
                </Tap>
              )}
              <Text style={s.faint}>Open a card to read it first. Preparing the cards, writing comments and sending them to families are done on the website.</Text>
            </View>

            {cards.map((c) => {
              const open = c.id === openId;
              const sig = mine(c);
              const { mean, grade } = c.data.summary;
              const detail = [
                mean !== null ? `mean ${mean}%, ${grade}` : "no marks",
                c.publishedAt ? "sent to family" : "draft",
                c.teacherComment ? null : "no comment yet",
              ].filter(Boolean).join(" · ");
              return (
                <View key={c.id} style={[s.card, { padding: 0 }]}>
                  <Tap
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    onPress={() => setOpenId(open ? null : c.id)}
                    style={{ minHeight: 56, padding: 14, flexDirection: "row", alignItems: "center", gap: 10 }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: "600", color: t.appSurface.ink }}>{c.data.learner.name}</Text>
                      <Text numberOfLines={1} style={s.faint}>{detail}</Text>
                    </View>
                    <Text style={{ fontSize: 12.5, fontWeight: "700", color: sig ? t.status.okInk : t.appSurface.inkMuted }}>{sig ? "Signed" : "Not signed"}</Text>
                  </Tap>
                  {open && (
                    <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }}>
                      <ReportCardBody card={c} signatures={signatures} />
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>

      {signing && (
        <SignSheet
          title="Sign report cards"
          what={unsigned.length === 1 ? "this report card" : `these ${unsigned.length} report cards`}
          capacityLabel={CAPACITY_LABEL.class_teacher}
          defaultName={name}
          tint={a.deep}
          onSign={sign}
          onClose={() => setSigning(false)}
        />
      )}
    </View>
  );
}
