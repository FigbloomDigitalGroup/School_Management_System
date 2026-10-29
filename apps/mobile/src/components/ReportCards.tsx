import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { FileDown } from "lucide-react-native";
import { fetchDocumentSignatures, fetchMyReportCards, type StoredReportCard, type StoredSignature } from "@figbloom/shared";
import { openReportCardPdf, pdfErrorMessage } from "../lib/reportCardFile";
import { s, t } from "../theme";
import { ReportCardBody } from "./ReportCardBody";

/**
 * The report cards the school has sent out for one learner, newest term first,
 * each opening to the whole card: marks, comments, signatures, and the card as
 * a PDF to print, save or send. Shown under Results for a parent's selected
 * child and for a learner themself. Says nothing at all until there is a card,
 * or if they can't be loaded (offline).
 */
export function ReportCards({ studentId, tint }: { studentId: string; tint: string }) {
  const [cards, setCards] = useState<StoredReportCard[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<StoredSignature[] | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function openPdf(card: StoredReportCard) {
    setMaking(card.id);
    setPdfError(null);
    try {
      await openReportCardPdf(card);
    } catch (err) {
      setPdfError(pdfErrorMessage(err));
    } finally {
      setMaking(null);
    }
  }

  useEffect(() => {
    let alive = true;
    setCards(null);
    setOpenId(null);
    setPdfError(null);
    fetchMyReportCards([studentId])
      .then((c) => { if (alive) setCards(c); })
      .catch(() => { if (alive) setCards([]); });
    return () => { alive = false; };
  }, [studentId]);

  // Who has signed a card is read when it is opened.
  useEffect(() => {
    if (!openId) return;
    let alive = true;
    setSignatures(null);
    fetchDocumentSignatures("report_card", [openId])
      .then((r) => { if (alive) setSignatures(r); })
      .catch(() => { if (alive) setSignatures([]); });
    return () => { alive = false; };
  }, [openId]);

  if (!cards?.length) return null;

  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Report cards</Text>
      {cards.map((c) => {
        const open = c.id === openId;
        const { mean, grade } = c.data.summary;
        return (
          <View key={c.id} style={[s.card, { marginBottom: 8, padding: 0 }]}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => { setOpenId(open ? null : c.id); setPdfError(null); }}
              style={{ minHeight: 56, padding: 14, flexDirection: "row", alignItems: "center", gap: 10 }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "600", color: t.appSurface.ink }}>{c.data.term.name}</Text>
                <Text style={s.faint}>{c.data.learner.className}{mean !== null ? ` · mean ${mean}%, ${grade}` : ""}</Text>
              </View>
              <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>{open ? "Hide" : "Open"}</Text>
            </TouchableOpacity>
            {open && (
              <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Open the ${c.data.term.name} report card as a PDF`}
                  disabled={making !== null}
                  onPress={() => void openPdf(c)}
                  style={{
                    minHeight: 44, marginTop: 12, borderRadius: 11, borderWidth: 1, borderColor: tint,
                    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                    opacity: making !== null && making !== c.id ? 0.5 : 1,
                  }}
                >
                  {making === c.id ? <ActivityIndicator color={tint} /> : <FileDown color={tint} size={17} />}
                  <Text style={{ fontSize: 14, fontWeight: "600", color: tint }}>{making === c.id ? "Preparing the PDF…" : "Open as PDF"}</Text>
                </TouchableOpacity>
                {pdfError && <Text style={[s.small, { marginTop: 8, color: "#B4472B" }]}>{pdfError}</Text>}
                <ReportCardBody card={c} signatures={signatures} />
              </View>
            )}
          </View>
        );
      })}
    </>
  );
}
