import { Platform } from "react-native";
import ReactNativeBlobUtil from "react-native-blob-util";
import {
  bytesToBase64, fetchDocumentSignatures, reportCardFileName, signatureFor, type StoredReportCard,
} from "@figbloom/shared";

/**
 * A report card as a PDF file, handed to the phone's own PDF viewer: the
 * learner's family reads it there, and prints, saves or sends it from there.
 *
 * The drawing is the same code the web uses (packages/shared reportCardPdf.ts),
 * from the card as the school issued it, so what the phone makes is the file
 * the web downloads. It pulls in pdf-lib, so it is loaded only when someone
 * asks for a PDF.
 */

/** A slow or missing logo should cost the card its logo, not the whole PDF. */
const LOGO_WAIT_MS = 8000;

/** Where cards are written: the app's cache, so Android can clear it and nothing else can read it. */
const folder = () => `${ReactNativeBlobUtil.fs.dirs.CacheDir}/report-cards`;

/** The school's logo bytes, or null when there isn't one the PDF can use (no logo, SVG, offline, slow). */
async function fetchLogoBytes(url: string | null | undefined): Promise<Uint8Array | null> {
  if (!url) return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), LOGO_WAIT_MS);
  try {
    const res = await fetch(url, { signal: stop.signal });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Why the PDF could not be opened, in words for the person holding the phone. */
export function pdfErrorMessage(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "ENOAPP") return "There is no PDF viewer on this phone. Install one (Google Drive or Adobe Acrobat Reader work) and try again.";
  return "Could not make the PDF. Check your connection and try again.";
}

/** Draws the card, saves it, and opens it in a PDF viewer. Rejects when it can't; pdfErrorMessage words the reason. */
export async function openReportCardPdf(card: StoredReportCard): Promise<void> {
  // Who has signed is read now, not taken from the screen: a card that is signed must never print as unsigned.
  const [pdf, signatures, logoBytes] = await Promise.all([
    import("../../../../packages/shared/src/reportCardPdf"),
    fetchDocumentSignatures("report_card", [card.id]),
    fetchLogoBytes(card.data.school.logoUrl),
  ]);
  const bytes = await pdf.renderReportCardsPdf(
    [{
      data: card.data, teacherComment: card.teacherComment, principalComment: card.principalComment,
      signatures: {
        teacher: signatureFor(signatures, card.id, "class_teacher", { currentOnly: true }),
        principal: signatureFor(signatures, card.id, "principal", { currentOnly: true }),
      },
    }],
    { logo: logoBytes ? pdf.logoFromBytes(logoBytes) : null },
  );

  // One card at a time: whatever was made before is cleared first.
  const { fs } = ReactNativeBlobUtil;
  if (await fs.isDir(folder())) await fs.unlink(folder());
  await fs.mkdir(folder());
  const path = `${folder()}/${reportCardFileName(card.data)}`;
  await fs.writeFile(path, bytesToBase64(bytes), "base64");

  if (Platform.OS === "android") await ReactNativeBlobUtil.android.actionViewIntent(path, "application/pdf");
  else ReactNativeBlobUtil.ios.presentPreview(path);
}
