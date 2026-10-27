import { useState } from "react";
import { fetchDocumentSignatures, fetchMyReportCards, reportCardFileName, signatureFor, type StoredReportCard } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { useAsync } from "../lib/useAsync";

/**
 * The report cards the school has sent out for one learner, newest term
 * first, each a PDF download. Shown under Results for a parent's selected
 * child and for a learner themself. Says nothing at all until there's a card.
 */
export function ReportCardDownloads({ studentId, logoUrl }: { studentId: string; logoUrl: string | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useAsync(() => fetchMyReportCards([studentId]), [studentId]);
  if (!data?.length) return null;

  async function download(card: StoredReportCard) {
    setBusy(card.id);
    try {
      const pdf = await import("../lib/reportCardPdf");
      const sigs = await fetchDocumentSignatures("report_card", [card.id]);
      const bytes = await pdf.renderReportCardsPdf(
        [{
          data: card.data, teacherComment: card.teacherComment, principalComment: card.principalComment,
          signatures: {
            teacher: signatureFor(sigs, card.id, "class_teacher", { currentOnly: true }),
            principal: signatureFor(sigs, card.id, "principal", { currentOnly: true }),
          },
        }],
        { logo: await pdf.fetchLogo(logoUrl) },
      );
      pdf.saveFile(bytes, reportCardFileName(card.data));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not make the PDF.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white">
      <h2 className="border-b border-line px-4 py-3 text-[14px] font-semibold">Report cards</h2>
      <ul>
        {data.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">{c.data.term.name}</div>
              <div className="text-[12px] text-ink-faint">
                {c.data.learner.className}
                {c.data.summary.mean !== null && ` · mean ${c.data.summary.mean}%, ${c.data.summary.grade}`}
              </div>
            </div>
            <Button disabled={busy === c.id} onClick={() => download(c)}>{busy === c.id ? "Preparing…" : "Download PDF"}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
