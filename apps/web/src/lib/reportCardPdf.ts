/**
 * The report-card PDF code, for loading on demand:
 *
 *   const pdf = await import("../../lib/reportCardPdf");
 *
 * It pulls in pdf-lib (a few hundred KB), so it stays out of the bundle every
 * page loads and is fetched only when someone downloads a PDF. The drawing
 * itself lives in packages/shared, where it's tested.
 */
import type { PdfLogo } from "../../../../packages/shared/src/reportCardPdf";

export { renderReportCardsPdf, renderResultsSheetPdf } from "../../../../packages/shared/src/reportCardPdf";
export type { PdfLogo, PrintableCard } from "../../../../packages/shared/src/reportCardPdf";

/** The school's logo for the PDF header, or null when there isn't one the PDF can use (SVG, WebP, unreachable). */
export async function fetchLogo(url: string | null | undefined): Promise<PdfLogo | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    const kind = type.includes("png") ? "png" : type.includes("jpeg") || type.includes("jpg") ? "jpg" : null;
    return kind ? { bytes: new Uint8Array(await res.arrayBuffer()), type: kind } : null;
  } catch {
    return null;
  }
}

/** Hands the PDF to the browser as a download. */
export function saveFile(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
