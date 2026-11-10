import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

/**
 * Test support: the text a PDF made by reportCardPdf.ts prints, one string per page, in drawing order.
 *
 * pdf-lib writes standard-font text as hex strings inside Flate-compressed page streams, so this inflates every page's
 * content, reads the `<4A6F> Tj` and `(Jo) Tj` operators, and joins what one page drew with newlines (one drawText call
 * per line). WinAnsi is Latin-1 for everything the cards use, so a byte is a character.
 */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const refs = contents && "asArray" in contents ? contents.asArray() : contents ? [contents] : [];
    const chunks: string[] = [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const data = decodePDFRawStream(stream).decode();
      const ops = Buffer.from(data).toString("latin1");
      for (const m of ops.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        if (m[1] !== undefined) chunks.push(Buffer.from(m[1].replace(/\s+/g, ""), "hex").toString("latin1"));
        else chunks.push((m[2] ?? "").replace(/\\([()\\])/g, "$1"));
      }
    }
    return chunks.join("\n");
  });
}
